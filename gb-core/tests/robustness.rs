//! OAM DMA bus conflicts and save-state loading, on tiny synthetic ROMs (no external files).

use gb_core::gameboy::GameBoy;
use gb_core::joypad::JoypadButton;

/// 32 KB DMG ROM with `code` at $0100 and `sub` at $0200, valid header checksum.
fn rom(code: &[u8], sub: &[u8]) -> Vec<u8> {
    let mut r = vec![0u8; 0x8000];
    r[0x100..0x100 + code.len()].copy_from_slice(code);
    r[0x200..0x200 + sub.len()].copy_from_slice(sub);
    r[0x14D] = (0x134..=0x14C).fold(0u8, |c, i| c.wrapping_sub(r[i]).wrapping_sub(1));
    r
}

fn boot(code: &[u8], sub: &[u8]) -> GameBoy {
    let mut gb = GameBoy::new(rom(code, sub)).unwrap();
    gb.skip_boot_rom();
    gb
}

/// LD A,page; LDH ($46),A; CALL $0200; JR -2 — the subroutine loads B with $42.
fn dma_then_call(page: u8) -> GameBoy {
    let mut gb = boot(&[0x3E, page, 0xE0, 0x46, 0xCD, 0x00, 0x02, 0x18, 0xFE], &[0x06, 0x42, 0xC9]);
    gb.cpu.regs.b = 0;
    for _ in 0..5 { gb.step_instruction().unwrap(); }
    gb
}

#[test]
fn dma_from_vram_leaves_rom_fetches_alone() {
    let gb = dma_then_call(0x80);
    assert_eq!(gb.cpu.regs.b, 0x42, "the CALL right after the DMA start ran");
    assert_eq!(gb.cpu.regs.pc, 0x0107);
}

#[test]
fn dma_conflicts_only_on_its_own_bus() {
    let mut gb = boot(&[0x18, 0xFE], &[]);
    gb.bus.write_byte(0xFF46, 0x80); // from VRAM
    assert_ne!(gb.bus.read_byte(0x0100), 0xFF, "ROM is on the other bus");
    assert_eq!(gb.bus.read_byte(0x8000), 0xFF, "VRAM is busy");
    assert_eq!(gb.bus.read_byte(0xFE00), 0xFF, "OAM is busy");
    gb.bus.write_byte(0xFF46, 0xC0); // from WRAM
    assert_eq!(gb.bus.read_byte(0x0100), 0xFF, "ROM shares the external bus");
    gb.bus.write_byte(0xFF80, 0x5A);
    assert_eq!(gb.bus.read_byte(0xFF80), 0x5A, "HRAM stays reachable");
}

#[test]
fn a_color_dma_from_wram_leaves_rom_fetches_alone() {
    let mut r = rom(&[0x3E, 0xC0, 0xE0, 0x46, 0xCD, 0x00, 0x02, 0x18, 0xFE], &[0x06, 0x42, 0xC9]);
    r[0x143] = 0xC0; // Game Boy Color only
    r[0x14D] = (0x134..=0x14C).fold(0u8, |c, i| c.wrapping_sub(r[i]).wrapping_sub(1));
    let mut gb = GameBoy::new(r).unwrap();
    gb.skip_boot_rom();
    gb.cpu.regs.b = 0;
    for _ in 0..5 { gb.step_instruction().unwrap(); }
    assert_eq!(gb.cpu.regs.b, 0x42, "WRAM has its own bus on a Color");
    gb.bus.write_byte(0xFF46, 0xC0);
    assert_eq!(gb.bus.read_byte(0xC000), 0xFF, "WRAM is busy");
    assert_ne!(gb.bus.read_byte(0x0100), 0xFF);
}

