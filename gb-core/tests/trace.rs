//! Layer trace (src/trace.rs): the separated planes must rebuild the shown frame exactly, and the
//! motion vectors must match known scroll/OBJ deltas. Only test ROMs and freely licensed homebrew.

use std::path::Path;
use std::time::Instant;

use gb_core::gameboy::GameBoy;
use gb_core::interrupts::JOYPAD_BIT;
use gb_core::joypad::JoypadButton;
use gb_core::ppu::{SCREEN_HEIGHT as H, SCREEN_WIDTH as W};
use gb_core::trace::*;

fn load(path: &Path) -> Option<GameBoy> {
    let Ok(rom) = std::fs::read(path) else {
        assert!(std::env::var_os("CARTOUCHE_REQUIRE_ROMS").is_none(), "{} not found", path.display());
        eprintln!("skipped: {} not found", path.display());
        return None;
    };
    let mut gb = GameBoy::new(rom).expect("load ROM");
    gb.skip_boot_rom();
    Some(gb)
}

fn rom(rel: &str) -> std::path::PathBuf {
    Path::new(env!("CARGO_MANIFEST_DIR")).join(rel)
}

/// Next traced frame; the LCD may be off for a while (start-up copies with the LCD off).
fn next_frame(gb: &mut GameBoy) {
    assert!((0..10).any(|_| gb.run_to_vblank().unwrap()), "LCD stayed off for 20 frames");
}

fn done(gb: &GameBoy) -> &FrameTrace {
    &gb.bus.ppu.trace.as_ref().expect("tracing on").done
}

/// Planes + priority rules rebuild the shown frame, and the recorded layer ids agree.
/// Returns how many shown pixels came from (BG, window, OBJ).
fn check_composite(t: &FrameTrace, what: &str) -> [usize; 3] {
    let (rgba, layers) = t.composite();
    let mut counts = [0; 3];
    for y in (0..H).filter(|&y| t.rendered(y)) {
        for x in 0..W {
            let i = y * W + x;
            assert_eq!(rgba[i * 4..i * 4 + 4], t.final_[i * 4..i * 4 + 4], "{what}: frame {} pixel ({x},{y})", t.frame());
            assert_eq!(layers[i], t.info[i * 4], "{what}: frame {} layer at ({x},{y})", t.frame());
            counts[layers[i] as usize] += 1;
        }
    }
    counts
}

/// Warps `prev`'s plane with the motion field and counts (matching, compared) pixels:
/// every pixel with a known vector whose source is on screen and was drawn in that plane.
fn warp_check(prev: &FrameTrace, cur: &FrameTrace, mode: u8) -> (usize, usize) {
    let mut mv = vec![0i8; PIXELS * 2];
    motion_field(prev, cur, mode, &mut mv);
    let plane = |t: &FrameTrace| -> Vec<u8> {
        match mode {
            MV_BG => t.bg.clone(),
            MV_WIN => t.win.clone(),
            MV_OBJ => t.obj.clone(),
            _ => t.final_.clone(),
        }
    };
    let (pp, cp) = (plane(prev), plane(cur));
    let (mut ok, mut n) = (0, 0);
    for y in 0..H {
        for x in 0..W {
            let i = y * W + x;
            let (dx, dy) = (mv[i * 2], mv[i * 2 + 1]);
            if dx == MV_UNKNOWN || cp[i * 4 + 3] == 0 {
                continue;
            }
            let (sx, sy) = (x as i32 + dx as i32, y as i32 + dy as i32);
            if !(0..W as i32).contains(&sx) || !(0..H as i32).contains(&sy) || !prev.rendered(sy as usize) {
                continue;
            }
            let j = (sy as usize * W + sx as usize) * 4;
            // Shown pixels: skip disocclusions (the source showed a different layer).
            if pp[j + 3] == 0 || (mode == MV_FINAL && prev.info[j] != cur.info[i * 4]) {
                continue;
            }
            n += 1;
            ok += (pp[j..j + 4] == cp[i * 4..i * 4 + 4]) as usize;
        }
    }
    (ok, n)
}

