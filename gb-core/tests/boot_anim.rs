//! The start-up animations against their model. Every frame the core's boot ROMs draw (DMG and CGB, the three
//! animations) must equal the approved concept page's own rendering of it, pixel for pixel (DMG: the shade;
//! CGB: the 15-bit colour, as each renderer turns those to RGB its own way), and the chime must be the page's
//! register writes on the page's frames. References: `node gb-core/boot-src/gen.mjs --refs` (tests/boot_ref/).
//! The cartridge is a bundled homebrew game: the boot ROMs never read its logo, so any header does.

use gb_core::gameboy::{Console, GameBoy};
use gb_core::ppu::PALETTE_COLORS;
use std::collections::HashMap;
use std::path::PathBuf;

const FRAMES: usize = 160;
const NAMES: [&str; 3] = ["A", "B", "C"];

fn path(p: &str) -> PathBuf {
    PathBuf::from(env!("CARGO_MANIFEST_DIR")).join(p)
}

fn rom(cgb: bool) -> Vec<u8> {
    let name = if cgb { "ucity.gbc" } else { "tobutobugirl.gb" };
    std::fs::read(path(&format!("../gb-web/public/roms/{name}"))).unwrap()
}

/// A frame as compared: per pixel, the DMG shade (0-3) or the CGB colour (15-bit, little-endian).
fn key(rgba: &[u8], cgb: bool) -> Vec<u8> {
    let c5 = |c: u8| (0..32u16).find(|&v| (v * 255 / 31) as u8 == c).expect("not a 5-bit channel");
    rgba.chunks(4)
        .flat_map(|p| {
            if cgb {
                let v = c5(p[0]) | c5(p[1]) << 5 | c5(p[2]) << 10;
                vec![v as u8, (v >> 8) as u8]
            } else {
                vec![PALETTE_COLORS.iter().position(|c| c[..3] == p[..3]).expect("not a DMG shade") as u8]
            }
        })
        .collect()
}

/// The same key from a reference PNG, drawn with the page's colours (DMG LCD shades; CGB `(v << 3) | (v >> 2)`).
fn png_key(file: &PathBuf, cgb: bool) -> Vec<u8> {
    const LCD: [[u8; 3]; 4] = [[196, 207, 161], [139, 149, 109], [77, 83, 60], [31, 31, 31]];
    let decoder = png::Decoder::new(std::io::BufReader::new(std::fs::File::open(file).unwrap()));
    let mut reader = decoder.read_info().unwrap();
    let mut buf = vec![0; reader.output_buffer_size().unwrap()];
    reader.next_frame(&mut buf).unwrap();
    buf.chunks(3)
        .flat_map(|p| {
            if cgb {
                let v = (p[0] >> 3) as u16 | ((p[1] >> 3) as u16) << 5 | ((p[2] >> 3) as u16) << 10;
                vec![v as u8, (v >> 8) as u8]
            } else {
                vec![LCD.iter().position(|c| c[..] == p[..]).unwrap() as u8]
            }
        })
        .collect()
}

fn fnv(bytes: &[u8]) -> String {
    let h = bytes.iter().fold(0xcbf29ce484222325u64, |h, &b| (h ^ b as u64).wrapping_mul(0x100000001b3));
    format!("{h:016x}")
}

struct Played {
    frames: Vec<Vec<u8>>,
    /// Sound register writes during the animation: (frame, register, value).
    sound: Vec<(usize, u16, u8)>,
}

/// Runs the boot ROM instruction by instruction: frame n is the n-th picture after the LCD goes on, and a
/// write belongs to the frame it is made for (made after frame n-1 was shown).
fn play(gb: &mut GameBoy, cgb: bool) -> Played {
    let mut out = Played { frames: vec![], sound: vec![] };
    let mut lcd_was_on = false;
    while gb.bus.boot_rom_active && out.frames.len() < FRAMES {
        let pc = gb.cpu.regs.pc;
        let op = gb.bus.read_byte(pc);
        let target = match op {
            0xE0 => Some(0xFF00 | gb.bus.read_byte(pc.wrapping_add(1)) as u16),
            0xE2 => Some(0xFF00 | gb.cpu.regs.c as u16),
            0xEA => Some(u16::from_le_bytes([gb.bus.read_byte(pc.wrapping_add(1)), gb.bus.read_byte(pc.wrapping_add(2))])),
            _ => None,
        };
        if let Some(t @ 0xFF10..=0xFF26) = target {
            if lcd_was_on {
                out.sound.push((out.frames.len(), t, gb.cpu.regs.a));
            }
        }
        gb.step_instruction().unwrap();
        lcd_was_on |= gb.bus.ppu.lcdc & 0x80 != 0;
        if gb.bus.ppu.frame_ready {
            gb.bus.ppu.frame_ready = false;
            if gb.bus.ppu.lcdc & 0x80 != 0 {
                out.frames.push(key(gb.screen(), cgb));
            }
        }
    }
    out
}

