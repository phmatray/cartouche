//! An original Game Boy cartridge on a Game Boy Color (compatibility mode), with SameBoy's
//! boot ROM choosing its colours. Synthetic ROM only: no external files needed.

use gb_core::gameboy::{Console, GameBoy};

/// 32 KB DMG-only ROM that loops at $0100, unknown licensee, valid header checksum.
fn dmg_rom(title: &[u8]) -> Vec<u8> {
    let mut r = vec![0u8; 0x8000];
    r[0x100..0x104].copy_from_slice(&[0x00, 0x18, 0xFE, 0x00]); // NOP; JR -2
    r[0x134..0x134 + title.len()].copy_from_slice(title);
    r[0x14D] = (0x134..=0x14C).fold(0u8, |c, i| c.wrapping_sub(r[i]).wrapping_sub(1));
    r
}

fn rgb(cram: &[u8], pal: usize, id: usize) -> [u8; 4] {
    let v = u16::from_le_bytes([cram[pal * 8 + id * 2], cram[pal * 8 + id * 2 + 1]]);
    let c = |s: u16| ((s & 0x1F) * 255 / 31) as u8;
    [c(v), c(v >> 5), c(v >> 10), 0xFF]
}

fn colourised(palette: u8) -> GameBoy {
    let gb = GameBoy::with_boot(dmg_rom(b"CARTOUCHE"), true, palette, false).unwrap();
    assert!(!gb.bus.boot_rom_active, "the boot ROM ran to its end");
    gb
}

#[test]
fn boot_rom_hands_over_in_compatibility_mode() {
    let gb = colourised(0);
    assert_eq!(gb.console, Console::Compat);
    assert!(gb.in_colour() && gb.bus.ppu.compat && !gb.bus.cgb_mode && !gb.bus.ppu.cgb_mode);
    assert!((0x100..0x104).contains(&gb.cpu.regs.pc), "in the cartridge's loop");
    assert_eq!(gb.cpu.regs.a, 0x11, "a CGB, even in compatibility mode");
    assert_eq!(gb.bus.joypad.boot_hold, [0, 0], "the held combination is released");
}

#[test]
fn cgb_registers_lock_after_the_boot_rom() {
    let mut gb = colourised(0);
    let cram = gb.bus.ppu.bg_cram;
    gb.bus.write_byte(0xFF68, 0x80);
    gb.bus.write_byte(0xFF69, 0x12);
    gb.bus.write_byte(0xFF4F, 0x01);
    gb.bus.write_byte(0xFF70, 0x03);
    assert_eq!(gb.bus.ppu.bg_cram, cram);
    assert_eq!(gb.bus.ppu.vram_bank, 0);
    assert_eq!(gb.bus.wram_bank, 1);
    assert_eq!(gb.bus.read_byte(0xFF4D), 0xFF, "no KEY1");
}

#[test]
fn bgp_picks_from_bg_palette_zero() {
    let mut gb = colourised(0);
    let b = &mut gb.bus;
    for i in 0..16 { b.write_byte(0x8000 + i, 0xFF); } // tile 0: colour 3 everywhere
    for i in 0..0x400 { b.write_byte(0x9800 + i, 0); }
    b.write_byte(0xFF42, 0);
    b.write_byte(0xFF43, 0);
    b.write_byte(0xFF40, 0x91);
    for (bgp, shade) in [(0xE4u8, 3usize), (0x3F, 0), (0x80, 2)] {
        gb.bus.write_byte(0xFF47, bgp);
        gb.run_frame().unwrap();
        gb.run_frame().unwrap();
        let want = rgb(&gb.bus.ppu.bg_cram, 0, shade);
        assert_eq!(gb.bus.ppu.framebuffer[0..4], want, "BGP {bgp:#04x}");
    }
}

#[test]
fn a_held_combination_picks_another_palette() {
    let auto = colourised(0).bus.ppu.bg_cram;
    let picks: Vec<_> = (1..=12).map(|p| colourised(p).bus.ppu.bg_cram).collect();
    assert!(picks.iter().any(|p| *p != auto));
    let distinct = picks.iter().enumerate().filter(|(i, p)| !picks[..*i].contains(p)).count();
    assert!(distinct >= 10, "the 12 combinations give (nearly) 12 palettes, got {distinct}");
}

#[test]
fn states_stay_on_their_console() {
    let rom = dmg_rom(b"CARTOUCHE");
    let mut dmg = GameBoy::with_boot(rom.clone(), false, 0, false).unwrap();
    let mut gbc = colourised(0);
    let (from_dmg, from_gbc) = (dmg.save_state(), gbc.save_state());
    assert_eq!(gbc.state_console(&from_dmg), Some(Console::Dmg));
    assert!(!gbc.load_state(&from_dmg), "a DMG state never loads on the colourised console");
    assert!(!dmg.load_state(&from_gbc));
    assert!(gbc.load_state(&from_gbc) && gbc.bus.ppu.compat);
    assert!(dmg.load_state(&from_dmg) && !dmg.bus.ppu.compat);
}

#[test]
fn animation_plays_then_hands_over() {
    let mut gb = GameBoy::with_boot(dmg_rom(b"CARTOUCHE"), true, 0, true).unwrap();
    assert!(gb.bus.boot_rom_active && gb.bus.cgb_mode);
    let (mut frames, mut loudest) = (0, 0f32);
    while gb.bus.boot_rom_active {
        gb.run_frame().unwrap();
        let n = gb.bus.apu.buffer_len();
        let s = unsafe { std::slice::from_raw_parts(gb.bus.apu.buffer_ptr(), n) };
        loudest = s.iter().fold(loudest, |m, v| m.max(v.abs()));
        gb.bus.apu.clear_samples();
        frames += 1;
        assert!(frames < 600, "boot ROM never finished");
    }
    assert!(gb.bus.ppu.compat);
    assert!(loudest > 0.05, "the start-up chime plays ({loudest})");
    // DMG boot ROM too, on the DMG.
    let mut dmg = GameBoy::with_boot(dmg_rom(b"CARTOUCHE"), false, 0, true).unwrap();
    for _ in 0..600 {
        if !dmg.bus.boot_rom_active { break; }
        dmg.run_frame().unwrap();
    }
    assert!(!dmg.bus.boot_rom_active && !dmg.in_colour());
    assert_eq!(dmg.cpu.regs.a, 0x01);
}