// --- composite on the acid2 test images (window, OBJ priorities, 8x16, flips, CGB attributes) ---

fn acid2(rel: &str) {
    let Some(mut gb) = load(&rom(rel)) else { return };
    gb.bus.ppu.set_tracing(true);
    for _ in 0..30 {
        next_frame(&mut gb);
        check_composite(done(&gb), rel);
    }
    let t = done(&gb);
    assert_eq!(t.final_, gb.bus.ppu.framebuffer.to_vec(), "{rel}: final plane is the framebuffer at VBlank");
    let c = check_composite(t, rel);
    eprintln!("{rel}: shown pixels BG/WIN/OBJ = {c:?}");
    assert!(c.iter().all(|&n| n > 0), "{rel}: every layer should be visible, got {c:?}");
}

#[test]
fn composite_dmg_acid2() { acid2("../gb-web/public/roms/dmg-acid2.gb"); }
#[test]
fn composite_cgb_acid2() { acid2("../gb-web/public/roms/cgb-acid2.gbc"); }

// --- composite and motion over long homebrew runs ---

const FRAMES: u32 = 1500;

/// Start and A alternately (as in homebrew.rs), plus d-pad walks, so the games scroll.
fn press(gb: &mut GameBoy, frame: u32) {
    use JoypadButton::*;
    let held = match frame % 240 {
        60..=64 => Some(Start),
        0..=4 if frame > 0 => Some(A),
        100..=160 => Some(if frame / 240 % 2 == 0 { Right } else { Left }),
        170..=220 => Some(if frame / 480 % 2 == 0 { Down } else { Up }),
        _ => None,
    };
    for b in [A, B, Start, Select, Up, Down, Left, Right] {
        let on = held.map(|h| h as u8) == Some(b as u8);
        if gb.bus.joypad.set_button(b, on) && on {
            gb.bus.interrupts.request(JOYPAD_BIT);
        }
    }
}

fn homebrew(rel: &str) {
    let Some(mut gb) = load(&rom(rel)) else { return };
    gb.bus.ppu.set_tracing(true);
    let mut shown = [0usize; 3];
    let mut warp = [(0usize, 0usize); 4];
    for frame in 0..FRAMES {
        press(&mut gb, frame);
        if !gb.run_to_vblank().unwrap() {
            continue;
        }
        let t = gb.bus.ppu.trace.as_ref().unwrap();
        let c = check_composite(&t.done, rel);
        (0..3).for_each(|k| shown[k] += c[k]);
        if t.frames >= 2 {
            for mode in [MV_FINAL, MV_BG, MV_WIN, MV_OBJ] {
                let (ok, n) = warp_check(&t.prev, &t.done, mode);
                warp[mode as usize].0 += ok;
                warp[mode as usize].1 += n;
            }
        }
    }
    let pct = |(ok, n): (usize, usize)| if n == 0 { 100.0 } else { 100.0 * ok as f64 / n as f64 };
    eprintln!(
        "{rel}: shown BG/WIN/OBJ {shown:?}; motion-warp match final {:.3}% ({} px) bg {:.3}% ({}) win {:.3}% ({}) obj {:.3}% ({})",
        pct(warp[0]), warp[0].1, pct(warp[1]), warp[1].1, pct(warp[2]), warp[2].1, pct(warp[3]), warp[3].1
    );
    assert!(shown[0] > 0, "{rel}: no BG pixel shown");
    // Tiles and palettes change between frames, so a small share of warped pixels differ.
    assert!(pct(warp[1]) > 90.0, "{rel}: BG motion warp only matches {:.2}%", pct(warp[1]));
}

