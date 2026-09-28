use gb_core::gameboy::GameBoy;

/// A 32 KB NoMBC image with `program` at $0100 (as in cpu_tests.rs).
fn rom(program: &[u8]) -> Vec<u8> {
    let mut rom = vec![0u8; 0x8000];
    rom[0x0100..0x0100 + program.len()].copy_from_slice(program);
    let mut checksum: u8 = 0;
    for addr in 0x0134..=0x014C {
        checksum = checksum.wrapping_sub(rom[addr]).wrapping_sub(1);
    }
    rom[0x014D] = checksum;
    rom
}

/// $0100: NOP; $0101: INC A; $0102: JR -3 (back to $0101).
const LOOP: [u8; 4] = [0x00, 0x3C, 0x18, 0xFD];

fn gameboy() -> GameBoy {
    let mut gb = GameBoy::new(rom(&LOOP)).unwrap();
    gb.skip_boot_rom();
    gb
}

#[test]
fn breakpoint_stops_run_frame_at_its_address() {
    let mut gb = gameboy();
    gb.debugger_mut().breakpoints.insert(0x0101);
    gb.run_frame().unwrap();
    assert_eq!(gb.cpu.regs.pc, 0x0101);
    assert_eq!(gb.take_break().unwrap().describe(), "breakpoint $0101");
    assert!(gb.take_break().is_none(), "the break is taken once");
}

#[test]
fn continuing_runs_the_breakpoint_instruction_once_before_stopping_again() {
    let mut gb = gameboy();
    gb.debugger_mut().breakpoints.insert(0x0101);
    gb.run_frame().unwrap();
    let a = gb.cpu.regs.a;
    gb.take_break();
    gb.run_frame().unwrap();
    assert_eq!(gb.cpu.regs.pc, 0x0101);
    assert_eq!(gb.cpu.regs.a, a.wrapping_add(1), "one trip round the loop");
    assert_eq!(gb.take_break().unwrap().describe(), "breakpoint $0101");
}

#[test]
fn a_broken_frame_runs_as_many_cycles_as_an_unbroken_one() {
    let mut plain = gameboy();
    plain.run_frame().unwrap();

    let mut gb = gameboy();
    gb.debugger_mut().breakpoints.insert(0x0101);
    gb.run_frame().unwrap(); // stops after the NOP, mid-frame
    gb.debugger_mut().breakpoints.clear();
    gb.run_frame().unwrap(); // finishes that frame
    assert!(gb.take_break().is_some());
    assert!(gb.take_break().is_none());
    assert_eq!(gb.cpu.regs.pc, plain.cpu.regs.pc);
    assert_eq!(gb.cpu.regs.a, plain.cpu.regs.a);
}

#[test]
fn step_frame_stops_at_the_next_vblank() {
    let mut gb = gameboy();
    gb.step_frame().unwrap();
    assert_eq!(gb.take_break().unwrap().describe(), "frame");
    assert!(gb.bus.ppu.frame_ready);
}

#[test]
fn emulator_reports_a_breakpoint_once_and_clears() {
    let mut emu = gb_core::Emulator::new();
    assert!(emu.load_rom(&rom(&LOOP)));
    emu.debug_add_breakpoint(0x0101);
    assert!(emu.run_frame());
    assert_eq!(emu.debug_break_reason().as_deref(), Some("breakpoint $0101"));
    assert_eq!(emu.get_pc(), 0x0101);
    assert_eq!(emu.debug_break_reason(), None);

    emu.debug_remove_breakpoint(0x0101);
    emu.debug_add_breakpoint(0x0102);
    emu.debug_clear();
    assert!(emu.run_frame());
    assert_eq!(emu.debug_break_reason(), None);

    assert!(emu.debug_step_frame());
    assert_eq!(emu.debug_break_reason().as_deref(), Some("frame"));
}

