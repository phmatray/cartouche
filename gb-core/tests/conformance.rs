//! Conformance suites: Mooneye (acceptance + emulator-only MBC), Mealybug Tearoom, SameSuite, Age,
//! gbmicrotest and rtc3test, from the pinned c-sp/game-boy-test-roms archive that
//! `scripts/fetch-test-roms.sh` unpacks into test-roms/conformance/ (gitignored, never committed).
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
    let actual: Vec<[u8; 3]> = gb.bus.ppu.framebuffer.chunks(4).map(to_rgb).collect();
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
/// 8x16 half included) and BG/window pixels fetched from tile 25 with LCDC.4 set: a structural
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
        if lcdc & 0x10 == 0 {
            continue;
        }
        let map = |bit: u8, cx: usize, cy: usize| {
            let at = if lcdc & bit != 0 { 0x1C00 } else { 0x1800 } + cy / 8 % 32 * 32 + cx / 8 % 32;
            p.vram[at] == 25 && !(p.cgb_mode && p.vram[0x2000 + at] & 0x08 != 0)
        };
        // Traced outside CGB mode: the tile each pixel was fetched with, wherever a mid-line write
        // moved it. (In CGB mode the trace has no VRAM bank, so the per-line map lookup stays.)
        if let Some(t) = traced.filter(|t| t.rendered(y) && !p.cgb_mode) {
            for x in 0..160 {
                fp[y * 160 + x] |= t.tile[y * 160 + x] == 25;
            }
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
        set.into_iter().filter(|e| prefixes.iter().any(|p| e.starts_with(&format!("{p}/")))).collect()
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

#[test]
fn runs_verdict_fails_on_emulator_error() {
    assert_eq!(run(synthetic(&[0x18, 0xFE]), Hw::Dmg, &Protocol::Runs, 1), Verdict::Pass); // JR -2
    let v = run(synthetic(&[0xD3]), Hw::Dmg, &Protocol::Runs, 1); // an invalid opcode
    assert!(matches!(&v, Verdict::Fail(why) if why.starts_with("emulator error")), "{v:?}");
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
