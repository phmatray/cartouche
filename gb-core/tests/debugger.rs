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