fn reference() -> (HashMap<(String, String, usize), String>, HashMap<String, Vec<(usize, u16, u8)>>) {
    let text = std::fs::read_to_string(path("tests/boot_ref/reference.txt")).unwrap();
    let (mut frames, mut notes) = (HashMap::new(), HashMap::<String, Vec<_>>::new());
    for line in text.lines().filter(|l| !l.starts_with('#')) {
        let w: Vec<&str> = line.split(' ').collect();
        match w[0] {
            "frame" => {
                frames.insert((w[1].to_string(), w[2].to_string(), w[3].parse().unwrap()), w[4].to_string());
            }
            "note" => {
                let f: usize = w[2].parse().unwrap();
                for reg in &w[3..] {
                    let (name, v) = reg.split_once('=').unwrap();
                    let addr = match name {
                        "NR10" => 0xFF10, "NR11" => 0xFF11, "NR12" => 0xFF12, "NR13" => 0xFF13, "NR14" => 0xFF14,
                        "NR21" => 0xFF16, "NR22" => 0xFF17, "NR23" => 0xFF18, "NR24" => 0xFF19,
                        _ => panic!("{name}"),
                    };
                    notes.entry(w[1].to_string()).or_default().push((f, addr, u8::from_str_radix(v, 16).unwrap()));
                }
            }
            _ => panic!("{line}"),
        }
    }
    (frames, notes)
}

#[test]
fn every_frame_and_note_matches_the_concept_model() {
    let (frames, notes) = reference();
    let mut failures = vec![];
    for (i, name) in NAMES.iter().enumerate() {
        for cgb in [false, true] {
            let mode = if cgb { "cgb" } else { "dmg" };
            let mut gb = GameBoy::with_boot(rom(cgb), false, 0, i as u8 + 1).unwrap();
            assert_eq!(gb.in_colour(), cgb);
            let run = play(&mut gb, cgb);
            assert_eq!(run.frames.len(), FRAMES, "{name} {mode}: the animation lasts {FRAMES} frames");
            for (f, k) in run.frames.iter().enumerate() {
                if fnv(k) == frames[&(name.to_string(), mode.to_string(), f)] { continue; }
                let png = path(&format!("tests/boot_ref/{name}_{mode}_{f:03}.png"));
                let diff = png.exists().then(|| png_key(&png, cgb).iter().zip(k).filter(|(a, b)| a != b).count());
                failures.push(format!("{name} {mode} frame {f}: differs from the model ({diff:?} bytes off the key frame)"));
            }
            let want = &notes[*name];
            assert_eq!(&run.sound, want, "{name} {mode}: the chime's register writes, frame by frame");
        }
    }
    assert!(failures.is_empty(), "{} frames differ:\n{}", failures.len(), failures.join("\n"));
}

/// The key frames the page shows (its PNGs) are the ones the core draws: the hashes above say it for every
/// frame, this says it pixel by pixel where a person can look at the reference.
#[test]
fn key_frames_match_their_pngs() {
    for (i, name) in NAMES.iter().enumerate() {
        for cgb in [false, true] {
            let mode = if cgb { "cgb" } else { "dmg" };
            let mut gb = GameBoy::with_boot(rom(cgb), false, 0, i as u8 + 1).unwrap();
            let run = play(&mut gb, cgb);
            for f in [0, 30, 60, 100, 140, 150] {
                let want = png_key(&path(&format!("tests/boot_ref/{name}_{mode}_{f:03}.png")), cgb);
                assert!(run.frames[f] == want, "{name} {mode} frame {f}");
            }
        }
    }
}

/// Runs to the hand-over, stopping at the cartridge's first instruction.
fn to_the_game(gb: &mut GameBoy) {
    for _ in 0..600 * 70224 {
        if !gb.bus.boot_rom_active { return; }
        gb.step_instruction().unwrap();
    }
    panic!("the boot ROM never hands over");
}

