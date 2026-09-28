//! CGB / cartridge behaviour checks on tiny synthetic ROMs (no external files needed).

use gb_core::gameboy::GameBoy;

/// 64 KB ROM that loops forever at $0100, with a valid header checksum.
fn rom(cgb_flag: u8, cart_type: u8, ram_size: u8) -> Vec<u8> {
    let mut r = vec![0u8; 0x10000];
    r[0x100..0x102].copy_from_slice(&[0x18, 0xFE]); // JR -2
    r[0x143] = cgb_flag;
    r[0x147] = cart_type;
    r[0x148] = 0x01; // 64 KB
    r[0x149] = ram_size;
    r[0x14D] = (0x134..=0x14C).fold(0u8, |c, i| c.wrapping_sub(r[i]).wrapping_sub(1));
    r
}

fn cgb() -> GameBoy {
    GameBoy::new(rom(0xC0, 0x1B, 0x03)).unwrap()
}

#[test]
fn cgb_cart_starts_in_cgb_post_boot_state() {
    let gb = cgb();
    assert!(gb.cgb_mode && gb.bus.ppu.cgb_mode);
    assert!(!gb.bus.boot_rom_active, "DMG boot ROM would hand over with A=$01");
    assert_eq!(gb.cpu.regs.a, 0x11, "A=$11 tells software it runs on a CGB");
    assert_eq!(gb.cpu.regs.pc, 0x0100);
    assert!(gb.bus.ppu.bg_cram.chunks(2).all(|c| c == [0xFF, 0x7F]), "BG palettes start white");
}

#[test]
fn dmg_cart_still_runs_the_boot_rom() {
    let gb = GameBoy::new(rom(0x00, 0x00, 0x00)).unwrap();
    assert!(!gb.cgb_mode);
    assert!(gb.bus.boot_rom_active);
}

#[test]
fn hdma_cancel_then_restart_resumes_from_counters() {
    let mut gb = cgb();
    let bus = &mut gb.bus;
    for i in 0..0x40u16 {
        bus.write_byte(0xC000 + i, i as u8 ^ 0xA5);
    }
    bus.write_byte(0xFF40, 0x00); // LCD off: the PPU sits in mode 0
    bus.write_byte(0xFF51, 0xC0);
    bus.write_byte(0xFF52, 0x00);
    bus.write_byte(0xFF53, 0x00);
    bus.write_byte(0xFF54, 0x00);

    bus.write_byte(0xFF55, 0x83); // HBlank DMA, 4 blocks: first block goes at once (mode 0)
    assert_eq!(bus.read_byte(0xFF55), 0x02, "active: bit 7 clear, 3 blocks left -> 2");
    bus.write_byte(0xFF55, 0x00); // cancel
    assert_eq!(bus.read_byte(0xFF55), 0x80, "cancelled: bit 7 set, the length bits are the written ones (SameSuite hdma_lcd_off)");

    bus.write_byte(0xFF55, 0x02); // GDMA 3 blocks, HDMA1-4 NOT rewritten: must continue at $C010
    assert_eq!(bus.read_byte(0xFF55), 0xFF);
    for i in 0..0x40u16 {
        assert_eq!(bus.read_byte(0x8000 + i), i as u8 ^ 0xA5, "VRAM byte {i:#x}");
    }
}

#[test]
fn mbc5_ram_bank_wraps_to_fitted_ram() {
    let mut gb = cgb(); // MBC5+RAM+BATTERY, 32 KB = 4 banks
    let bus = &mut gb.bus;
    bus.write_byte(0x0000, 0x0A);
    bus.write_byte(0x4000, 0x04); // bank 4 mirrors bank 0
    bus.write_byte(0xA123, 0x5A);
    bus.write_byte(0x4000, 0x00);
    assert_eq!(bus.read_byte(0xA123), 0x5A);
}

#[test]
fn mbc5_rumble_bit_does_not_select_ram() {
    let mut gb = GameBoy::new(rom(0xC0, 0x1E, 0x03)).unwrap();
    let bus = &mut gb.bus;
    bus.write_byte(0x0000, 0x0A);
    bus.write_byte(0x4000, 0x01);
    bus.write_byte(0xA000, 0x11);
    bus.write_byte(0x4000, 0x09); // motor on, still bank 1
    assert_eq!(bus.read_byte(0xA000), 0x11);
}

#[test]
fn mbc3_rtc_cart_runs_natively() {
    let mut gb = GameBoy::new(rom(0x80, 0x10, 0x03)).unwrap();
    let bus = &mut gb.bus;
    bus.write_byte(0x0000, 0x0A);
    bus.write_byte(0x4000, 0x08); // RTC seconds
    bus.write_byte(0xA000, 42);
    bus.write_byte(0x6000, 0x00);
    bus.write_byte(0x6000, 0x01); // latch
    assert!((42..45).contains(&bus.read_byte(0xA000)));
}