/// $0100: CALL $0110; $0103: NOP ... $0110: INC B; RET.
fn call_rom() -> Vec<u8> {
    let mut program = vec![0u8; 0x12];
    program[..4].copy_from_slice(&[0xCD, 0x10, 0x01, 0x00]);
    program[0x10..].copy_from_slice(&[0x04, 0xC9]);
    rom(&program)
}

#[test]
fn step_over_runs_a_call_to_its_return() {
    let mut gb = GameBoy::new(call_rom()).unwrap();
    gb.skip_boot_rom();
    let b = gb.cpu.regs.b;
    gb.step_over().unwrap();
    assert_eq!(gb.cpu.regs.pc, 0x0103);
    assert_eq!(gb.cpu.regs.b, b.wrapping_add(1), "the callee ran");
    assert!(gb.take_break().is_none(), "returned, not stopped by the frame");
}

#[test]
fn step_over_a_call_that_never_returns_stops_at_the_frame() {
    // $0100: CALL $0110; $0110: JR -2 (forever).
    let mut program = vec![0u8; 0x12];
    program[..3].copy_from_slice(&[0xCD, 0x10, 0x01]);
    program[0x10..].copy_from_slice(&[0x18, 0xFE]);
    let mut gb = GameBoy::new(rom(&program)).unwrap();
    gb.skip_boot_rom();
    gb.step_over().unwrap();
    assert_eq!(gb.cpu.regs.pc, 0x0110);
    assert_eq!(gb.take_break(), Some(gb_core::debug::Break::Frame));
    assert_eq!(gb.debugger_mut().temp_stop, None, "the one-shot stop does not outlive the step");
}

#[test]
fn step_over_on_anything_else_is_one_step() {
    let mut gb = gameboy();
    let mut stepped = gameboy();
    gb.step_over().unwrap();
    stepped.step_instruction().unwrap();
    assert_eq!(gb.cpu.regs.pc, 0x0101);
    assert_eq!(gb.save_state(), stepped.save_state());
}

#[test]
fn emulator_disassembles_and_steps_over_without_side_effects() {
    let mut emu = gb_core::Emulator::new();
    assert!(emu.load_rom(&call_rom()));
    let before = emu.save_state();
    let text = emu.disassemble(0x0100, 2);
    assert!(text.starts_with("0100|CD 10 01|CALL $0110\n0103|00|NOP"), "{text}");
    assert_eq!(emu.save_state(), before, "disassembling touches nothing");
    assert!(emu.debug_step_over());
    assert_eq!(emu.get_pc(), 0x0103);
}

/// A 64 KB (4-bank) cartridge of `mbc` type whose program selects ROM bank 3 through $2000.
fn banked(mbc: u8) -> GameBoy {
    // LD A, $03; LD [$2000], A; JR -2 (spin).
    let mut data = rom(&[0x3E, 0x03, 0xEA, 0x00, 0x20, 0x18, 0xFE]);
    data.resize(0x10000, 0);
    data[0x0147] = mbc;
    data[0x0148] = 0x01;
    let mut checksum: u8 = 0;
    for addr in 0x0134..=0x014C {
        checksum = checksum.wrapping_sub(data[addr]).wrapping_sub(1);
    }
    data[0x014D] = checksum;
    let mut gb = GameBoy::new(data).unwrap();
    gb.skip_boot_rom();
    gb
}

#[test]
fn current_rom_bank_is_the_bank_last_written_to_2000() {
    for mbc in [0x01, 0x11, 0x19] {
        let mut gb = banked(mbc);
        assert_eq!(gb.bus.cartridge.current_rom_bank(), 1, "MBC ${mbc:02X} starts on bank 1");
        gb.run_frame().unwrap();
        assert_eq!(gb.bus.cartridge.current_rom_bank(), 3, "MBC ${mbc:02X}");
    }
    assert_eq!(gameboy().bus.cartridge.current_rom_bank(), 1, "no MBC: bank 1 is fixed");
}
