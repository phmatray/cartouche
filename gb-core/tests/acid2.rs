//! dmg-acid2 / cgb-acid2 pixel tests (Matt Currie). The ROM renders a static test image and
//! executes `LD B,B` (0x40) as a software breakpoint; the frame is then compared pixel by pixel
//! with the reference PNG. ROMs and references live in test-roms/ (gitignored).

use std::path::{Path, PathBuf};

use gb_core::gameboy::GameBoy;
use gb_core::ppu::{PALETTE_COLORS, SCREEN_HEIGHT, SCREEN_WIDTH};

const TIMEOUT_FRAMES: u64 = 600;

fn root() -> PathBuf {
    Path::new(env!("CARGO_MANIFEST_DIR")).to_path_buf()
}

/// Runs until the LD B,B breakpoint (or timeout) and returns the framebuffer (RGBA8888).
fn run_until_breakpoint(rom: &str) -> (Vec<u8>, bool) {
    let data = std::fs::read(root().join(rom)).expect("read ROM");
    let mut gb = GameBoy::new(data).expect("create GameBoy");
    gb.skip_boot_rom();
    let limit = TIMEOUT_FRAMES * gb_core::gameboy::CYCLES_PER_FRAME as u64;
    let mut cycles = 0u64;
    let mut hit = false;
    while cycles < limit {
        if !gb.cpu.halted && gb.bus.read_byte(gb.cpu.regs.pc) == 0x40 {
            hit = true;
            break;
        }
        cycles += gb.step_instruction().expect("emulator error") as u64;
    }
    (gb.bus.ppu.framebuffer.to_vec(), hit)
}

fn load_reference(name: &str) -> Vec<[u8; 3]> {
    let mut decoder = png::Decoder::new(std::fs::File::open(root().join(name)).expect("open reference"));
    decoder.set_transformations(png::Transformations::normalize_to_color8());
    let mut reader = decoder.read_info().unwrap();
    let mut buf = vec![0; reader.output_buffer_size()];
    let info = reader.next_frame(&mut buf).unwrap();
    let px = |p: &[u8]| -> [u8; 3] {
        match info.color_type {
            png::ColorType::Grayscale | png::ColorType::GrayscaleAlpha => [p[0]; 3],
            _ => [p[0], p[1], p[2]],
        }
    };
    let step = info.color_type.samples();
    buf[..info.buffer_size()].chunks(step).map(px).collect()
}

fn compare(name: &str, rom: &str, reference: &str, to_rgb: fn(&[u8]) -> [u8; 3]) {
    let (fb, hit) = run_until_breakpoint(rom);
    let actual: Vec<[u8; 3]> = fb.chunks(4).map(to_rgb).collect();
    let expected = load_reference(reference);
    assert_eq!(expected.len(), SCREEN_WIDTH * SCREEN_HEIGHT);
    let diff = actual.iter().zip(&expected).filter(|(a, e)| a != e).count();
    if diff != 0 {
        let out = root().join(format!("target/acid2-{name}-actual.png"));
        let file = std::fs::File::create(&out).unwrap();
        let mut enc = png::Encoder::new(file, SCREEN_WIDTH as u32, SCREEN_HEIGHT as u32);
        enc.set_color(png::ColorType::Rgb);
        enc.set_depth(png::BitDepth::Eight);
        enc.write_header().unwrap().write_image_data(&actual.concat()).unwrap();
        panic!(
            "{name}: {diff} of {} pixels differ (breakpoint reached: {hit}); actual frame written to {}",
            expected.len(),
            out.display()
        );
    }
}

/// DMG shades (the core's green palette) mapped to the reference greys; unknown colours map to red.
fn dmg_to_grey(p: &[u8]) -> [u8; 3] {
    const GREYS: [u8; 4] = [0xFF, 0xAA, 0x55, 0x00];
    match PALETTE_COLORS.iter().position(|c| c[..3] == p[..3]) {
        Some(i) => [GREYS[i]; 3],
        None => [0xFF, 0, 0],
    }
}

/// The core expands RGB555 with x*255/31; recover the 5-bit value and use the standard
/// (x<<3)|(x>>2) expansion the reference image was made with.
fn cgb_to_rgb(p: &[u8]) -> [u8; 3] {
    let expand = |v: u8| {
        let x = ((v as u16 * 31 + 127) / 255) as u8;
        (x << 3) | (x >> 2)
    };
    [expand(p[0]), expand(p[1]), expand(p[2])]
}

#[test]
fn dmg_acid2() {
    compare("dmg", "test-roms/dmg-acid2.gb", "test-roms/dmg-acid2-reference.png", dmg_to_grey);
}

#[test]
fn cgb_acid2() {
    compare("cgb", "test-roms/cgb-acid2.gbc", "test-roms/cgb-acid2-reference.png", cgb_to_rgb);
}

/// The copies bundled with the web app (gb-web/public/roms) must render the same smiley.
#[test]
fn bundled_acid2() {
    compare("dmg", "../gb-web/public/roms/dmg-acid2.gb", "test-roms/dmg-acid2-reference.png", dmg_to_grey);
    compare("cgb", "../gb-web/public/roms/cgb-acid2.gbc", "test-roms/cgb-acid2-reference.png", cgb_to_rgb);
}

#[test]
fn cgb_expansion_round_trips() {
    for x in 0u16..32 {
        let core = (x * 255 / 31) as u8;
        let std = ((x << 3) | (x >> 2)) as u8;
        assert_eq!(cgb_to_rgb(&[core, core, core])[0], std);
    }
}
