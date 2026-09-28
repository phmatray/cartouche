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
    for _ in 0..2 { gb.bus.cycle_tick(); } // start-up M-cycle, then the first byte
    assert_ne!(gb.bus.read_byte(0x0100), 0xFF, "ROM is on the other bus");
    assert_eq!(gb.bus.read_byte(0x8000), 0xFF, "VRAM is busy");
    assert_eq!(gb.bus.read_byte(0xFE00), 0xFF, "OAM is busy");
    gb.bus.write_byte(0xFF46, 0xC0); // from WRAM
    for _ in 0..2 { gb.bus.cycle_tick(); }
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

/// A held button whose group gets selected pulls its P1 line low: the joypad interrupt fires, as
/// for a press (Pan Docs, "Joypad interrupt"). A group with nothing held does not.
#[test]
fn selecting_a_group_with_a_held_button_requests_the_joypad_interrupt() {
    let mut gb = boot(&[0x18, 0xFE], &[]);
    gb.bus.write_byte(0xFF00, 0x30); // nothing selected
    gb.bus.joypad.set_button(JoypadButton::Start, true);
    gb.bus.interrupts.interrupt_flag = 0;
    gb.bus.write_byte(0xFF00, 0x20); // d-pad: nothing held there
    assert_eq!(gb.bus.interrupts.interrupt_flag & 0x10, 0);
    gb.bus.write_byte(0xFF00, 0x10); // buttons: Start is held
    assert_eq!(gb.bus.interrupts.interrupt_flag & 0x10, 0x10);
}

/// SC ($FF02): bits 2-6 read 1, and the fast clock (bit 1) is a Color-mode feature: a DMG ignores
/// it, reads it as 1, and shifts at 8192 Hz (8 x 512 cycles a byte), not 32 times faster.
#[test]
fn a_dmg_has_no_fast_serial_clock_and_sc_reads_its_unused_bits_as_1() {
    let mut gb = boot(&[0x18, 0xFE], &[]);
    gb.bus.write_byte(0xFF02, 0x83);
    assert_eq!(gb.bus.read_byte(0xFF02), 0xFF);
    for _ in 0..(8 * 16 / 4) { gb.bus.cycle_tick(); }
    assert_eq!(gb.bus.read_byte(0xFF02) & 0x80, 0x80, "still shifting after 128 cycles");
    for _ in 0..(8 * 512 / 4) { gb.bus.cycle_tick(); }
    assert_eq!(gb.bus.read_byte(0xFF02), 0x7F, "done after 4096");
}

fn run_to_line(gb: &mut GameBoy, ly: u8) {
    while gb.bus.ppu.ly != ly { gb.step_instruction().unwrap(); }
}

/// States are taken mid-frame and do not hold the picture being drawn: after a load, the rows the
/// next frame drew before the save point show the thumbnail the player puts back, not blank ones.
#[test]
fn the_first_frame_after_a_load_continues_the_thumbnail() {
    let mut gb = boot(&[0x18, 0xFE], &[]);
    gb.run_frame().unwrap();
    run_to_line(&mut gb, 60);
    let state = gb.save_state();

    let mut fresh = boot(&[0x18, 0xFE], &[]);
    assert!(fresh.load_state(&state));
    let thumb: Vec<u8> = [9, 9, 9, 0xFF].repeat(160 * 144);
    fresh.set_screen(&thumb);
    assert_eq!(fresh.screen(), &thumb[..], "shown at once");
    run_to_line(&mut fresh, 144);
    let row = |y: usize| &fresh.screen()[y * 640..y * 640 + 4];
    assert_eq!(row(0), [9, 9, 9, 0xFF], "drawn before the save point");
    assert_ne!(row(100), [9, 9, 9, 0xFF], "drawn after the load");
}

/// LD A,$10 (select the buttons); LDH ($00),A; STOP; INC B; JR -2.
const STOP: [u8; 9] = [0x3E, 0x10, 0xE0, 0x00, 0x10, 0x00, 0x04, 0x18, 0xFE];

/// STOP halts the CPU and LCD (blank screen, DIV reset) until the web side presses a selected
/// button; a save state keeps it stopped, and an older state (no tail) loads as not stopped.
#[test]
fn stop_mode_waits_for_a_button_from_the_web_side() {
    let mut emu = gb_core::Emulator::new();
    assert!(emu.load_rom(&rom(&STOP, &[])));
    for _ in 0..3 { emu.step(); }
    for _ in 0..3 { assert!(emu.run_frame()); }
    assert_eq!((emu.get_pc(), emu.get_bc() >> 8), (0x0106, 0), "stopped after the 2-byte STOP");
    assert_eq!(emu.read_memory(0xFF04), 0, "DIV reset and frozen");
    let white = gb_core::ppu::PALETTE_COLORS[0];
    assert!(emu.framebuffer_snapshot().chunks(4).all(|p| p == white), "LCD blank");

    let state = emu.save_state();
    let mut old = gb_core::Emulator::new();
    assert!(old.load_rom(&rom(&STOP, &[])));
    // Cut the tail: stop mode and KEY0, the (empty) mapper block's u16 length, the timing bytes.
    assert!(old.load_state(&state[..state.len() - 8]));
    old.run_frame();
    assert_ne!(old.get_pc(), 0x0106, "an older state is not in stop mode");
    assert!(emu.load_state(&state));

    emu.press_button(JoypadButton::Right); // the d-pad is not selected: still stopped
    emu.run_frame();
    assert_eq!(emu.get_pc(), 0x0106);
    emu.press_button(JoypadButton::A);
    emu.run_frame();
    assert_eq!(emu.get_bc() >> 8, 1, "woken by A");
}

/// With a selected button already held, STOP enters no stop mode (Pan Docs): DIV is kept.
#[test]
fn stop_with_a_button_held_does_not_stop() {
    let mut gb = boot(&STOP, &[]);
    gb.bus.joypad.set_button(JoypadButton::A, true);
    for _ in 0..3 { gb.step_instruction().unwrap(); }
    assert!(!gb.cpu.stopped && gb.cpu.halted, "HALT instead, nothing pending");
    assert_ne!(gb.bus.read_byte(0xFF04), 0);
}