#[test]
fn every_animation_hands_over_like_the_skipped_start() {
    for a in 1..=3 {
        let mut dmg = GameBoy::with_boot(rom(false), false, 0, a).unwrap();
        to_the_game(&mut dmg);
        let r = &dmg.cpu.regs;
        assert_eq!((r.a, r.f, r.b, r.c, r.d, r.e, r.h, r.l, r.sp), (0x01, 0xB0, 0, 0x13, 0, 0xD8, 0x01, 0x4D, 0xFFFE), "DMG {a}");
        let skipped = GameBoy::with_boot(rom(false), false, 0, 0).unwrap();
        assert_eq!(dmg.bus.ppu.vram, skipped.bus.ppu.vram, "DMG {a}: VRAM blank, no animation left behind");
        assert_eq!(dmg.bus.ppu.oam, skipped.bus.ppu.oam);
        assert_eq!(dmg.bus.wram, skipped.bus.wram);
        let p = &dmg.bus.ppu;
        assert_eq!((p.lcdc, p.scy, p.scx, p.wy, p.wx, p.bgp), (0x91, 0, 0, 0, 0, 0xFC));

        let mut cgb = GameBoy::with_boot(rom(true), false, 0, a).unwrap();
        to_the_game(&mut cgb);
        let r = &cgb.cpu.regs;
        assert_eq!((r.a, r.f, r.d, r.e, r.h, r.l), (0x11, 0x80, 0xFF, 0x56, 0x00, 0x0D), "CGB {a}");
        let skipped = GameBoy::with_boot(rom(true), false, 0, 0).unwrap();
        let white: Vec<u8> = (0..8).flat_map(|_| [0xFF, 0xFF, 0xFF, 0x7F, 0xFF, 0x7F, 0xFF, 0x7F]).collect();
        assert_eq!(cgb.bus.ppu.bg_cram[..], white[..], "CGB {a}: every BG palette white, as SameBoy's leaves them");
        assert_eq!(cgb.bus.ppu.obj_cram, skipped.bus.ppu.obj_cram);
        assert!(cgb.bus.ppu.vram.iter().all(|&b| b == 0), "CGB {a}: VRAM blank");

        let mut compat = GameBoy::with_boot(rom(false), true, 0, a).unwrap();
        to_the_game(&mut compat);
        let plain = GameBoy::with_boot(rom(false), true, 0, 0).unwrap();
        assert!(compat.bus.ppu.compat && compat.console == Console::Compat);
        assert_eq!((compat.bus.ppu.bg_cram, compat.bus.ppu.obj_cram), (plain.bus.ppu.bg_cram, plain.bus.ppu.obj_cram), "compat {a}: same colours as without the animation");
    }
}

#[test]
fn every_combination_colours_the_same_with_any_animation() {
    for palette in 0..=12 {
        let plain = GameBoy::with_boot(rom(false), true, palette, 0).unwrap();
        for a in 1..=3 {
            let mut gb = GameBoy::with_boot(rom(false), true, palette, a).unwrap();
            to_the_game(&mut gb);
            assert_eq!((gb.bus.ppu.bg_cram, gb.bus.ppu.obj_cram), (plain.bus.ppu.bg_cram, plain.bus.ppu.obj_cram), "palette {palette}, animation {a}");
        }
    }
}

#[test]
fn start_skips_and_a_state_saved_mid_animation_goes_on_anywhere() {
    for a in 1..=3 {
        let mut whole = GameBoy::with_boot(rom(false), true, 3, a).unwrap();
        for _ in 0..50 { whole.run_frame().unwrap(); }
        let mid = whole.save_state();
        // Loaded into a machine started with another animation (or none), it goes on with its own boot ROM.
        let mut other = GameBoy::with_boot(rom(false), true, 3, a % 3 + 1).unwrap();
        assert!(other.load_state(&mid));
        assert_eq!(other.boot, a);
        to_the_game(&mut whole);
        to_the_game(&mut other);
        assert_eq!(other.bus.ppu.bg_cram, whole.bus.ppu.bg_cram);
        assert_eq!(other.cpu.regs.pc, whole.cpu.regs.pc);

        let mut skipped = GameBoy::with_boot(rom(false), false, 0, a).unwrap();
        skipped.run_frame().unwrap();
        skipped.finish_boot().unwrap();
        assert!(!skipped.bus.boot_rom_active, "Start skips the rest");
    }
}

#[test]
fn super_game_boy_plays_it_then_sends_the_header() {
    let mut r = rom(false);
    r[0x146] = 0x03; // SGB functions, old licensee $33: what the Super Game Boy checks
    r[0x14B] = 0x33;
    r[0x14D] = (0x134..=0x14C).fold(0u8, |c, i| c.wrapping_sub(r[i]).wrapping_sub(1));
    for a in 1..=3 {
        let mut gb = GameBoy::with_sgb(r.clone(), a).unwrap();
        assert_eq!(gb.console, Console::Sgb);
        to_the_game(&mut gb);
        let x = &gb.cpu.regs;
        assert_eq!((x.a, x.f, x.b, x.c, x.d, x.e, x.h, x.l), (0x01, 0x00, 0, 0x14, 0, 0, 0xC0, 0x60), "SGB {a}");
    }
}