#[test]
fn trace_tobutobugirl() { homebrew("../gb-web/public/roms/tobutobugirl.gb"); }
#[test]
fn trace_tobutobugirldx() { homebrew("../gb-web/public/roms/tobutobugirldx.gb"); }
#[test]
fn trace_ucity() { homebrew("../gb-web/public/roms/ucity.gbc"); }
#[test]
fn trace_cpu_instrs() { homebrew("../gb-web/public/roms/cpu_instrs.gb"); }
#[test]
fn trace_aevilia() { homebrew("test-roms/homebrew/aevilia.gbc"); }
#[test]
fn trace_catmario() { homebrew("test-roms/homebrew/catmario-gb.gbc"); }
#[test]
fn trace_geometrix() { homebrew("test-roms/homebrew/geometrix.gbc"); }
#[test]
fn trace_shock_lobster() { homebrew("test-roms/homebrew/shock-lobster/shocklobster.gb"); }

/// Tracing only observes: the picture is bit-identical with it on or off.
#[test]
fn tracing_does_not_change_the_picture() {
    let path = rom("../gb-web/public/roms/tobutobugirldx.gb");
    let (Some(mut a), Some(mut b)) = (load(&path), load(&path)) else { return };
    b.bus.ppu.set_tracing(true);
    for frame in 0..600 {
        press(&mut a, frame);
        press(&mut b, frame);
        a.run_frame().unwrap();
        b.run_frame().unwrap();
        assert_eq!(a.bus.ppu.framebuffer, b.bus.ppu.framebuffer, "frame {frame}");
    }
}

// --- synthetic scroller: known deltas ---

/// A 32 KiB DMG ROM: two textured tiles, a checkerboard BG, a window from line 100 and two OBJs.
/// Every VBlank: SCX += 3, SCY -= 1, WX -= 1, OBJ 0 moves (+2, -1), OBJ 1 stays.
fn scroller_rom() -> Vec<u8> {
    #[rustfmt::skip]
    let code: &[u8] = &[
        0x3E, 0x00, 0xE0, 0x40,             // LCD off
        0x21, 0x00, 0x80, 0x06, 0x20,       // tiles 0-1 at $8000: byte = low address byte
        0x7D, 0x22, 0x05, 0x20, 0xFB,
        0x21, 0x00, 0x98, 0x01, 0x00, 0x04, // BG map $9800: (column ^ row) & 1
        0x7D, 0x0F, 0x0F, 0x0F, 0x0F, 0x0F, 0xAD, 0xE6, 0x01, 0x22, 0x0B, 0x78, 0xB1, 0x20, 0xF1,
        0x21, 0x00, 0xFE,                   // OAM 0: y 60 x 50 tile 1; OAM 1: y 90 x 100 tile 0 x-flip
        0x3E, 60, 0x22, 0x3E, 50, 0x22, 0x3E, 1, 0x22, 0x3E, 0x00, 0x22,
        0x3E, 90, 0x22, 0x3E, 100, 0x22, 0x3E, 0, 0x22, 0x3E, 0x20, 0x22,
        0x3E, 0xE4, 0xE0, 0x47, 0xE0, 0x48, // BGP = OBP0 = $E4
        0x3E, 100, 0xE0, 0x4A,              // WY 100
        0x3E, 94, 0xE0, 0x4B,               // WX 94
        0x3E, 0xF3, 0xE0, 0x40,             // LCD on: window map $9C00, window, tiles $8000, OBJ, BG
        // main: wait for LY 144
        0xF0, 0x44, 0xFE, 0x90, 0x20, 0xFA,
        0xF0, 0x43, 0xC6, 0x03, 0xE0, 0x43, // SCX += 3
        0xF0, 0x42, 0x3D, 0xE0, 0x42,       // SCY -= 1
        0xF0, 0x4B, 0x3D, 0xE0, 0x4B,       // WX -= 1
        0xFA, 0x01, 0xFE, 0xC6, 0x02, 0xEA, 0x01, 0xFE, // OBJ 0 x += 2
        0xFA, 0x00, 0xFE, 0x3D, 0xEA, 0x00, 0xFE,       // OBJ 0 y -= 1
        0xF0, 0x44, 0xFE, 0x90, 0x28, 0xFA, // wait for LY != 144
        0x18, 0xD3,                         // jr main
    ];
    let mut rom = vec![0u8; 0x8000];
    rom[0x100..0x104].copy_from_slice(&[0x00, 0xC3, 0x50, 0x01]);
    rom[0x134..0x13C].copy_from_slice(b"SCROLLER");
    rom[0x14D] = (0x134..=0x14C).fold(0u8, |c: u8, a| c.wrapping_sub(rom[a]).wrapping_sub(1));
    rom[0x150..0x150 + code.len()].copy_from_slice(code);
    rom
}

