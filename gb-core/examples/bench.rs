//! Headless frame-rate benchmark: how many frames per second the core emulates on a fixed workload.
//!
//!   cargo run --release --example bench [-- --frames N] [--trace]
//!
//! Runs each ROM below (all fetched into test-roms/ by ./scripts/fetch-test-roms.sh, never committed)
//! for 300 untimed warm-up frames after the boot sequence, then times N frames (default 3000) and
//! prints `<rom>  <fps> fps  (<x> × real time)` per ROM and the median. Real time is 59.73 fps
//! (4194304 / 70224). --trace turns on the PPU layer trace that Neural 4× and Smooth motion read.
//!
//! Comparing two builds (e.g. the scanline PPU and the pixel-FIFO one): run bench on the baseline
//! commit and on the branch, on the same machine, back to back, and report both. Numbers from
//! different machines, or from a loaded machine, are not comparable; repeat a few runs and keep the
//! best (or `/usr/bin/time -l` on macOS for an instruction count that load does not move).

use gb_core::gameboy::GameBoy;
use std::path::Path;
use std::time::Instant;

const ROMS: [&str; 7] = [
    "homebrew/ucity.gbc",
    "homebrew/gb240p.gb",
    "homebrew/geometrix.gbc",
    "homebrew/aevilia.gbc",
    "homebrew/shock-lobster/shocklobster.gb",
    "dmg-acid2.gb",
    "cgb-acid2.gbc",
];
const WARMUP_FRAMES: u32 = 300;
const REAL_FPS: f64 = 4_194_304.0 / 70_224.0;

fn main() {
    let args: Vec<String> = std::env::args().skip(1).collect();
    let trace = args.iter().any(|a| a == "--trace");
    let frames: u32 = match args.iter().position(|a| a == "--frames") {
        Some(i) => match args.get(i + 1).and_then(|n| n.parse().ok()) {
            Some(n) if n > 0 => n,
            _ => {
                eprintln!("--frames needs a whole number above 0");
                std::process::exit(2);
            }
        },
        None => 3000,
    };

    let dir = Path::new(env!("CARGO_MANIFEST_DIR")).join("test-roms");
    if !dir.is_dir() {
        println!("no test ROMs in {}: run ./scripts/fetch-test-roms.sh first", dir.display());
        return;
    }

    let mut rates = Vec::new();
    for name in ROMS {
        let Ok(rom) = std::fs::read(dir.join(name)) else {
            println!("{name}  skipped (not found)");
            continue;
        };
        match bench(rom, frames, trace) {
            Ok(fps) => {
                println!("{name}  {fps:.1} fps  ({:.1} × real time)", fps / REAL_FPS);
                rates.push(fps);
            }
            Err(e) => println!("{name}  error: {e}"),
        }
    }
    if rates.is_empty() {
        return;
    }
    rates.sort_by(f64::total_cmp);
    let mid = rates.len() / 2;
    let median = if rates.len() % 2 == 1 { rates[mid] } else { (rates[mid - 1] + rates[mid]) / 2.0 };
    println!("median {median:.1} fps  ({frames} frames{})", if trace { ", --trace" } else { "" });
}

fn bench(rom: Vec<u8>, frames: u32, trace: bool) -> Result<f64, String> {
    let mut gb = GameBoy::new(rom).map_err(|e| e.to_string())?;
    gb.skip_boot_rom();
    gb.bus.ppu.set_tracing(trace);
    for _ in 0..WARMUP_FRAMES {
        gb.run_frame().map_err(|e| e.to_string())?;
    }
    let start = Instant::now();
    for _ in 0..frames {
        gb.run_frame().map_err(|e| e.to_string())?;
    }
    Ok(frames as f64 / start.elapsed().as_secs_f64())
}
