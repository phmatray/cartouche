//! Conformance suites: Mooneye (acceptance + emulator-only MBC), Mealybug Tearoom, SameSuite, Age,
//! gbmicrotest, rtc3test and Gambatte's hwtests (DMG and CGB rows), from the pinned
//! c-sp/game-boy-test-roms archive that `scripts/fetch-test-roms.sh` unpacks into
//! test-roms/conformance/ (gitignored, never committed).
//!
//! Every ROM of a suite runs and ends as a pass, an expected fail (listed in
//! expected-failures.txt) or a regression. A listed ROM that passes, or a listed ROM that does
//! not exist, is also red: the list can only shrink. Each test prints `| suite | passed/total |`.
//! The hardware comes from the suite's own file/directory naming, never from a ROM's title or
//! checksum. A missing suite skips, unless CARTOUCHE_REQUIRE_ROMS is set (as in CI).

mod common;

use std::collections::BTreeSet;
use std::path::{Path, PathBuf};
use std::sync::atomic::{AtomicUsize, Ordering};
use std::sync::{LazyLock, Mutex};

use common::{cgb_to_rgb, dmg_to_grey, load_png_rgb};
use gb_core::gameboy::{GameBoy, Model, Revision, CYCLES_PER_FRAME};
use gb_core::interrupts::JOYPAD_BIT;
use gb_core::joypad::JoypadButton;
use gb_core::trace::line;

#[derive(Clone, Debug, PartialEq)]
enum Verdict {
    Pass,
    Fail(String),
    /// A screenshot fail whose every differing pixel lies in tile 25's footprint (see
    /// `tile25_footprint`): the only verdict a rule-blocked entry may have.
    FailTile25(String),
}

#[derive(Clone, Copy, Debug, PartialEq)]
enum Hw {
    Dmg,
    Cgb,
    /// Game Boy Pocket, Super Game Boy, Super Game Boy 2: a DMG with their own post-boot state.
    Mgb,
    Sgb,
    Sgb2,
}

