//! Headless renderer: runs a ROM for N frames and saves the last frame as a PNG.
//!
//!   cargo run --release --example render -- <rom> <frames> <out.png> [--buttons "frame:button,..."]
//!
//! Buttons: a, b, select, start, up, down, left, right. Each press is held for HOLD_FRAMES frames.
//! Example: --buttons "120:start,200:a,260:right"
//!
//! Write output to ../screenshots/ (git-ignored): screenshots of commercial games must never be committed.

use gb_core::gameboy::GameBoy;
use gb_core::interrupts::JOYPAD_BIT;
use gb_core::joypad::JoypadButton;
use gb_core::ppu::{SCREEN_HEIGHT, SCREEN_WIDTH};

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
    let mut gb = GameBoy::new(rom).expect("cannot load ROM");
    gb.skip_boot_rom();

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

    let file = std::fs::File::create(&args[2]).expect("cannot create output");
    let mut enc = png::Encoder::new(file, SCREEN_WIDTH as u32, SCREEN_HEIGHT as u32);
    enc.set_color(png::ColorType::Rgba);
    enc.set_depth(png::BitDepth::Eight);
    enc.write_header().unwrap().write_image_data(&gb.bus.ppu.framebuffer).unwrap();
    println!("{} ({} mode, {frames} frames)", args[2], if gb.cgb_mode { "CGB" } else { "DMG" });
}