#[test]
fn a_state_load_keeps_the_live_buttons() {
    let mut gb = boot(&[0x18, 0xFE], &[]);
    gb.bus.joypad.set_button(JoypadButton::Right, true);
    let held = gb.save_state();
    gb.bus.joypad.set_button(JoypadButton::Right, false);
    let none = gb.save_state();

    assert!(gb.load_state(&held));
    assert_eq!(gb.bus.joypad.dpad_state, 0x0F, "Right was released after the save");
    gb.bus.joypad.set_button(JoypadButton::Right, true);
    assert!(gb.load_state(&none));
    assert_eq!(gb.bus.joypad.dpad_state, 0x0E, "Right is still held");
}

#[test]
fn a_refused_state_leaves_the_machine_untouched() {
    let mut r = rom(&[0x18, 0xFE], &[]);
    r[0x147] = 0x03; // MBC1+RAM+BATTERY
    r[0x149] = 0x02; // 8 KB
    r[0x14D] = (0x134..=0x14C).fold(0u8, |c, i| c.wrapping_sub(r[i]).wrapping_sub(1));
    let mut gb = GameBoy::new(r).unwrap();
    gb.skip_boot_rom();
    let old = gb.save_state();
    gb.bus.cartridge.import_sram(&[0x5A; 0x2000]);
    gb.bus.wram[0] = 0xA5;
    let (sram, now) = (gb.bus.cartridge.export_sram(), gb.save_state());

    assert!(!gb.load_state(&old[..old.len() - 40]), "cut short in the APU fields");
    assert_eq!(gb.bus.cartridge.export_sram(), sram, "battery save kept");
    assert_eq!(gb.save_state(), now, "whole machine kept");
    assert!(gb.load_state(&old));
    assert_ne!(gb.bus.cartridge.export_sram(), sram, "a whole state still loads");
}

/// Changes each scalar byte of a valid state (bulk RAM skipped), loads it and runs: a damaged
/// state is refused or clamped, never a panic.
#[test]
fn a_damaged_state_never_panics() {
    // Sound on with every channel triggered, then a loop that reads switchable WRAM.
    let mut code = vec![0x3E, 0x80, 0xE0, 0x26];
    for (reg, v) in [(0x12u8, 0xF0u8), (0x14, 0x80), (0x17, 0xF0), (0x19, 0x80), (0x1A, 0x80), (0x1C, 0x20), (0x1E, 0x80), (0x21, 0xF0), (0x23, 0x80)] {
        code.extend_from_slice(&[0x3E, v, 0xE0, reg]);
    }
    code.extend_from_slice(&[0xFA, 0x00, 0xD0, 0xEA, 0x01, 0xD0, 0x18, (-8i8) as u8]); // LD A,(D000); LD (D001),A; JR loop
    let r = rom(&code, &[]);
    let fresh = || { let mut gb = GameBoy::new(r.clone()).unwrap(); gb.skip_boot_rom(); gb };
    let mut gb = fresh();
    for _ in 0..10 { gb.run_frame().unwrap(); }
    let st = gb.save_state();
    // Layout: header + CPU/timer (32), WRAM, wram_bank, HRAM + VRAM, vram_bank, OAM, rest.
    let (wram_bank, vram_bank, oam_end) = (32 + 0x8000, 32 + 0x8000 + 1 + 0x7F + 0x4000, 32 + 0x8000 + 1 + 0x7F + 0x4000 + 1 + 0xA0);
    let offsets = (0..32).chain([wram_bank, vram_bank]).chain(oam_end..st.len());
    let mut bad = Vec::new();
    for i in offsets {
        for v in [0xFFu8, 0x80, 0x07] {
            let mut s = st.clone();
            s[i] = v;
            let ok = std::panic::catch_unwind(std::panic::AssertUnwindSafe(|| {
                let mut g = fresh();
                if g.load_state(&s) { for _ in 0..2 { let _ = g.run_frame(); } }
            }));
            if ok.is_err() { bad.push((i, v)); }
        }
    }
    assert!(bad.is_empty(), "panicking (offset, value): {bad:?}");
}
