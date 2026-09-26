//! Headless harvester: plays a ROM with a seeded random input policy and writes the layer trace
//! of every recorded frame (src/trace.rs) as zlib-compressed chunks of fixed-size records.
//!
//!   cargo run --release --example harvest -- <rom> <out_dir> [--tag T] [--frames N] [--warmup W]
//!       [--stride S] [--seed X] [--chunk C] [--max-mb M]
//!
//! - frames (3600): frames played after the warm-up; warmup (600): frames mashing Start/A to get
//!   past title screens, not recorded.
//! - stride (1): record a consecutive pair of frames every S frames (1 = every frame).
//! - Frames whose picture equals the last recorded one are dropped (static screens).
//! - max-mb (0 = no limit): stop once the compressed output reaches this size.
//!
//! Output: `<tag>-NNNN.bin.z` (zlib stream of records) and `<tag>.json` (layout and counts).
//! Record = 16-byte header [emulated frame u32, trace frame u32, buttons u8
//! (bit 0-7: A B Select Start Right Left Up Down), cgb u8, 6 x 0] + meta + final + bg + win + obj +
//! info, integers LE, sizes in the JSON. Consecutive trace frame numbers form motion pairs.
//!
//! The output directory must not be inside a git repository: game-derived data never goes in one.

use std::fs::File;
use std::io::Write;
use std::path::{Path, PathBuf};

use flate2::write::ZlibEncoder;
use flate2::Compression;
use gb_core::gameboy::GameBoy;
use gb_core::interrupts::JOYPAD_BIT;
use gb_core::joypad::JoypadButton;
use gb_core::ppu::FRAMEBUFFER_SIZE;
use gb_core::trace::{FrameTrace, META_LEN, PIXELS};

const BUTTONS: [JoypadButton; 8] = [
    JoypadButton::A,
    JoypadButton::B,
    JoypadButton::Select,
    JoypadButton::Start,
    JoypadButton::Right,
    JoypadButton::Left,
    JoypadButton::Up,
    JoypadButton::Down,
];
const REC_HEADER: usize = 16;
const PLANES: [(&str, usize); 6] = [
    ("meta", META_LEN),
    ("final", FRAMEBUFFER_SIZE),
    ("bg", FRAMEBUFFER_SIZE),
    ("win", FRAMEBUFFER_SIZE),
    ("obj", FRAMEBUFFER_SIZE),
    ("info", PIXELS * 4),
];

struct Rng(u64);
impl Rng {
    fn next(&mut self) -> u64 {
        self.0 ^= self.0 << 13;
        self.0 ^= self.0 >> 7;
        self.0 ^= self.0 << 17;
        self.0
    }
    fn chance(&mut self, p: f64) -> bool {
        ((self.next() >> 11) as f64 / (1u64 << 53) as f64) < p
    }
    fn range(&mut self, lo: u32, hi: u32) -> u32 {
        lo + (self.next() % (hi - lo) as u64) as u32
    }
}

/// Held buttons as a bitmask (bit order of BUTTONS). Warm-up mashes Start/A; play holds a
/// random "intent" (a direction, A, B, rarely Start) for 8-40 frames.
struct Policy {
    rng: Rng,
    held: u8,
    until: u32,
}
impl Policy {
    fn buttons(&mut self, frame: u32, warmup: u32) -> u8 {
        if frame < warmup {
            return match frame % 60 {
                0..=4 => 1 << 3,
                30..=34 => 1 << 0,
                _ => 0,
            };
        }
        if frame >= self.until {
            let r = &mut self.rng;
            let mut b = 0u8;
            if r.chance(0.7) { b |= 1 << r.range(4, 8); }
            if r.chance(0.35) { b |= 1 << 0; }
            if r.chance(0.2) { b |= 1 << 1; }
            let start = r.chance(0.02);
            if start { b = 1 << 3; }
            self.held = b;
            self.until = frame + if start { 3 } else { r.range(8, 40) };
        }
        self.held
    }
}

fn arg<T: std::str::FromStr>(args: &[String], name: &str, default: T) -> T {
    args.iter()
        .position(|a| a == name)
        .map(|i| args.get(i + 1).and_then(|v| v.parse().ok()).unwrap_or_else(|| panic!("{name} needs a valid value")))
        .unwrap_or(default)
}

fn inside_git_repo(dir: &Path) -> Option<PathBuf> {
    let abs = std::path::absolute(dir).ok()?;
    abs.ancestors().find(|a| a.join(".git").exists()).map(Path::to_path_buf)
}

