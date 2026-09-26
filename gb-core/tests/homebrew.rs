//! Smoke tests on freely licensed homebrew (downloaded into test-roms/homebrew/, gitignored).
//! Each ROM runs for a while with scripted button presses; it must not raise an emulator error
//! and the picture must keep changing (not frozen). `scripts/fetch-test-roms.sh` downloads them
//! (pinned URLs, SHA-256 checked). A missing ROM skips its test, unless CARTOUCHE_REQUIRE_ROMS is
//! set (as in CI), in which case it fails.
//!
//! Download them with scripts/fetch-test-roms.sh. Titles, authors, licences and sources are
//! listed in THIRD_PARTY_NOTICES.md (section 3, "Homebrew smoke-test ROMs").

use std::collections::HashSet;
use std::hash::{DefaultHasher, Hash, Hasher};
use std::path::Path;

use gb_core::gameboy::GameBoy;
use gb_core::interrupts::JOYPAD_BIT;
use gb_core::joypad::JoypadButton;

const FRAMES: u32 = 1500;

fn smoke(file: &str, expect_cgb: bool) {
    smoke_at("test-roms/homebrew", file, expect_cgb);
}

fn smoke_at(dir: &str, file: &str, expect_cgb: bool) {
    let path = Path::new(env!("CARGO_MANIFEST_DIR")).join(dir).join(file);
    let Ok(rom) = std::fs::read(&path) else {
        assert!(std::env::var_os("CARTOUCHE_REQUIRE_ROMS").is_none(), "{} not found", path.display());
        eprintln!("skipped: {} not found", path.display());
        return;
    };
    let mut gb = GameBoy::new(rom).expect("load ROM");
    // Same start-up as the web app (Emulator::load_rom): no boot ROM runs.
    gb.skip_boot_rom();
    assert_eq!(gb.cgb_mode, expect_cgb, "{file}: CGB mode");

    // Mash through title screens and dialogs: Start and A alternately, each held 5 frames.
    let mut frames_seen = HashSet::new();
    for frame in 0..FRAMES {
        let button = match frame % 120 {
            60 => Some(JoypadButton::Start),
            0 if frame > 0 => Some(JoypadButton::A),
            _ => None,
        };
        if let Some(b) = button {
            if gb.bus.joypad.set_button(b, true) {
                gb.bus.interrupts.request(JOYPAD_BIT);
            }
        }
        if frame % 60 == 5 {
            gb.bus.joypad.set_button(JoypadButton::Start, false);
            gb.bus.joypad.set_button(JoypadButton::A, false);
        }
        gb.run_frame().unwrap_or_else(|e| panic!("{file}: emulator error at frame {frame}: {e}"));
        if frame % 50 == 49 {
            let mut h = DefaultHasher::new();
            gb.bus.ppu.framebuffer.hash(&mut h);
            frames_seen.insert(h.finish());
        }
    }
    assert!(frames_seen.len() >= 4, "{file}: only {} distinct frames in {FRAMES} frames (frozen?)", frames_seen.len());
}

#[test]
fn ucity() { smoke("ucity.gbc", true); }
#[test]
fn ucity_compat() { smoke("ucity_compat.gbc", true); }
#[test]
fn geometrix() { smoke("geometrix.gbc", true); }
#[test]
fn aevilia() { smoke("aevilia.gbc", true); }
#[test]
fn catmario() { smoke("catmario-gb.gbc", true); }
#[test]
fn a_slime_travel() { smoke("aslimetravel.gbc", true); }
#[test]
fn gbhack() { smoke("gbhack.gbc", true); }
#[test]
fn labirinth() { smoke("labirinth.gbc", true); }
#[test]
fn gb240p() { smoke("gb240p.gb", true); }
#[test]
fn shock_lobster() { smoke("shock-lobster/shocklobster.gb", false); }

// The games bundled with the web app (gb-web/public/roms, tracked in git, so never skipped).
// The bundled test cartridges are checked in acid2.rs and blargg.rs.
#[test]
fn bundled_tobutobugirl() { smoke_at("../gb-web/public/roms", "tobutobugirl.gb", false); }
#[test]
fn bundled_tobutobugirldx() { smoke_at("../gb-web/public/roms", "tobutobugirldx.gb", true); }
#[test]
fn bundled_ucity() { smoke_at("../gb-web/public/roms", "ucity.gbc", true); }
