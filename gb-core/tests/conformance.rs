//! Conformance suites: Mooneye (acceptance + emulator-only MBC), Mealybug Tearoom, SameSuite, Age,
//! gbmicrotest and rtc3test, from the pinned c-sp/game-boy-test-roms archive that
//! `scripts/fetch-test-roms.sh` unpacks into test-roms/conformance/ (gitignored, never committed).
//!
//! Every ROM of a suite runs and ends as a pass, an expected fail (listed in
//! expected-failures.txt) or a regression. A listed ROM that passes, or a listed ROM that does
//! not exist, is also red: the list can only shrink. Each test prints `| suite | passed/total |`.
//! The hardware comes from the suite's own file/directory naming, never from a ROM's title or
//! checksum. A missing suite skips, unless CARTOUCHE_REQUIRE_ROMS is set (as in CI).

use std::collections::BTreeSet;
use std::path::{Path, PathBuf};
use std::sync::atomic::{AtomicUsize, Ordering};
use std::sync::Mutex;

use gb_core::gameboy::{GameBoy, Model, CYCLES_PER_FRAME};

#[derive(Clone, Debug, PartialEq)]
enum Verdict {
    Pass,
    Fail(String),
}

#[derive(Clone, Copy, Debug, PartialEq)]
enum Hw {
    Dmg,
    Cgb,
}

#[derive(Clone, Debug)]
enum Protocol {
    /// Stops on `LD B,B`; B,C,D,E,H,L = 3,5,8,13,21,34 is a pass.
    Fibonacci,
}

/// One run of one ROM: `label` is its line in expected-failures.txt.
struct Job {
    label: String,
    rom: PathBuf,
    hw: Hw,
    protocol: Protocol,
}

fn conformance_dir() -> PathBuf {
    Path::new(env!("CARGO_MANIFEST_DIR")).join("test-roms/conformance")
}

/// DMG: post-boot state, like blargg.rs. CGB: Cartouche's CGB boot ROM runs to its end, so a
/// DMG-only cartridge starts in compatibility mode as on real hardware.
fn boot(path: &Path, hw: Hw) -> Result<GameBoy, String> {
    let rom = std::fs::read(path).map_err(|e| format!("cannot read ROM: {e}"))?;
    match hw {
        Hw::Dmg => {
            let mut gb = GameBoy::with_model(rom, Model::Dmg).map_err(|e| e.to_string())?;
            gb.skip_boot_rom();
            Ok(gb)
        }
        Hw::Cgb => {
            let mut gb = GameBoy::with_boot(rom, true, 0, 0).map_err(|e| e.to_string())?;
            gb.finish_boot().map_err(|e| e.to_string())?;
            Ok(gb)
        }
    }
}

fn at_breakpoint(gb: &GameBoy) -> bool {
    !gb.cpu.halted && gb.bus.read_byte(gb.cpu.regs.pc) == 0x40
}

fn run_rom(path: &Path, hw: Hw, protocol: &Protocol, timeout_secs: u64) -> Verdict {
    let mut gb = match boot(path, hw) {
        Ok(gb) => gb,
        Err(e) => return Verdict::Fail(e),
    };
    let limit = timeout_secs * 60 * CYCLES_PER_FRAME as u64;
    let mut cycles = 0u64;
    while cycles < limit {
        match protocol {
            Protocol::Fibonacci if at_breakpoint(&gb) => {
                let r = &gb.cpu.regs;
                let regs = [r.b, r.c, r.d, r.e, r.h, r.l];
                return if regs == [3, 5, 8, 13, 21, 34] {
                    Verdict::Pass
                } else {
                    Verdict::Fail(format!("registers {regs:?}"))
                };
            }
            _ => {}
        }
        match gb.step_instruction() {
            Ok(c) => cycles += c as u64,
            Err(e) => return Verdict::Fail(format!("emulator error: {e}")),
        }
    }
    Verdict::Fail("timeout".into())
}

/// The entries of expected-failures.txt: `#` starts a comment, blank lines are ignored.
fn parse_expected(text: &str) -> BTreeSet<String> {
    text.lines()
        .map(|l| l.split('#').next().unwrap().trim())
        .filter(|l| !l.is_empty())
        .map(str::to_string)
        .collect()
}

/// Pass or listed fail is green; an unlisted fail, a listed pass or a listed entry with no ROM
/// behind it is red. Ok((passed, total)).
fn reconcile(suite: &str, results: &[(String, Verdict)], expected: &BTreeSet<String>) -> Result<(usize, usize), String> {
    let mut errors = Vec::new();
    let mut passed = 0;
    for (label, verdict) in results {
        match (verdict, expected.contains(label)) {
            (Verdict::Pass, false) => passed += 1,
            (Verdict::Pass, true) => errors.push(format!("now passes: remove from expected-failures.txt: {label}")),
            (Verdict::Fail(_), true) => {}
            (Verdict::Fail(why), false) => errors.push(format!("regression: {label} ({why})")),
        }
    }
    let ran: BTreeSet<&str> = results.iter().map(|(l, _)| l.as_str()).collect();
    for entry in expected.iter().filter(|e| !ran.contains(e.as_str())) {
        errors.push(format!("stale entry: {entry}"));
    }
    if errors.is_empty() {
        Ok((passed, results.len()))
    } else {
        Err(format!("{suite}: {} problem(s)\n{}", errors.len(), errors.join("\n")))
    }
}