#[test]
fn motion_vectors_match_known_deltas() {
    let mut gb = GameBoy::new(scroller_rom()).expect("scroller ROM");
    gb.skip_boot_rom();
    gb.bus.ppu.set_tracing(true);
    for _ in 0..40 {
        next_frame(&mut gb);
    }
    let t = gb.bus.ppu.trace.as_mut().unwrap();
    let (l0, l1) = (t.prev.line(0), t.done.line(0));
    assert_eq!((l1[line::SCX].wrapping_sub(l0[line::SCX]), l0[line::SCY].wrapping_sub(l1[line::SCY])), (3, 1));
    check_composite(&t.done, "scroller");

    t.compute_motion(MV_FINAL);
    let mut seen = [0usize; 3];
    for y in 0..H {
        for x in 0..W {
            let i = y * W + x;
            let [layer, slot, ..] = t.done.info[i * 4..i * 4 + 4] else { unreachable!() };
            let expected = match (layer, slot) {
                (LAYER_BG, _) => (3, -1),
                (LAYER_WIN, _) => (1, 0),
                (LAYER_OBJ, 0) => (-2, 1),
                (LAYER_OBJ, 1) => (0, 0),
                other => panic!("unexpected layer/slot {other:?}"),
            };
            assert_eq!((t.motion[i * 2], t.motion[i * 2 + 1]), expected, "pixel ({x},{y}) layer {layer}");
            seen[layer as usize] += 1;
        }
    }
    assert!(seen.iter().all(|&n| n > 0), "every layer is on screen: {seen:?}");

    // Exact: every plane, warped by its own motion, reproduces the next frame's plane.
    for mode in [MV_FINAL, MV_BG, MV_WIN, MV_OBJ] {
        let (ok, n) = warp_check(&t.prev, &t.done, mode);
        assert!(n > 0 && ok == n, "mode {mode}: {ok} of {n} warped pixels match");
    }
}

/// `cargo test --release --test trace -- --ignored --nocapture trace_overhead`
#[test]
#[ignore]
fn trace_overhead() {
    let path = rom("../gb-web/public/roms/tobutobugirldx.gb");
    let mut report = Vec::new();
    for (name, on, motion) in [("off", false, false), ("on", true, false), ("on+motion", true, true)] {
        let mut gb = load(&path).unwrap();
        gb.bus.ppu.set_tracing(on);
        for f in 0..300 {
            press(&mut gb, f);
            gb.run_frame().unwrap();
        }
        let start = Instant::now();
        let n = 3000;
        for f in 300..300 + n {
            press(&mut gb, f);
            gb.run_frame().unwrap();
            if motion {
                gb.bus.ppu.trace.as_mut().unwrap().compute_motion(MV_FINAL);
            }
        }
        let us = start.elapsed().as_secs_f64() * 1e6 / n as f64;
        report.push(format!("{name}: {us:.1} us/frame"));
    }
    eprintln!("trace overhead (tobutobugirldx, 3000 frames): {}", report.join(", "));
}