#[derive(Clone, Debug)]
enum Protocol {
    /// Stops on `LD B,B`; B,C,D,E,H,L = 3,5,8,13,21,34 is a pass.
    Fibonacci,
    /// gbmicrotest: $FF82 becomes $01 (pass) or $FF (fail).
    Hram,
    /// A gbmicrotest probe (no $FF82 verdict) whose source records the hardware value: each
    /// (address, byte) must hold when the run's budget ends.
    Probe { checks: &'static [(u16, u8)] },
    /// A gbmicrotest probe whose source records no value (probes-without-verdict.txt): passes when
    /// it runs its whole budget without an emulator error.
    Runs,
    /// Stops on `LD B,B`; the frame must match the reference PNG pixel for pixel.
    Screenshot(PathBuf),
    /// rtc3test: presses `presses` in the menu, runs `secs` emulated seconds, then compares the
    /// next complete frame with `reference`.
    Scripted { presses: &'static [JoypadButton], secs: u64, reference: PathBuf },
    /// A Gambatte hwtest (`gambatte`): 15 frames, then its check.
    Gambatte(Check),
}

/// What a Gambatte hwtest's name promises (`gambatte`).
#[derive(Clone, Debug, PartialEq)]
enum Check {
    /// `_out<hex>`: the shown frame's top-left cells display these digits (`hex_verdict`).
    Hex(String),
    /// `_outaudio1` / `_outaudio0`: the last frame makes sound, or stays silent (`audio_verdict`).
    Audio(bool),
    /// A sibling screenshot: the shown frame, pixel for pixel, in Gambatte's colours.
    Screen(PathBuf),
    /// No result in its name (the `*_dumper` ROMs...): listed in probes-without-verdict.txt.
    Runs,
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

/// DMG family: post-boot state, like blargg.rs. CGB: Cartouche's CGB boot ROM runs to its end, so a
/// DMG-only cartridge starts in compatibility mode as on real hardware.
fn boot(path: &Path, hw: Hw, rev: Revision) -> Result<GameBoy, String> {
    let rom = std::fs::read(path).map_err(|e| format!("cannot read ROM: {e}"))?;
    let model = match hw {
        Hw::Mgb => Model::Mgb,
        Hw::Sgb => Model::Sgb,
        Hw::Sgb2 => Model::Sgb2,
        _ => Model::Dmg,
    };
    match hw {
        Hw::Dmg | Hw::Mgb | Hw::Sgb | Hw::Sgb2 => {
            let mut gb = GameBoy::with_model(rom, model).map_err(|e| e.to_string())?;
            gb.set_revision(rev);
            gb.skip_boot_rom();
            Ok(gb)
        }
        Hw::Cgb => {
            let mut gb = GameBoy::with_boot_revision(rom, true, 0, 0, rev).map_err(|e| e.to_string())?;
            gb.finish_boot().map_err(|e| e.to_string())?;
            Ok(gb)
        }
    }
}

/// The revision a suite's file name asks for (never its contents): Mooneye/SameSuite `-dmg0`,
/// `-cgbB`, `-A`..., Age `-cgbE`/`-ncmBC`... (its CGB token wins, as `age_hw` runs it on the CGB),
/// Mealybug `_cgb_c`/`_cgb_d` references. A suffix naming several revisions keeps `Default`, the
/// one the core already matches; `cgb0B`-style SameSuite ones take the first they name.
fn revision(path: &Path) -> Revision {
    let s = stem(path);
    if s.ends_with("_cgb_c") {
        return Revision::CgbC;
    }
    if s.ends_with("_cgb_d") {
        return Revision::CgbD;
    }
    let tokens: Vec<&str> = s.split('-').skip(1).collect();
    let token = tokens.iter().find(|t| t.starts_with("cgb") || t.starts_with("ncm")).or(tokens.last());
    match token.copied().unwrap_or("") {
        "dmg0" => Revision::Dmg0,
        "G" | "GS" | "dmgC" => Revision::DmgAbc,
        t if t.starts_with("dmgABC") => Revision::DmgAbc,
        "A" | "agb" | "ags" => Revision::Agb,
        "cgb0" | "cgb0B" | "cgb0BC" => Revision::Cgb0,
        "cgbB" => Revision::CgbB,
        "cgbC" | "cgbBC" | "ncmBC" => Revision::CgbC,
        "cgbE" | "ncmE" => Revision::CgbE,
        _ => Revision::Default,
    }
}

fn at_breakpoint(gb: &GameBoy) -> bool {
    !gb.cpu.halted && gb.bus.read_byte(gb.cpu.regs.pc) == 0x40
}

fn hram_verdict(byte: u8) -> Option<Verdict> {
    match byte {
        0x00 => None,
        0x01 => Some(Verdict::Pass),
        b => Some(Verdict::Fail(format!("$FF82 = ${b:02X}"))),
    }
}

/// VRAM is read directly, so a probe's result is seen whatever mode the PPU is in.
fn probe_byte(gb: &GameBoy, addr: u16) -> u8 {
    match addr {
        0x8000..=0x9FFF => gb.bus.ppu.vram[(addr - 0x8000) as usize],
        _ => gb.bus.read_byte(addr),
    }
}

fn probe_verdict(gb: &GameBoy, checks: &[(u16, u8)]) -> Verdict {
    let wrong: Vec<String> = checks
        .iter()
        .filter(|&&(addr, want)| probe_byte(gb, addr) != want)
        .map(|&(addr, want)| format!("${addr:04X} = ${:02X}, source records ${want:02X}", probe_byte(gb, addr)))
        .collect();
    if wrong.is_empty() {
        Verdict::Pass
    } else {
        Verdict::Fail(wrong.join(", "))
    }
}

/// The frame being drawn against the reference, in the suites' colours: the four DMG greys, or
/// CGB RGB555 expanded with (x<<3)|(x>>2), as acid2.rs compares.
fn compare_screen(gb: &GameBoy, hw: Hw, reference: &Path) -> Verdict {
    let to_rgb = if hw == Hw::Dmg { dmg_to_grey } else { cgb_to_rgb };
    compare_frame(gb, &gb.bus.ppu.framebuffer, to_rgb, reference)
}

fn compare_frame(gb: &GameBoy, frame: &[u8], to_rgb: fn(&[u8]) -> [u8; 3], reference: &Path) -> Verdict {
    let actual: Vec<[u8; 3]> = frame.chunks(4).map(to_rgb).collect();
    let expected = load_png_rgb(reference);
    if expected.len() != actual.len() {
        return Verdict::Fail(format!("reference is {} pixels, frame {}", expected.len(), actual.len()));
    }
    let differ: Vec<bool> = actual.iter().zip(&expected).map(|(a, e)| a != e).collect();
    match differ.iter().filter(|&&d| d).count() {
        0 => Verdict::Pass,
        diff => match differ.iter().zip(tile25_footprint(gb)).filter(|&(&d, inside)| d && !inside).count() {
            0 => Verdict::FailTile25(format!("{diff} pixels differ, all inside tile-25 footprints")),
            outside => Verdict::Fail(format!("{diff} pixels differ; {outside} px outside tile-25 footprints")),
        },
    }
}

/// The screen pixels (160x144, row-major) drawn from tile 25 ($8190): where the Nintendo boot ROM
/// leaves its ® and Cartouche's boot ROMs leave nothing. OBJs whose tile at that row is 25 (the
/// 8x16 half included) and BG/window pixels fetched from tile 25 with LCDC.4 set (outside CGB mode,
/// also those a CGB TILE_SEL write fed a tile-25 OBJ row, traced as tile 25 from $8000): a structural
/// footprint from OAM, the layer trace's per-pixel tile record and per-line registers of the shown
/// frame (in CGB mode, or untraced, the tile maps with each line's SCX, SCY and window position),
/// never the glyph's bytes. It never turns a fail into a pass: it only tells a ®-only fail from one
/// with a real gap.
fn tile25_footprint(gb: &GameBoy) -> Vec<bool> {
    let p = &gb.bus.ppu;
    let traced = p.trace.as_deref().map(|t| &t.done);
    let mut fp = vec![false; 160 * 144];
    for y in 0..144 {
        let [lcdc, scx, scy, win_line, win_x] = match traced {
            Some(t) if t.rendered(y) => [line::LCDC, line::SCX, line::SCY, line::WIN_LINE, line::WIN_X].map(|i| t.line(y)[i]),
            _ => {
                let win = p.lcdc & 0x20 != 0 && y >= p.wy as usize && p.wx < 167;
                [p.lcdc, p.scx, p.scy, if win { (y - p.wy as usize) as u8 } else { 0xFF }, p.wx.saturating_sub(7)]
            }
        };
        let height = if lcdc & 0x04 != 0 { 16 } else { 8 };
        for o in p.oam.chunks(4) {
            let row = y as i32 + 16 - o[0] as i32;
            if !(0..height).contains(&row) {
                continue;
            }
            let row = if o[3] & 0x40 != 0 { height - 1 - row } else { row };
            let tile = if height == 16 { (o[2] & 0xFE) | (row >= 8) as u8 } else { o[2] };
            // In CGB mode, attribute bit 3 takes the tile from VRAM bank 1, where no boot ROM writes.
            if tile == 25 && !(p.cgb_mode && o[3] & 0x08 != 0) {
                for x in (o[1] as usize).saturating_sub(8)..(o[1] as usize).min(160) {
                    fp[y * 160 + x] = true;
                }
            }
        }
        let map = |bit: u8, cx: usize, cy: usize| {
            let at = if lcdc & bit != 0 { 0x1C00 } else { 0x1800 } + cy / 8 % 32 * 32 + cx / 8 % 32;
            p.vram[at] == 25 && !(p.cgb_mode && p.vram[0x2000 + at] & 0x08 != 0)
        };
        // Traced outside CGB mode: the tile each pixel was fetched with, wherever a mid-line write
        // moved it. (In CGB mode the trace has no VRAM bank, so the per-line map lookup stays.)
        if let Some(t) = traced.filter(|t| t.rendered(y) && !p.cgb_mode) {
            // Tile 25 read from $8000-$8FFF (`ids` bit 3), whatever LCDC.4 was at the line start.
            for x in 0..160 {
                fp[y * 160 + x] |= t.tile[y * 160 + x] == 25 && t.info[(y * 160 + x) * 4 + 2] & 0x08 != 0;
            }
            continue;
        }
        if lcdc & 0x10 == 0 {
            continue;
        }
        for x in 0..160 {
            fp[y * 160 + x] |= if win_line != 0xFF && x >= win_x as usize {
                map(0x40, x - win_x as usize, win_line as usize)
            } else {
                map(0x08, x + scx as usize, y + scy as usize)
            };
        }
    }
    fp
}

fn frames(gb: &mut GameBoy, n: u64) -> Result<(), String> {
    (0..n).try_for_each(|_| gb.run_frame()).map_err(|e| e.to_string())
}

/// Presses and releases `button`, each held 5 frames so the menu's input polling sees it.
fn press(gb: &mut GameBoy, button: JoypadButton) -> Result<(), String> {
    for down in [true, false] {
        if gb.bus.joypad.set_button(button, down) {
            gb.bus.interrupts.request(JOYPAD_BIT);
        }
        frames(gb, 5)?;
    }
    Ok(())
}

fn run_scripted(gb: &mut GameBoy, hw: Hw, presses: &[JoypadButton], secs: u64, reference: &Path) -> Result<Verdict, String> {
    frames(gb, 60)?; // the menu is up after a second
    for &b in presses {
        press(gb, b)?;
    }
    frames(gb, secs * 60)?;
    gb.run_to_vblank().map_err(|e| e.to_string())?;
    Ok(compare_screen(gb, hw, reference))
}

fn run_rom(path: &Path, hw: Hw, protocol: &Protocol, timeout_secs: u64) -> Verdict {
    if let Protocol::Gambatte(check) = protocol {
        return run_gambatte(path, hw, check).unwrap_or_else(|e| Verdict::Fail(format!("emulator error: {e}")));
    }
    // A screenshot names its revision in the reference (Age devices, Mealybug `_cgb_c`).
    let rev = revision(match protocol {
        Protocol::Screenshot(png) => png,
        _ => path,
    });
    match boot(path, hw, rev) {
        Ok(gb) => run(gb, hw, protocol, timeout_secs),
        Err(e) => Verdict::Fail(e),
    }
}

fn run(mut gb: GameBoy, hw: Hw, protocol: &Protocol, timeout_secs: u64) -> Verdict {
    // The layer trace gives `tile25_footprint` each line's registers.
    gb.bus.ppu.set_tracing(matches!(protocol, Protocol::Screenshot(_)));
    if let Protocol::Scripted { presses, secs, reference } = protocol {
        return run_scripted(&mut gb, hw, presses, *secs, reference).unwrap_or_else(|e| Verdict::Fail(format!("emulator error: {e}")));
    }
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
            Protocol::Screenshot(reference) if at_breakpoint(&gb) => return compare_screen(&gb, hw, reference),
            Protocol::Hram => {
                if let Some(v) = hram_verdict(gb.bus.hram[0x02]) {
                    return v;
                }
            }
            _ => {}
        }
        match gb.step_instruction() {
            Ok(c) => cycles += c as u64,
            Err(e) => return Verdict::Fail(format!("emulator error: {e}")),
        }
    }
    match protocol {
        Protocol::Probe { checks } => probe_verdict(&gb, checks),
        Protocol::Runs => Verdict::Pass,
        _ => Verdict::Fail("timeout".into()),
    }
}

/// The entries of expected-failures.txt or probes-without-verdict.txt: `#` starts a comment, blank
/// lines are ignored.
fn parse_expected(text: &str) -> BTreeSet<String> {
    text.lines()
        .map(|l| l.split('#').next().unwrap().trim())
        .filter(|l| !l.is_empty())
        .map(str::to_string)
        .collect()
}

/// The entries of expected-failures.txt whose area is `rule-blocked`.
fn parse_rule_blocked(text: &str) -> BTreeSet<String> {
    text.lines()
        .filter_map(|l| l.split_once('#'))
        .filter(|(entry, area)| !entry.trim().is_empty() && area.trim_start().starts_with("rule-blocked"))
        .map(|(entry, _)| entry.trim().to_string())
        .collect()
}

/// Pass or listed fail is green; an unlisted fail, a listed pass or a listed entry with no ROM
/// behind it is red. A ROM in `no_verdict` only has to run (Protocol::Runs) and never counts as a
/// pass: it may not also be in `expected`. A `rule_blocked` entry (a subset of `expected`) must
/// fail inside tile 25's footprint alone, and a listed fail that does must be rule-blocked.
/// Ok((passed, total, ran without a verdict, rule-blocked)).
fn reconcile(
    suite: &str,
    results: &[(String, Verdict)],
    expected: &BTreeSet<String>,
    no_verdict: &BTreeSet<String>,
    rule_blocked: &BTreeSet<String>,
) -> Result<(usize, usize, usize, usize), String> {
    let mut errors = Vec::new();
    let mut passed = 0;
    let mut runs = 0;
    let mut blocked = 0;
    for (label, verdict) in results {
        if no_verdict.contains(label) {
            match verdict {
                _ if expected.contains(label) => errors.push(format!("in both expected-failures.txt and probes-without-verdict.txt: {label}")),
                Verdict::Pass => runs += 1,
                Verdict::Fail(why) | Verdict::FailTile25(why) => errors.push(format!("probe without a verdict failed to run: {label} ({why})")),
            }
            continue;
        }
        match (verdict, expected.contains(label), rule_blocked.contains(label)) {
            (Verdict::Pass, false, _) => passed += 1,
            (Verdict::Pass, true, _) => errors.push(format!("now passes: remove from expected-failures.txt: {label}")),
            (Verdict::FailTile25(_), true, true) => blocked += 1,
            (Verdict::Fail(_), true, false) => {}
            (Verdict::Fail(why), true, true) => errors.push(format!("rule-blocked but not ®-only: {label} ({why})")),
            (Verdict::FailTile25(why), true, false) => errors.push(format!("®-only now: move to the rule-blocked section: {label} ({why})")),
            (Verdict::Fail(why) | Verdict::FailTile25(why), false, _) => errors.push(format!("regression: {label} ({why})")),
        }
    }
    let ran: BTreeSet<&str> = results.iter().map(|(l, _)| l.as_str()).collect();
    for entry in expected.union(no_verdict).filter(|e| !ran.contains(e.as_str())) {
        errors.push(format!("stale entry: {entry}"));
    }
    if errors.is_empty() {
        Ok((passed, results.len() - runs, runs, blocked))
    } else {
        Err(format!("{suite}: {} problem(s)\n{}", errors.len(), errors.join("\n")))
    }
}

/// A record file in tests/.
fn record(name: &str) -> String {
    std::fs::read_to_string(Path::new(env!("CARGO_MANIFEST_DIR")).join("tests").join(name)).unwrap_or_else(|e| panic!("read tests/{name}: {e}"))
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
    run_suite_where(suite, root, dirs, timeout_secs, pick, |_| true);
}

/// `run_suite` for the runs, and the list entries, whose label `keep` accepts: one row per model.
fn run_suite_where(suite: &str, root: &str, dirs: &[&str], timeout_secs: u64, pick: fn(&Path, &str) -> Vec<Job>, keep: fn(&str) -> bool) {
    let base = conformance_dir();
    if !base.join(root).is_dir() {
        assert!(std::env::var_os("CARTOUCHE_REQUIRE_ROMS").is_none(), "{suite}: {root} not found");
        eprintln!("{suite}: skipped: run scripts/fetch-test-roms.sh");
        return;
    }
    let prefixes: Vec<String> = dirs.iter().map(|d| format!("{root}/{d}").trim_end_matches('/').to_string()).collect();
    let jobs: Vec<Job> = prefixes
        .iter()
        .flat_map(|p| roms(&base.join(p)))
        .flat_map(|rom| {
            let rel = rom.strip_prefix(&base).unwrap().to_string_lossy().replace('\\', "/");
            pick(&rom, &rel)
        })
        .filter(|job| keep(&job.label))
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

    let in_suite = |set: BTreeSet<String>| -> BTreeSet<String> {
        set.into_iter().filter(|e| keep(e) && prefixes.iter().any(|p| e.starts_with(&format!("{p}/")))).collect()
    };
    let failures = record("expected-failures.txt");
    let expected = in_suite(parse_expected(&failures));
    let rule_blocked = in_suite(parse_rule_blocked(&failures));
    let no_verdict = in_suite(parse_expected(&record("probes-without-verdict.txt")));
    match reconcile(suite, &results, &expected, &no_verdict, &rule_blocked) {
        Ok((passed, total, runs, blocked)) => {
            let mut row = format!("| {suite} | {passed}/{total} |");
            if runs > 0 {
                row += &format!(" + {runs} probes without a verdict ran |");
            }
            if blocked > 0 {
                row += &format!(" {blocked} rule-blocked |");
            }
            println!("{row}");
        }
        Err(e) => panic!("{e}"),
    }
}

fn stem(path: &Path) -> &str {
    path.file_stem().unwrap().to_str().unwrap()
}

/// The part of a file stem after its last `-`, e.g. `dmgABC` in `boot_regs-dmgABC`.
fn suffix(path: &Path) -> &str {
    stem(path).rsplit_once('-').map_or("", |(_, s)| s)
}

/// Mooneye names the models a test is for: `-cgb…`/`-C` CGB, `-A`/`-agb`/`-ags` AGB (run on its
/// closest, the CGB), `-mgb` the Pocket, `-sgb`/`-S` the Super Game Boy, `-sgb2` the SGB2,
/// everything else (`-dmg…` even when it lists `mgb` too, `-G`, `-GS`, none) on the DMG.
fn mooneye(rom: &Path, rel: &str) -> Vec<Job> {
    let s = suffix(rom);
    let letters = !s.is_empty() && s.chars().all(|c| "GSCA".contains(c));
    let cgb = ["cgb", "agb", "ags"].iter().any(|p| s.starts_with(p)) || (letters && !s.contains('G') && (s.contains('C') || s.contains('A')));
    let hw = match s {
        _ if cgb => Hw::Cgb,
        "mgb" => Hw::Mgb,
        "sgb" | "S" => Hw::Sgb,
        "sgb2" => Hw::Sgb2,
        _ => Hw::Dmg,
    };
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

/// SameSuite targets the CGB, except its sgb/ directory, written for the Super Game Boy.
fn samesuite(rom: &Path, rel: &str) -> Vec<Job> {
    let hw = if rel.starts_with("same-suite/sgb/") { Hw::Sgb } else { Hw::Cgb };
    vec![Job { label: rel.to_string(), rom: rom.to_path_buf(), hw, protocol: Protocol::Fibonacci }]
}

/// Age names its devices in `-`-separated tokens: `dmgC`, `cgbBCE`, `ncmBCE` (a CGB running the
/// cartridge in non-CGB mode). Run on the CGB when one is named, else on the DMG.
fn age_hw(tokens: &str) -> Option<Hw> {
    let devices: Vec<&str> = tokens.split('-').filter(|t| ["dmg", "cgb", "ncm"].iter().any(|p| t.starts_with(p))).collect();
    if devices.iter().any(|t| t.starts_with("cgb") || t.starts_with("ncm")) {
        Some(Hw::Cgb)
    } else if devices.is_empty() {
        None
    } else {
        Some(Hw::Dmg)
    }
}

fn age(rom: &Path, rel: &str) -> Vec<Job> {
    let Some(hw) = age_hw(stem(rom)) else {
        return age_screenshots(rom, rel);
    };
    vec![Job { label: rel.to_string(), rom: rom.to_path_buf(), hw, protocol: Protocol::Fibonacci }]
}

/// An Age ROM that names no device is a screenshot test: `<stem>-<devices>.png` beside it, one
/// per device set, each run on its hardware.
fn age_screenshots(rom: &Path, rel: &str) -> Vec<Job> {
    let prefix = format!("{}-", stem(rom));
    let mut pngs: Vec<PathBuf> = std::fs::read_dir(rom.parent().unwrap())
        .unwrap()
        .map(|e| e.unwrap().path())
        .filter(|p| p.extension().is_some_and(|e| e == "png"))
        .filter(|p| stem(p).strip_prefix(&prefix).is_some_and(|devices| !devices.contains('-')))
        .collect();
    pngs.sort();
    pngs.into_iter()
        .filter_map(|png| {
            let devices = stem(&png)[prefix.len()..].to_string();
            let hw = age_hw(&devices)?;
            Some(Job { label: format!("{rel}@{devices}"), rom: rom.to_path_buf(), hw, protocol: Protocol::Screenshot(png) })
        })
        .collect()
}

#[test]
fn samesuite_all() {
    run_suite("SameSuite", "same-suite", &[""], 30, samesuite);
}

#[test]
fn age_all() {
    run_suite("Age", "age-test-roms", &[""], 30, age);
}

/// gbmicrotest probes that write no $FF82 verdict but whose source (aappleby/gbmicrotest
/// tests/<stem>.s, commit 463eb6b, built with -DDMG) records what the hardware leaves behind. Each
/// probe loops storing its result to $8000; "dots" in a source table is that pattern, $55, and
/// "black" is $FF (tile 0's low bitplane read through the boot BGP $FC).
const PROBE_ORACLES: &[(&str, &[(u16, u8)])] = &[
    // l.15 "69 - black" with l.32 DELAY 69: OAM reads $FF while locked
    ("000-oam_lock", &[(0x8000, 0xFF)]),
    // l.3 "We should be able to write our dotted line pattern to vram on startup."
    ("000-write_to_x8000", &[(0x8000, 0x55)]),
    // l.5 "3  - dots" with l.8 DELAY 3
    ("001-vram_unlocked", &[(0x8000, 0x55)]),
    // l.19 "71 - stat 10000100 - hblank line 0 starts here" with l.81 DELAY 71 (DMG)
    ("002-vram_locked", &[(0x8000, 0x84)]),
    // l.10 PASS 10 (DMG), l.31 `add $55 - PASS`: the four TIMA reads sum to 10, leaving $55
    ("004-tima_boot_phase", &[(0x8000, 0x55)]),
    // l.3-4 "correct - 54 - black" with l.11 DELAY 54: OAM still locked, reads $FF
    ("mode2_stat_int_to_oam_unlock", &[(0x8000, 0xFF)]),
    // l.4 "NR10 FF10 0b10000000" (read mask): $00 written to NR10 reads back $80
    ("poweron", &[(0x8000, 0x80)]),
];

static NO_VERDICT: LazyLock<BTreeSet<String>> = LazyLock::new(|| parse_expected(&record("probes-without-verdict.txt")));

/// gbmicrotest runs on the DMG it was checked on (DMG-CPU B/C).
fn gbmicrotest(rom: &Path, rel: &str) -> Vec<Job> {
    let protocol = match PROBE_ORACLES.iter().find(|(s, _)| *s == stem(rom)) {
        Some(&(_, checks)) => Protocol::Probe { checks },
        None if NO_VERDICT.contains(rel) => Protocol::Runs,
        None => Protocol::Hram,
    };
    vec![Job { label: rel.to_string(), rom: rom.to_path_buf(), hw: Hw::Dmg, protocol }]
}

#[test]
fn gbmicrotest_all() {
    run_suite("gbmicrotest", "gbmicrotest", &[""], 30, gbmicrotest);
}

#[test]
fn hram_verdict_decoding() {
    assert_eq!(hram_verdict(0x00), None);
    assert_eq!(hram_verdict(0x01), Some(Verdict::Pass));
    assert!(matches!(hram_verdict(0xFF), Some(Verdict::Fail(_))));
}

/// A 32 KB DMG cartridge running `code` from $0100, past its boot ROM.
fn synthetic(code: &[u8]) -> GameBoy {
    let mut rom = vec![0; 0x8000];
    rom[0x100..0x100 + code.len()].copy_from_slice(code);
    rom[0x14D] = 0xE7; // header checksum of an all-zero header
    let mut gb = GameBoy::new(rom).unwrap();
    gb.skip_boot_rom();
    gb
}

/// An invalid opcode locks the CPU like hardware, and the machine runs on: not an emulator error.
#[test]
fn runs_verdict_passes_a_rom_that_locks_the_cpu() {
    assert_eq!(run(synthetic(&[0x18, 0xFE]), Hw::Dmg, &Protocol::Runs, 1), Verdict::Pass); // JR -2
    assert_eq!(run(synthetic(&[0xD3]), Hw::Dmg, &Protocol::Runs, 1), Verdict::Pass); // an invalid opcode
}

/// A probe with an oracle would otherwise run under Probe yet be counted as a probe without one.
#[test]
fn probes_with_an_oracle_are_not_listed_without_a_verdict() {
    for (stem, _) in PROBE_ORACLES {
        assert!(!NO_VERDICT.contains(&format!("gbmicrotest/{stem}.gb")), "{stem} has an oracle: remove it from probes-without-verdict.txt");
    }
}

#[test]
fn probe_verdict_compares_bytes() {
    let mut gb = synthetic(&[]);
    gb.bus.ppu.vram[0] = 0x55;
    assert_eq!(probe_verdict(&gb, &[(0x8000, 0x55)]), Verdict::Pass);
    assert!(matches!(probe_verdict(&gb, &[(0x8000, 0x55), (0x8001, 0x01)]), Verdict::Fail(_)));
}

/// Mealybug Tearoom ships one expected screenshot per model next to each ROM. The DMG one
/// (`_dmg_blob`) runs on the DMG, the CGB one (`_cgb_d`, else `_cgb_c`) on the CGB; a ROM without
/// one for a model does not run on it.
fn mealybug(rom: &Path, rel: &str) -> Vec<Job> {
    let refs = [(Hw::Dmg, "dmg", &["dmg_blob"][..]), (Hw::Cgb, "cgb", &["cgb_d", "cgb_c"][..])];
    refs.iter()
        .filter_map(|(hw, tag, names)| {
            let png = names.iter().map(|n| rom.with_file_name(format!("{}_{n}.png", stem(rom)))).find(|p| p.is_file())?;
            Some(Job { label: format!("{rel}@{tag}"), rom: rom.to_path_buf(), hw: *hw, protocol: Protocol::Screenshot(png) })
        })
        .collect()
}

/// rtc3test: pick a sub-test in its menu, let it run for the time its README gives, compare with
/// the expected screenshot for the model (`-dmg`, `-cgb`).
fn rtc3test(rom: &Path, rel: &str) -> Vec<Job> {
    use JoypadButton::{Down, A};
    let subtests: [(&str, &'static [JoypadButton], u64); 3] =
        [("basic-tests", &[A], 13), ("range-tests", &[Down, A], 8), ("sub-second-writes", &[Down, Down, A], 26)];
    let mut jobs = Vec::new();
    for (name, presses, secs) in subtests {
        for (hw, tag) in [(Hw::Dmg, "dmg"), (Hw::Cgb, "cgb")] {
            let reference = rom.with_file_name(format!("rtc3test-{name}-{tag}.png"));
            let protocol = Protocol::Scripted { presses, secs, reference };
            jobs.push(Job { label: format!("{rel}@{name}-{tag}"), rom: rom.to_path_buf(), hw, protocol });
        }
    }
    jobs
}

#[test]
fn mealybug_tearoom() {
    run_suite("Mealybug Tearoom", "mealybug-tearoom-tests", &[""], 30, mealybug);
}

#[test]
fn rtc3test_all() {
    run_suite("rtc3test", "rtc3test", &[""], 30, rtc3test);
}

/// Gambatte's hwtests (pokemon-speedrunning/gambatte-core test/hwtests, prebuilt in the archive):
/// models and results are in the name, read as its test runner reads them (c-sp's howto, MIT).
/// `dmg08_cgb04c_out<r>` runs on both, `dmg08_out<r>` on the DMG (and `cgb04c_out<r>` then on the
/// CGB), any other `_out<r>` on the CGB alone; `<r>` is `audio0`/`audio1` or hex digits. A sibling
/// `<stem>_dmg08_cgb04c.png` (both), `_dmg08.png` or `_cgb04c.png` is a screenshot. `dmg08` is a
/// DMG-CPU B/C board (`Revision::Default`), `cgb04c` a CPU CGB C. `_xout`/`_x<model>` results were
/// not checked on hardware and do not run; a ROM with no result at all only has to run (on the
/// CGB when it is a .gbc) and must be in probes-without-verdict.txt.
fn gambatte(rom: &Path, rel: &str) -> Vec<Job> {
    let s = stem(rom);
    let job = |hw, check| {
        let label = format!("{rel}@{}", if hw == Hw::Dmg { "dmg" } else { "cgb" });
        Job { label, rom: rom.to_path_buf(), hw, protocol: Protocol::Gambatte(check) }
    };
    let (dmg, cgb) = if s.contains("dmg08_cgb04c_out") {
        (Some("dmg08_cgb04c_out"), Some("dmg08_cgb04c_out"))
    } else if s.contains("dmg08_out") {
        (Some("dmg08_out"), s.contains("cgb04c_out").then_some("cgb04c_out"))
    } else {
        (None, s.contains("_out").then_some("_out"))
    };
    let png = |models: &str| Some(rom.with_file_name(format!("{s}_{models}.png"))).filter(|p| p.is_file());
    let shots = match png("dmg08_cgb04c") {
        Some(p) => [Some(p.clone()), Some(p)],
        None => [png("dmg08"), png("cgb04c")],
    };
    let mut jobs = Vec::new();
    for ((hw, token), shot) in [(Hw::Dmg, dmg), (Hw::Cgb, cgb)].into_iter().zip(shots) {
        if let Some(t) = token {
            let result = &s[s.find(t).unwrap() + t.len()..];
            jobs.push(job(
                hw,
                match result {
                    r if r.starts_with("audio0") => Check::Audio(false),
                    r if r.starts_with("audio1") => Check::Audio(true),
                    r => Check::Hex(r.chars().take_while(char::is_ascii_hexdigit).collect()),
                },
            ));
        }
        if let Some(png) = shot {
            jobs.push(job(hw, Check::Screen(png)));
        }
    }
    if jobs.is_empty() {
        let hw = if rom.extension().is_some_and(|e| e == "gbc") { Hw::Cgb } else { Hw::Dmg };
        let probe = job(hw, Check::Runs);
        assert!(NO_VERDICT.contains(&probe.label), "{}: no result in its name: list it in probes-without-verdict.txt", probe.label);
        jobs.push(probe);
    }
    jobs
}

/// Gambatte's runner: 15 frames from the post-boot state, then the check, on the last complete
/// frame (`front`) or on the last frame's sound.
fn run_gambatte(path: &Path, hw: Hw, check: &Check) -> Result<Verdict, String> {
    let rev = if hw == Hw::Cgb { Revision::CgbC } else { Revision::Default };
    let mut gb = match boot(path, hw, rev) {
        Ok(gb) => gb,
        Err(e) => return Ok(Verdict::Fail(e)),
    };
    // The layer trace gives `tile25_footprint` each line's registers.
    gb.bus.ppu.set_tracing(matches!(check, Check::Screen(_)));
    frames(&mut gb, 14)?;
    gb.bus.apu.clear_samples();
    frames(&mut gb, 1)?;
    let front = &gb.bus.ppu.front;
    Ok(match check {
        Check::Hex(digits) => hex_verdict(front, &std::fs::read(path).map_err(|e| e.to_string())?, digits),
        Check::Audio(want_sound) => {
            // SAFETY: the APU's own buffer, read while `gb` is borrowed and not stepped.
            let samples = unsafe { std::slice::from_raw_parts(gb.bus.apu.buffer_ptr(), gb.bus.apu.buffer_len()) };
            audio_verdict(samples, *want_sound)
        }
        Check::Screen(png) => compare_frame(&gb, front, if hw == Hw::Dmg { dmg_to_grey } else { gambatte_cgb_to_rgb }, png),
        Check::Runs => Verdict::Pass,
    })
}

/// Where every `_out<hex>` hwtest keeps its font: it copies the glyphs (16 bytes each, 0 to F)
/// from ROM $7A00 to tile 0 and writes the result's digits as tile numbers from $9800 (hwtests
/// sources, e.g. window/late_disable_0_dmg08_cgb04c_out0.asm; the same address in all 3 079 `_out`
/// ROMs of the v7.0 archive).
const GAMBATTE_FONT: usize = 0x7A00;

/// Digit i passes when the shown frame's 8x8 cell at (8i, 0) draws that digit's glyph, read from
/// the ROM under test (never Gambatte's runner's bitmaps): one colour for each glyph colour, and
/// different colours for different ones, whatever the palette.
fn hex_verdict(frame: &[u8], rom: &[u8], digits: &str) -> Verdict {
    if digits.is_empty() {
        return Verdict::Fail("no digit in its name".into());
    }
    let glyph = |n: u32| rom.get(GAMBATTE_FONT + 16 * n as usize..).and_then(|g| g.get(..16));
    for (i, d) in digits.chars().enumerate() {
        let Some(want) = glyph(d.to_digit(16).unwrap()).filter(|_| i < 20) else {
            return Verdict::Fail(format!("no cell or glyph for digit {i} ({d})"));
        };
        if !cell_shows(frame, i, want) {
            let shown = (0..16).find(|&n| glyph(n).is_some_and(|g| cell_shows(frame, i, g)));
            let shown = shown.map_or("no digit".into(), |n| format!("{n:X}"));
            return Verdict::Fail(format!("cell {i} shows {shown}, expected {}", d.to_ascii_uppercase()));
        }
    }
    Verdict::Pass
}

fn cell_shows(frame: &[u8], i: usize, glyph: &[u8]) -> bool {
    let mut colours: [Option<&[u8]>; 4] = [None; 4];
    for y in 0..8 {
        for x in 0..8 {
            let colour = (glyph[2 * y] >> (7 - x) & 1) | (glyph[2 * y + 1] >> (7 - x) & 1) << 1;
            let px = (y * 160 + i * 8 + x) * 4;
            let px = &frame[px..px + 3];
            match colours[colour as usize] {
                Some(c) if c != px => return false,
                _ => colours[colour as usize] = Some(px),
            }
        }
    }
    let shown: Vec<&[u8]> = colours.into_iter().flatten().collect();
    (1..shown.len()).all(|j| !shown[..j].contains(&shown[j]))
}

/// Sound is a change in the level before the output capacitor. Cartouche's samples (stereo
/// pairs) come out of it (apu.rs: out = x - cap, then cap = x - out * 0.996), so a steady level
/// still decays towards 0. Undone per side: x[n] - x[0] = out[n] - out[0] + 0.004 * sum(out[..n]).
/// The smallest step a channel makes is above 0.004, float drift well under 0.001.
fn audio_verdict(samples: &[f32], want_sound: bool) -> Verdict {
    const KEPT: f64 = 0.996; // apu.rs HIGHPASS_CHARGE
    let sound = (0..2).any(|side| {
        let out: Vec<f64> = samples.iter().skip(side).step_by(2).map(|&s| s as f64).collect();
        let mut sum = 0.0;
        out.iter().any(|&o| {
            let moved = (o - out[0] + (1.0 - KEPT) * sum).abs() > 1e-3;
            sum += o;
            moved
        })
    });
    match (sound, want_sound) {
        (true, true) | (false, false) => Verdict::Pass,
        (false, true) => Verdict::Fail("silent, expected sound".into()),
        (true, false) => Verdict::Fail("sound, expected silence".into()),
    }
}

/// Gambatte's CGB colours from RGB555: R = (13r + 2g + b) / 2, G = (3g + b) * 2,
/// B = (3r + 2g + 11b) / 2 (c-sp's howto). The core expands x*255/31; recover x first.
fn gambatte_cgb_to_rgb(p: &[u8]) -> [u8; 3] {
    let [r, g, b] = [p[0], p[1], p[2]].map(|v| (v as u16 * 31 + 127) / 255);
    [(r * 13 + g * 2 + b) / 2, (g * 3 + b) * 2, (r * 3 + g * 2 + b * 11) / 2].map(|v| v as u8)
}

#[test]
fn gambatte_dmg() {
    run_suite_where("Gambatte DMG", "gambatte", &[""], 1, gambatte, |label| label.ends_with("@dmg"));
}

#[test]
fn gambatte_cgb() {
    run_suite_where("Gambatte CGB", "gambatte", &[""], 1, gambatte, |label| label.ends_with("@cgb"));
}

#[test]
fn gambatte_names() {
    let checks = |rel: &str| -> Vec<(String, Hw, Check)> {
        gambatte(Path::new(rel), &format!("gambatte/{rel}"))
            .into_iter()
            .map(|j| match j.protocol {
                Protocol::Gambatte(c) => (j.label, j.hw, c),
                p => panic!("{p:?}"),
            })
            .collect()
    };
    let hex = |d: &str| Check::Hex(d.into());
    assert_eq!(
        checks("window/late_disable_0_dmg08_cgb04c_out0.gbc"),
        [
            ("gambatte/window/late_disable_0_dmg08_cgb04c_out0.gbc@dmg".into(), Hw::Dmg, hex("0")),
            ("gambatte/window/late_disable_0_dmg08_cgb04c_out0.gbc@cgb".into(), Hw::Cgb, hex("0")),
        ]
    );
    let late_1 = checks("window/late_disable_1_dmg08_out3_cgb04c_out0.gbc");
    assert_eq!(late_1.iter().map(|(_, hw, c)| (*hw, c.clone())).collect::<Vec<_>>(), [(Hw::Dmg, hex("3")), (Hw::Cgb, hex("0"))]);
    assert_eq!(checks("dma/hdma_vs_m0int_pc_scx1_1_cgb04c_out1033.gbc")[0].2, hex("1033"));
    assert_eq!(checks("window/late_disable_ds_1_cgb04c_out0.gbc").len(), 1); // CGB alone
    assert_eq!(checks("sound/ch1_duty0_pos6_to_pos7_timing_1_dmg08_cgb04c_outaudio1.gbc")[1].2, Check::Audio(true));
    let dmg_only = checks("sound/x_dmg08_outaudio0_cgb_xoutaudio1lowpitch.gbc");
    assert_eq!(dmg_only.into_iter().map(|c| (c.1, c.2)).collect::<Vec<_>>(), [(Hw::Dmg, Check::Audio(false))]);
    assert_eq!(checks("oamdma/oamdma_srcFF00_busyreadC000_dmg08_out1_cgb_xoutblank.gbc").len(), 1); // DMG alone
    assert_eq!(checks("vram_dumper.gbc"), [("gambatte/vram_dumper.gbc@cgb".into(), Hw::Cgb, Check::Runs)]);

    let dir = std::env::temp_dir().join(format!("cartouche-282-{}", std::process::id()));
    std::fs::create_dir_all(&dir).unwrap();
    let png = dir.join("scy_during_m3_1_dmg08.png");
    std::fs::write(&png, b"").unwrap();
    let shot = gambatte(&dir.join("scy_during_m3_1.gb"), "gambatte/scy/scy_during_m3_1.gb");
    std::fs::remove_dir_all(&dir).unwrap();
    assert_eq!(shot.len(), 1);
    assert_eq!(shot[0].label, "gambatte/scy/scy_during_m3_1.gb@dmg");
    assert!(matches!(&shot[0].protocol, Protocol::Gambatte(Check::Screen(p)) if *p == png));
}

#[test]
fn gambatte_hex_verdict_reads_the_roms_own_glyph() {
    let mut rom = vec![0; 0x8000];
    let glyph = |d: usize| -> Vec<u8> { (0..16).map(|b| (d * 16 + b) as u8 & 0x7E).collect() };
    for d in 0..16 {
        rom[GAMBATTE_FONT + d * 16..][..16].copy_from_slice(&glyph(d));
    }
    // "3A" drawn in the four DMG greys in cells 0 and 1.
    let mut frame = vec![0xFF; 160 * 144 * 4];
    for (i, d) in [3, 10].into_iter().enumerate() {
        let g = glyph(d);
        for y in 0..8 {
            for x in 0..8 {
                let colour = (g[2 * y] >> (7 - x) & 1) | (g[2 * y + 1] >> (7 - x) & 1) << 1;
                let px = (y * 160 + i * 8 + x) * 4;
                frame[px..px + 3].fill([0xFF, 0xAA, 0x55, 0x00][colour as usize]);
            }
        }
    }
    assert_eq!(hex_verdict(&frame, &rom, "3A"), Verdict::Pass);
    assert_eq!(hex_verdict(&frame, &rom, "3a"), Verdict::Pass);
    assert!(matches!(hex_verdict(&frame, &rom, "3B"), Verdict::Fail(_)));
    assert!(matches!(hex_verdict(&frame, &rom, "3A0"), Verdict::Fail(_))); // cell 2 is blank
    assert!(matches!(hex_verdict(&frame, &rom, ""), Verdict::Fail(_)));
    frame[(160 + 9) * 4] ^= 0x10; // one pixel of cell 1
    assert!(matches!(hex_verdict(&frame, &rom, "3A"), Verdict::Fail(_)));
}

#[test]
fn gambatte_audio_verdict_undoes_the_capacitor() {
    // A steady level through the capacitor: out[n] = out[0] * 0.996^n on both sides.
    let steady: Vec<f32> = (0..1470).map(|n| 0.2 * 0.996f32.powi(n / 2)).collect();
    assert_eq!(audio_verdict(&steady, false), Verdict::Pass);
    assert!(matches!(audio_verdict(&steady, true), Verdict::Fail(_)));
    assert_eq!(audio_verdict(&[0.0; 1470], false), Verdict::Pass);
    // The smallest square wave a channel makes: one volume step of 15, NR50 at 0, 4 channels.
    let square: Vec<f32> = (0..1470).map(|n| if n / 40 % 2 == 0 { 0.0 } else { 2.0 / 15.0 / 8.0 / 4.0 }).collect();
    assert_eq!(audio_verdict(&square, true), Verdict::Pass);
    assert!(matches!(audio_verdict(&square, false), Verdict::Fail(_)));
}

#[test]
fn gambatte_cgb_colours() {
    assert_eq!(gambatte_cgb_to_rgb(&[255, 255, 255, 255]), [248, 248, 248]);
    assert_eq!(gambatte_cgb_to_rgb(&[0, 0, 0, 255]), [0, 0, 0]);
    // r = 31 alone: 31 * 13 / 2, 0, 31 * 3 / 2
    assert_eq!(gambatte_cgb_to_rgb(&[255, 0, 0, 255]), [201, 0, 46]);
}

#[test]
fn revision_from_suffix() {
    let rev = |name: &str| revision(Path::new(name));
    assert_eq!(rev("mooneye-test-suite/acceptance/boot_regs-dmg0.gb"), Revision::Dmg0);
    assert_eq!(rev("mooneye-test-suite/acceptance/boot_hwio-dmgABCmgb.gb"), Revision::DmgAbc);
    assert_eq!(rev("mooneye-test-suite/acceptance/di_timing-GS.gb"), Revision::DmgAbc);
    assert_eq!(rev("mooneye-test-suite/acceptance/boot_div-cgb0.gb"), Revision::Cgb0);
    assert_eq!(rev("mooneye-test-suite/acceptance/boot_div-cgbABCDE.gb"), Revision::Default);
    assert_eq!(rev("mooneye-test-suite/acceptance/boot_regs-sgb.gb"), Revision::Default);
    assert_eq!(rev("age-test-roms/stat-mode/stat-mode-cgbE.gb"), Revision::CgbE);
    assert_eq!(rev("age-test-roms/ly/ly-dmgC-cgbBC.gb"), Revision::CgbC); // run on the CGB
    assert_eq!(rev("age-test-roms/ly/ly-ncmE.gb"), Revision::CgbE);
    assert_eq!(rev("age-test-roms/oam/oam-write-dmgC.gb"), Revision::DmgAbc);
    assert_eq!(rev("age-test-roms/halt/ei-halt-dmgC-cgbBCE.gb"), Revision::Default);
    assert_eq!(rev("same-suite/apu/channel_1/channel_1_freq_change_timing-A.gb"), Revision::Agb);
    assert_eq!(rev("same-suite/apu/channel_1/channel_1_freq_change_timing-cgb0BC.gb"), Revision::Cgb0);
    assert_eq!(rev("same-suite/apu/channel_3/channel_3_extra_length_clocking-cgbB.gb"), Revision::CgbB);
    assert_eq!(rev("same-suite/apu/channel_1/channel_1_freq_change_timing-cgbDE.gb"), Revision::Default);
    assert_eq!(rev("mealybug-tearoom-tests/ppu/m3_scy_change2_cgb_c.png"), Revision::CgbC);
    assert_eq!(rev("mealybug-tearoom-tests/ppu/m3_scy_change_cgb_d.png"), Revision::CgbD);
    assert_eq!(rev("mealybug-tearoom-tests/ppu/m3_scy_change_dmg_blob.png"), Revision::Default);
    assert_eq!(rev("mooneye-test-suite/acceptance/div_timing.gb"), Revision::Default);
}

#[test]
fn tile25_footprint_covers_obj_at_x3() {
    let mut rom = vec![0; 0x8000];
    rom[0x14D] = 0xE7; // header checksum of an all-zero header
    let mut gb = GameBoy::new(rom).unwrap();
    gb.bus.ppu.lcdc = 0x93; // LCD, BG and OBJs on, tile data at $8000 (map all zeros), 8x8 OBJs
    gb.bus.ppu.oam = [0; 0xA0];
    gb.bus.ppu.oam[..4].copy_from_slice(&[16, 3, 25, 0]);
    let covered: Vec<(usize, usize)> = tile25_footprint(&gb).iter().enumerate().filter(|(_, &c)| c).map(|(i, _)| (i % 160, i / 160)).collect();
    let want: Vec<(usize, usize)> = (0..8).flat_map(|y| (0..3).map(move |x| (x, y))).collect();
    assert_eq!(covered, want);
}

#[test]
fn parse_expected_counts_rule_blocked() {
    let text = "s/a.gb@dmg  # rule-blocked: ® in tile 25\ns/b.gb  # ppu-mode3\n";
    assert_eq!(parse_expected(text).len(), 2);
    assert_eq!(parse_rule_blocked(text).into_iter().collect::<Vec<_>>(), ["s/a.gb@dmg"]);
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

    let none = listed(&[]);
    assert_eq!(reconcile("s", &results, &listed(&["s/fail.gb"]), &none, &none), Ok((1, 2, 0, 0)));

    let err = reconcile("s", &results, &none, &none, &none).unwrap_err();
    assert!(err.contains("regression: s/fail.gb"), "{err}");

    let err = reconcile("s", &results, &listed(&["s/fail.gb", "s/pass.gb"]), &none, &none).unwrap_err();
    assert!(err.contains("now passes: remove from expected-failures.txt: s/pass.gb"), "{err}");

    let err = reconcile("s", &results, &listed(&["s/fail.gb", "s/gone.gb"]), &none, &none).unwrap_err();
    assert!(err.contains("stale entry: s/gone.gb"), "{err}");

    // A probe without a verdict that runs clean is counted apart, never as a pass.
    assert_eq!(reconcile("s", &results, &listed(&["s/fail.gb"]), &listed(&["s/pass.gb"]), &none), Ok((0, 1, 1, 0)));

    let err = reconcile("s", &results, &none, &listed(&["s/fail.gb"]), &none).unwrap_err();
    assert!(err.contains("probe without a verdict failed to run: s/fail.gb"), "{err}");

    let err = reconcile("s", &results, &listed(&["s/fail.gb"]), &listed(&["s/fail.gb"]), &none).unwrap_err();
    assert!(err.contains("in both expected-failures.txt and probes-without-verdict.txt: s/fail.gb"), "{err}");

    let err = reconcile("s", &results, &listed(&["s/fail.gb"]), &listed(&["s/gone.gb"]), &none).unwrap_err();
    assert!(err.contains("stale entry: s/gone.gb"), "{err}");

    // rule-blocked: must fail inside tile 25's footprint alone, and a ®-only fail must be rule-blocked
    let r = listed(&["s/r.gb"]);
    let tile25 = vec![("s/r.gb".to_string(), Verdict::FailTile25("8 pixels differ".into()))];
    assert_eq!(reconcile("s", &tile25, &r, &none, &r), Ok((0, 1, 0, 1)));
    let err = reconcile("s", &[("s/r.gb".to_string(), fail())], &r, &none, &r).unwrap_err();
    assert!(err.contains("rule-blocked but not ®-only: s/r.gb"), "{err}");
    let err = reconcile("s", &[("s/r.gb".to_string(), Verdict::Pass)], &r, &none, &r).unwrap_err();
    assert!(err.contains("now passes: remove from expected-failures.txt: s/r.gb"), "{err}");
    let err = reconcile("s", &tile25, &r, &none, &none).unwrap_err();
    assert!(err.contains("®-only now: move to the rule-blocked section: s/r.gb"), "{err}");
}
