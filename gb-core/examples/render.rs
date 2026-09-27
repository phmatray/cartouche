//! Headless renderer: runs a ROM for N frames and saves the last frame as a PNG.
//!
//!   cargo run --release --example render -- <rom> <frames> <out.png> [--buttons "frame:button,..."]
//!
//! Buttons: a, b, select, start, up, down, left, right. Each press is held for HOLD_FRAMES frames.
//! Example: --buttons "120:start,200:a,260:right"
//! --gbc <0-12>: an original Game Boy cartridge on a Game Boy Color (0 automatic colours, 1-12 a palette).
//! --sgb: on a Super Game Boy; the PNG is 256x224 with the game's border once it sent one.
//!
//! Write output to ../screenshots/ (git-ignored): screenshots of commercial games must never be committed.

use gb_core::gameboy::GameBoy;
use gb_core::interrupts::JOYPAD_BIT;
use gb_core::joypad::JoypadButton;
use gb_core::ppu::{SCREEN_HEIGHT, SCREEN_WIDTH};
use gb_core::sgb::{BORDER_HEIGHT, BORDER_WIDTH, GAME_X, GAME_Y};

const HOLD_FRAMES: u32 = 5;

fn button(name: &str) -> JoypadButton {
    match name.trim().to_ascii_lowercase().as_str() {
        "a" => JoypadButton::A,
        "b" => JoypadButton::B,
        "select" => JoypadButton::Select,
        "start" => JoypadButton::Start,
        "up" => JoypadButton::Up,
        "down" => JoypadButton::Down,
        "left" => JoypadButton::Left,
        "right" => JoypadButton::Right,
        other => panic!("unknown button {other:?}"),
    }
}

fn main() {
    let args: Vec<String> = std::env::args().skip(1).collect();
    if args.len() < 3 {
        eprintln!("usage: render <rom> <frames> <out.png> [--buttons \"frame:button,...\"]");
        std::process::exit(2);
    }
    let frames: u32 = args[1].parse().expect("frames must be a number");
    let mut presses: Vec<(u32, JoypadButton)> = Vec::new();
    if let Some(i) = args.iter().position(|a| a == "--buttons") {
        let spec = args.get(i + 1).expect("--buttons needs a value");
        for item in spec.split(',').filter(|s| !s.trim().is_empty()) {
            let (f, b) = item.split_once(':').expect("expected frame:button");
            presses.push((f.trim().parse().expect("bad frame number"), button(b)));
        }
    }

    let rom = std::fs::read(&args[0]).expect("cannot read ROM");
    let gbc = args.iter().position(|a| a == "--gbc").map(|i| args[i + 1].parse::<u8>().expect("palette 0-12"));
    let mut gb = if args.iter().any(|a| a == "--sgb") {
        GameBoy::with_sgb(rom, 0)
    } else {
        GameBoy::with_boot(rom, gbc.is_some(), gbc.unwrap_or(0), 0)
    }
    .expect("cannot load ROM");

    for frame in 0..frames {
        for &(at, b) in &presses {
            if frame == at && gb.bus.joypad.set_button(b, true) {
                gb.bus.interrupts.request(JOYPAD_BIT);
            }
            if frame == at + HOLD_FRAMES {
                gb.bus.joypad.set_button(b, false);
            }
        }
        if let Err(e) = gb.run_frame() {
            eprintln!("emulator error at frame {frame}: {e}");
            break;
        }
    }

    let (mut w, mut h, mut image) = (SCREEN_WIDTH, SCREEN_HEIGHT, gb.screen().to_vec());
    if let Some(s) = gb.bus.sgb.as_deref().filter(|s| s.has_border) {
        let mut out = s.border.clone();
        for (y, row) in image.chunks(SCREEN_WIDTH * 4).enumerate() {
            let o = ((GAME_Y + y) * BORDER_WIDTH + GAME_X) * 4;
            out[o..o + row.len()].copy_from_slice(row);
        }
        (w, h, image) = (BORDER_WIDTH, BORDER_HEIGHT, out);
    }
    let file = std::fs::File::create(&args[2]).expect("cannot create output");
    let mut enc = png::Encoder::new(file, w as u32, h as u32);
    enc.set_color(png::ColorType::Rgba);
    enc.set_depth(png::BitDepth::Eight);
    enc.write_header().unwrap().write_image_data(&image).unwrap();
    println!("{} ({} mode, {frames} frames)", args[2], format!("{:?}", gb.console));
}