/// Every .gb/.gbc under `dir`, sorted.
fn roms(dir: &Path) -> Vec<PathBuf> {
    let mut out = Vec::new();
    let mut stack = vec![dir.to_path_buf()];
    while let Some(d) = stack.pop() {
        for entry in std::fs::read_dir(&d).unwrap_or_else(|e| panic!("{}: {e}", d.display())) {
            let p = entry.unwrap().path();
            if p.is_dir() {
                stack.push(p);
            } else if matches!(p.extension().and_then(|e| e.to_str()), Some("gb" | "gbc")) {
                out.push(p);
            }
        }
    }
    out.sort();
    out
}

/// Runs the ROMs under `root/dirs` (`pick` turns each into its jobs, given its path relative to
/// the conformance directory), in parallel, then reconciles them with expected-failures.txt.
fn run_suite(suite: &str, root: &str, dirs: &[&str], timeout_secs: u64, pick: fn(&Path, &str) -> Vec<Job>) {
    let base = conformance_dir();
    if !base.join(root).is_dir() {
        assert!(std::env::var_os("CARTOUCHE_REQUIRE_ROMS").is_none(), "{suite}: {root} not found");
        eprintln!("{suite}: skipped: run scripts/fetch-test-roms.sh");
        return;
    }
    let prefixes: Vec<String> = dirs.iter().map(|d| format!("{root}/{d}")).collect();
    let jobs: Vec<Job> = prefixes
        .iter()
        .flat_map(|p| roms(&base.join(p)))
        .flat_map(|rom| {
            let rel = rom.strip_prefix(&base).unwrap().to_string_lossy().replace('\\', "/");
            pick(&rom, &rel)
        })
        .collect();
    assert!(!jobs.is_empty(), "{suite}: no ROMs under {root}");

    // ponytail: one shared index over the jobs; std only, no work-stealing needed at this size.
    let next = AtomicUsize::new(0);
    let results = Mutex::new(Vec::new());
    let threads = std::thread::available_parallelism().map_or(4, |n| n.get());
    std::thread::scope(|s| {
        for _ in 0..threads {
            s.spawn(|| {
                while let Some(job) = jobs.get(next.fetch_add(1, Ordering::Relaxed)) {
                    let verdict = run_rom(&job.rom, job.hw, &job.protocol, timeout_secs);
                    results.lock().unwrap().push((job.label.clone(), verdict));
                }
            });
        }
    });
    let mut results = results.into_inner().unwrap();
    results.sort_by(|a, b| a.0.cmp(&b.0));

    let list = std::fs::read_to_string(Path::new(env!("CARGO_MANIFEST_DIR")).join("tests/expected-failures.txt"))
        .expect("read tests/expected-failures.txt");
    let expected: BTreeSet<String> = parse_expected(&list)
        .into_iter()
        .filter(|e| prefixes.iter().any(|p| e.starts_with(&format!("{p}/"))))
        .collect();
    match reconcile(suite, &results, &expected) {
        Ok((passed, total)) => println!("| {suite} | {passed}/{total} |"),
        Err(e) => panic!("{e}"),
    }
}

/// The part of a file stem after its last `-`, e.g. `dmgABC` in `boot_regs-dmgABC`.
fn suffix(path: &Path) -> &str {
    let stem = path.file_stem().unwrap().to_str().unwrap();
    stem.rsplit_once('-').map_or("", |(_, s)| s)
}

/// Mooneye names the models a test is for: `-cgb…`/`-C` CGB, `-A`/`-agb`/`-ags` AGB (run on its
/// closest, the CGB), everything else (`-dmg…`, `-mgb`, `-sgb…`, `-G`, `-S`, none) on the DMG.
fn mooneye(rom: &Path, rel: &str) -> Vec<Job> {
    let s = suffix(rom);
    let letters = !s.is_empty() && s.chars().all(|c| "GSCA".contains(c));
    let cgb = ["cgb", "agb", "ags"].iter().any(|p| s.starts_with(p)) || (letters && !s.contains('G') && (s.contains('C') || s.contains('A')));
    let hw = if cgb { Hw::Cgb } else { Hw::Dmg };
    vec![Job { label: rel.to_string(), rom: rom.to_path_buf(), hw, protocol: Protocol::Fibonacci }]
}

#[test]
fn mooneye_acceptance() {
    run_suite("Mooneye acceptance", "mooneye-test-suite", &["acceptance"], 30, mooneye);
}

#[test]
fn mooneye_emulator_only_mbc() {
    run_suite("Mooneye emulator-only MBC", "mooneye-test-suite", &["emulator-only/mbc1", "emulator-only/mbc2", "emulator-only/mbc5"], 30, mooneye);
}

#[test]
fn parse_expected_ignores_comments() {
    let text = "# header\n\nsuite/a.gb  # timer\n  suite/b.gb\n#suite/c.gb\n";
    let set = parse_expected(text);
    assert_eq!(set.into_iter().collect::<Vec<_>>(), ["suite/a.gb", "suite/b.gb"]);
}

#[test]
fn reconcile_states() {
    let fail = || Verdict::Fail("registers".into());
    let listed = |v: &[&str]| v.iter().map(|s| s.to_string()).collect::<BTreeSet<_>>();
    let results = vec![("s/pass.gb".to_string(), Verdict::Pass), ("s/fail.gb".to_string(), fail())];

    assert_eq!(reconcile("s", &results, &listed(&["s/fail.gb"])), Ok((1, 2)));

    let err = reconcile("s", &results, &listed(&[])).unwrap_err();
    assert!(err.contains("regression: s/fail.gb"), "{err}");

    let err = reconcile("s", &results, &listed(&["s/fail.gb", "s/pass.gb"])).unwrap_err();
    assert!(err.contains("now passes: remove from expected-failures.txt: s/pass.gb"), "{err}");

    let err = reconcile("s", &results, &listed(&["s/fail.gb", "s/gone.gb"])).unwrap_err();
    assert!(err.contains("stale entry: s/gone.gb"), "{err}");
}