#[test]
fn save_state_keeps_cgb_palettes() {
    let mut gb = cgb();
    gb.bus.write_byte(0xFF6A, 0x80);
    gb.bus.write_byte(0xFF6B, 0x1F);
    gb.bus.write_byte(0xFF68, 0x82);
    gb.bus.write_byte(0xFF69, 0x34);
    let state = gb.save_state();
    let mut other = cgb();
    assert!(other.load_state(&state));
    assert_eq!(other.bus.ppu.obj_cram, gb.bus.ppu.obj_cram);
    assert_eq!(other.bus.ppu.bg_cram, gb.bus.ppu.bg_cram);
    assert_eq!((other.bus.ppu.bcps, other.bus.ppu.ocps), (0x83, 0x81));
}

/// Runs `rom` with scripted input and saves every 150 frames; each state is loaded into a
/// freshly booted GameBoy (as save slots and "resume" do) and must reproduce the next frames
/// of the uninterrupted run exactly.
/// Hashing save_state() covers CPU, memory, PPU registers and SRAM.
fn assert_state_roundtrip(rom: &[u8]) {
    use gb_core::joypad::JoypadButton;
    use std::hash::{DefaultHasher, Hash, Hasher};
    const FRAMES: u32 = 1800;
    const AFTER: u32 = 90;
    fn input(gb: &mut GameBoy, frame: u32) {
        let b = [JoypadButton::Start, JoypadButton::A, JoypadButton::Right, JoypadButton::A];
        gb.bus.joypad.set_button(b[(frame / 40 % 4) as usize], frame % 40 < 4);
    }
    // The whole machine state, not the picture: the framebuffer is not part of a state, so
    // lines not redrawn since loading (LCD off, first partial frame) legitimately differ.
    fn hash(gb: &GameBoy) -> u64 {
        let mut h = DefaultHasher::new();
        gb.save_state().hash(&mut h);
        h.finish()
    }
    let fresh = || {
        let mut gb = GameBoy::new(rom.to_vec()).unwrap();
        gb.skip_boot_rom();
        gb
    };
    let mut truth = fresh();
    let (mut hashes, mut states) = (Vec::new(), Vec::new());
    for frame in 0..FRAMES + AFTER {
        input(&mut truth, frame);
        truth.run_frame().unwrap();
        hashes.push(hash(&truth));
        if frame % 150 == 149 && frame < FRAMES {
            states.push((frame, truth.save_state()));
        }
    }
    for (frame, state) in states {
        let mut gb = fresh();
        assert!(gb.load_state(&state), "load state of frame {frame}");
        for f in frame + 1..=frame + AFTER {
            input(&mut gb, f);
            gb.run_frame().unwrap_or_else(|e| panic!("state of frame {frame}: {e}"));
            assert_eq!(hash(&gb), hashes[f as usize], "state saved at frame {frame} diverges at frame {f}");
        }
    }
}

#[test]
fn save_state_restores_mbc1_banks() {
    // Tobu Tobu Girl (MBC1, MIT + CC BY 4.0) ships with the web app.
    let rom = std::fs::read(concat!(env!("CARGO_MANIFEST_DIR"), "/../gb-web/public/roms/tobutobugirl.gb")).unwrap();
    assert_state_roundtrip(&rom);
}

#[test]
fn save_state_restores_mbc5_banks() {
    // Aevilia (MBC5, Apache-2.0), downloaded by scripts/fetch-test-roms.sh.
    let path = concat!(env!("CARGO_MANIFEST_DIR"), "/test-roms/homebrew/aevilia.gbc");
    let Ok(rom) = std::fs::read(path) else {
        assert!(std::env::var_os("CARTOUCHE_REQUIRE_ROMS").is_none(), "{path} not found");
        eprintln!("skipped: {path} not found");
        return;
    };
    assert_state_roundtrip(&rom);
}

#[test]
fn retroachievements_memory_map_reads_every_bank() {
    let mut gb = cgb(); // MBC5, 32 KB of cartridge RAM (4 banks)
    gb.bus.write_byte(0xFF70, 3); // work RAM bank 3 paged in at $D000
    gb.bus.write_byte(0xD000, 0x33);
    gb.bus.write_byte(0xFF70, 1);
    gb.bus.write_byte(0xD000, 0x11);
    gb.bus.write_byte(0x0000, 0x0A); // cartridge RAM on
    gb.bus.write_byte(0x4000, 2);
    gb.bus.write_byte(0xA005, 0x22);
    gb.bus.write_byte(0x4000, 0);
    gb.bus.write_byte(0xA005, 0x20);
    gb.bus.write_byte(0x4000, 2); // bank 2 paged in: $A000 still reads bank 0
    gb.bus.write_byte(0xFF70, 3);
    assert_eq!(gb.bus.read_ra(0xD000), 0x11, "$D000 is bank 1 whatever is paged in");
    assert_eq!(gb.bus.read_ra(0x10000 + 0x1000), 0x33, "bank 3 at $11000");
    assert_eq!(gb.bus.read_ra(0xA005), 0x20, "$A000 is cartridge RAM bank 0");
    assert_eq!(gb.bus.read_ra(0x16000 + 0x2000 + 5), 0x22, "cartridge bank 2 at $18000");
    assert_eq!(gb.bus.read_ra(0x40000), 0);
}
