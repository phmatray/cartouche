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

fn booted(program: &[u8]) -> GameBoy {
    let mut gb = GameBoy::new(rom(program)).unwrap();
    gb.skip_boot_rom();
    gb
}

const READ: u8 = 1;
const WRITE: u8 = 2;
const ACCESS: u8 = 3;

#[test]
fn write_watchpoint_stops_after_the_writing_instruction() {
    // $0100: LD A, $3F; $0102: LD [$C000], A; $0105: JR -2.
    let mut gb = booted(&[0x3E, 0x3F, 0xEA, 0x00, 0xC0, 0x18, 0xFE]);
    gb.watch_add(0xC000, WRITE);
    gb.run_frame().unwrap();
    assert_eq!(gb.cpu.regs.pc, 0x0105);
    assert_eq!(gb.take_break().unwrap().describe(), "write $C000 = $3F at $0102");
}

/// $0100: LD HL, $C000; $0103: LD [HL], $3F; $0105: LD A, [HL]; $0106: JR -2.
const WRITE_THEN_READ: [u8; 8] = [0x21, 0x00, 0xC0, 0x36, 0x3F, 0x7E, 0x18, 0xFE];

#[test]
fn read_watchpoint_fires_on_a_read_and_not_on_a_write() {
    let mut gb = booted(&WRITE_THEN_READ);
    gb.watch_add(0xC000, READ);
    gb.run_frame().unwrap();
    assert_eq!(gb.cpu.regs.pc, 0x0106);
    assert_eq!(gb.take_break().unwrap().describe(), "read $C000 = $3F at $0105");
}

#[test]
fn access_watchpoint_fires_on_both() {
    let mut gb = booted(&WRITE_THEN_READ);
    gb.watch_add(0xC000, ACCESS);
    gb.run_frame().unwrap();
    assert_eq!(gb.take_break().unwrap().describe(), "write $C000 = $3F at $0103");
    gb.run_frame().unwrap();
    assert_eq!(gb.take_break().unwrap().describe(), "read $C000 = $3F at $0105");
}

#[test]
fn write_watchpoint_ignores_reads_and_removal_stops_it() {
    // $0100: LD HL, $C000; $0103: LD A, [HL]; $0104: JR -2.
    let mut gb = booted(&[0x21, 0x00, 0xC0, 0x7E, 0x18, 0xFE]);
    gb.watch_add(0xC000, WRITE);
    gb.run_frame().unwrap();
    assert!(gb.take_break().is_none());

    let mut gb = booted(&WRITE_THEN_READ);
    gb.watch_add(0xC000, ACCESS);
    gb.watch_remove(0xC000, ACCESS);
    gb.run_frame().unwrap();
    assert!(gb.take_break().is_none());
}

#[test]
fn oam_dma_over_a_watched_address_does_not_fire() {
    // $0100: LD SP, $DFF0; LD A, $C1; LDH [$46], A; JR -2. During the DMA the CPU fetches $FF
    // (RST $38) from ROM: the stack is moved off OAM so only the DMA writes there.
    let mut gb = booted(&[0x31, 0xF0, 0xDF, 0x3E, 0xC1, 0xE0, 0x46, 0x18, 0xFE]);
    gb.watch_add(0xFE00, WRITE);
    gb.run_frame().unwrap();
    assert_eq!(gb.take_break(), None);
}

#[test]
fn run_to_scanline_stops_when_ly_reaches_it() {
    // $0100: LD A, $91; $0102: LDH [$40], A (LCD on); $0104: JR -2.
    let mut gb = booted(&[0x3E, 0x91, 0xE0, 0x40, 0x18, 0xFE]);
    gb.run_to_scanline(72).unwrap();
    assert_eq!(gb.bus.read_byte(0xFF44), 72);
    assert_eq!(gb.take_break().unwrap().describe(), "scanline 72");
}

#[test]
fn run_to_scanline_with_the_lcd_off_stops_at_the_frame() {
    // $0100: XOR A; $0101: LDH [$40], A (LCD off); $0103: JR -2.
    let mut gb = booted(&[0xAF, 0xE0, 0x40, 0x18, 0xFE]);
    gb.run_to_scanline(72).unwrap();
    assert_eq!(gb.take_break(), Some(gb_core::debug::Break::Frame));
}

#[test]
fn emulator_watchpoints_and_run_to_scanline() {
    let mut emu = gb_core::Emulator::new();
    assert!(emu.load_rom(&rom(&WRITE_THEN_READ)));
    emu.debug_add_watchpoint(0xC000, 9);
    assert!(emu.get_error().is_some(), "an unknown kind is refused");
    emu.debug_add_watchpoint(0xC000, READ);
    assert!(emu.run_frame());
    assert_eq!(emu.debug_break_reason().as_deref(), Some("read $C000 = $3F at $0105"));
    emu.debug_remove_watchpoint(0xC000, READ);
    assert!(emu.debug_run_to_scanline(100));
    assert_eq!(emu.debug_break_reason().as_deref(), Some("scanline 100"));
}

#[test]
fn breakpoint_on_an_interrupt_vector_fires_on_dispatch() {
    // $0100: LD A, 1; $0102: LDH [$FF], A; $0104: EI; $0105: JR -2. VBlank jumps to $0040.
    let mut gb = booted(&[0x3E, 0x01, 0xE0, 0xFF, 0xFB, 0x18, 0xFE]);
    gb.debugger_mut().breakpoints.insert(0x0040);
    gb.run_frame().unwrap();
    assert_eq!(gb.cpu.regs.pc, 0x0040);
    assert_eq!(gb.take_break().unwrap().describe(), "breakpoint $0040");
    gb.debugger_mut().breakpoints.insert(0x0041);
    gb.run_frame().unwrap(); // continuing runs the handler's first instruction (a NOP) once
    assert_eq!(gb.take_break().unwrap().describe(), "breakpoint $0041");
}