fn main() {
    let args: Vec<String> = std::env::args().skip(1).collect();
    if args.len() < 2 || args[0].starts_with("--") || args[1].starts_with("--") {
        eprintln!("usage: harvest <rom> <out_dir> [--tag T] [--frames N] [--warmup W] [--stride S] [--seed X] [--chunk C] [--max-mb M]");
        std::process::exit(2);
    }
    let out = PathBuf::from(&args[1]);
    if let Some(repo) = inside_git_repo(&out) {
        eprintln!("refusing to write inside the git repository {}", repo.display());
        std::process::exit(2);
    }
    let tag: String = arg(&args, "--tag", "harvest".to_string());
    assert!(tag.chars().all(|c| c.is_ascii_alphanumeric() || c == '-' || c == '_'), "--tag: letters, digits, - and _ only");
    let frames: u32 = arg(&args, "--frames", 3600);
    let warmup: u32 = arg(&args, "--warmup", 600);
    let stride: u32 = arg(&args, "--stride", 1).max(1);
    let seed: u64 = arg(&args, "--seed", 1);
    let chunk: usize = arg(&args, "--chunk", 256).max(1);
    let max_bytes: u64 = arg::<u64>(&args, "--max-mb", 0) * 1024 * 1024;

    let rom = std::fs::read(&args[0]).expect("cannot read ROM");
    let mut gb = GameBoy::new(rom).expect("cannot load ROM");
    gb.skip_boot_rom();
    gb.bus.ppu.set_tracing(true);
    std::fs::create_dir_all(&out).expect("cannot create output directory");

    let mut policy = Policy { rng: Rng(seed.wrapping_mul(0x9E37_79B9_7F4A_7C15) | 1), held: 0, until: 0 };
    let record_len = REC_HEADER + PLANES.iter().map(|p| p.1).sum::<usize>();
    let (mut recorded, mut chunks, mut written, mut last_final) = (0usize, Vec::<String>::new(), 0u64, Vec::new());
    let mut enc: Option<ZlibEncoder<File>> = None;
    let mut in_chunk = 0usize;

    for frame in 0..warmup + frames {
        let held = policy.buttons(frame, warmup);
        for (bit, &b) in BUTTONS.iter().enumerate() {
            let on = held & (1 << bit) != 0;
            if gb.bus.joypad.set_button(b, on) && on {
                gb.bus.interrupts.request(JOYPAD_BIT);
            }
        }
        match gb.run_to_vblank() {
            Ok(true) => {}
            Ok(false) => continue, // LCD off
            Err(e) => {
                eprintln!("emulator error at frame {frame}: {e}");
                break;
            }
        }
        if frame < warmup || (frame - warmup) % stride > 1 {
            continue;
        }
        let t = gb.bus.ppu.trace.as_ref().unwrap();
        let d: &FrameTrace = &t.done;
        if d.final_ == last_final {
            continue;
        }
        last_final.clone_from(&d.final_);

        let e = enc.get_or_insert_with(|| {
            let name = format!("{tag}-{:04}.bin.z", chunks.len());
            let f = File::create(out.join(&name)).expect("cannot create chunk");
            chunks.push(name);
            ZlibEncoder::new(f, Compression::new(6))
        });
        let mut header = [0u8; REC_HEADER];
        header[0..4].copy_from_slice(&frame.to_le_bytes());
        header[4..8].copy_from_slice(&t.frames.to_le_bytes());
        header[8] = held;
        header[9] = gb.cgb_mode as u8;
        for part in [&header[..], &d.meta, &d.final_, &d.bg, &d.win, &d.obj, &d.info] {
            e.write_all(part).expect("write failed");
        }
        recorded += 1;
        in_chunk += 1;
        if in_chunk == chunk {
            written += enc.take().unwrap().finish().unwrap().metadata().map_or(0, |m| m.len());
            in_chunk = 0;
            if max_bytes > 0 && written >= max_bytes {
                eprintln!("size limit reached");
                break;
            }
        }
    }
    if let Some(e) = enc.take() {
        written += e.finish().unwrap().metadata().map_or(0, |m| m.len());
    }

    let mut offsets = Vec::new();
    let mut off = REC_HEADER;
    for (name, len) in PLANES {
        offsets.push(format!("\"{name}\": [{off}, {len}]"));
        off += len;
    }
    let json = format!(
        "{{\n  \"format\": \"cartouche-trace\",\n  \"version\": {},\n  \"record_len\": {record_len},\n  \"header_len\": {REC_HEADER},\n  \"planes\": {{{}}},\n  \"cgb\": {},\n  \"frames_played\": {},\n  \"warmup\": {warmup},\n  \"stride\": {stride},\n  \"seed\": {seed},\n  \"records\": {recorded},\n  \"bytes\": {written},\n  \"chunks\": [{}]\n}}\n",
        gb_core::trace::VERSION,
        offsets.join(", "),
        gb.cgb_mode,
        warmup + frames,
        chunks.iter().map(|c| format!("\"{c}\"")).collect::<Vec<_>>().join(", "),
    );
    std::fs::write(out.join(format!("{tag}.json")), json).expect("cannot write index");
    println!(
        "{tag}: {recorded} records, {:.1} MB compressed ({:.1} KB/record, raw {:.1} KB)",
        written as f64 / 1048576.0,
        written as f64 / 1024.0 / recorded.max(1) as f64,
        record_len as f64 / 1024.0
    );
}
