use gb_core::cartridge::Cartridge;
use gb_core::cpu::Cpu;
use gb_core::memory::MemoryBus;

fn setup(opcodes: &[u8]) -> (Cpu, MemoryBus) {
    let mut rom = vec![0u8; 0x8000];
    // Minimal valid header
    rom[0x0147] = 0x00; // NoMBC
    rom[0x0148] = 0x00; // 32KB ROM
    // Copy opcodes to 0x0100
    for (i, &byte) in opcodes.iter().enumerate() {
        rom[0x0100 + i] = byte;
    }
    // Fix header checksum
    let mut checksum: u8 = 0;
    for addr in 0x0134..=0x014C {
        checksum = checksum.wrapping_sub(rom[addr]).wrapping_sub(1);
    }
    rom[0x014D] = checksum;

    let cart = Cartridge::from_rom(rom).unwrap();
    let cgb = cart.cgb_mode();
    let mut bus = MemoryBus::new(cart, cgb);
    bus.boot_rom_active = false;
    let mut cpu = Cpu::new();
    cpu.regs.pc = 0x0100;
    (cpu, bus)
}

fn step(cpu: &mut Cpu, bus: &mut MemoryBus) {
    bus.cycle_count = 0;
    cpu.step(bus).unwrap();
}

// ─── LD Tests ───

#[test]
fn test_ld_b_imm8() {
    let (mut cpu, mut bus) = setup(&[0x06, 0x42]);
    step(&mut cpu, &mut bus);
    assert_eq!(cpu.regs.b, 0x42);
    assert_eq!(cpu.regs.pc, 0x0102);
}

#[test]
fn test_ld_a_b() {
    let (mut cpu, mut bus) = setup(&[0x06, 0x42, 0x78]);
    step(&mut cpu, &mut bus); // LD B, 0x42
    step(&mut cpu, &mut bus); // LD A, B
    assert_eq!(cpu.regs.a, 0x42);
}

#[test]
fn test_ld_hl_imm16() {
    let (mut cpu, mut bus) = setup(&[0x21, 0x34, 0x12]);
    step(&mut cpu, &mut bus);
    assert_eq!(cpu.regs.hl(), 0x1234);
}

// ─── ALU Tests ───

#[test]
fn test_add_a_b() {
    let (mut cpu, mut bus) = setup(&[0x80]);
    cpu.regs.a = 0x3A;
    cpu.regs.b = 0xC6;
    step(&mut cpu, &mut bus);
    assert_eq!(cpu.regs.a, 0x00);
    assert!(cpu.regs.zero());
    assert!(!cpu.regs.subtract());
    assert!(cpu.regs.half_carry());
    assert!(cpu.regs.carry());
}

#[test]
fn test_sub_a_b() {
    let (mut cpu, mut bus) = setup(&[0x90]);
    cpu.regs.a = 0x3E;
    cpu.regs.b = 0x3E;
    step(&mut cpu, &mut bus);
    assert_eq!(cpu.regs.a, 0x00);
    assert!(cpu.regs.zero());
    assert!(cpu.regs.subtract());
    assert!(!cpu.regs.half_carry());
    assert!(!cpu.regs.carry());
}

#[test]
fn test_and_a_b() {
    let (mut cpu, mut bus) = setup(&[0xA0]);
    cpu.regs.a = 0x5A;
    cpu.regs.b = 0x3F;
    step(&mut cpu, &mut bus);
    assert_eq!(cpu.regs.a, 0x1A);
    assert!(!cpu.regs.zero());
    assert!(!cpu.regs.subtract());
    assert!(cpu.regs.half_carry());
    assert!(!cpu.regs.carry());
}

#[test]
fn test_xor_a_a() {
    let (mut cpu, mut bus) = setup(&[0xAF]);
    cpu.regs.a = 0xFF;
    step(&mut cpu, &mut bus);
    assert_eq!(cpu.regs.a, 0x00);
    assert!(cpu.regs.zero());
}

#[test]
fn test_cp_a_b_no_borrow() {
    let (mut cpu, mut bus) = setup(&[0xB8]);
    cpu.regs.a = 0x3C;
    cpu.regs.b = 0x2F;
    step(&mut cpu, &mut bus);
    assert_eq!(cpu.regs.a, 0x3C); // A unchanged
    assert!(!cpu.regs.zero());
    assert!(cpu.regs.subtract());
    assert!(cpu.regs.half_carry());
    assert!(!cpu.regs.carry());
}

// ─── INC/DEC Tests ───

#[test]
fn test_inc_b() {
    let (mut cpu, mut bus) = setup(&[0x04]);
    cpu.regs.b = 0xFF;
    step(&mut cpu, &mut bus);
    assert_eq!(cpu.regs.b, 0x00);
    assert!(cpu.regs.zero());
    assert!(cpu.regs.half_carry());
}

#[test]
fn test_dec_b() {
    let (mut cpu, mut bus) = setup(&[0x05]);
    cpu.regs.b = 0x01;
    step(&mut cpu, &mut bus);
    assert_eq!(cpu.regs.b, 0x00);
    assert!(cpu.regs.zero());
    assert!(cpu.regs.subtract());
}

// ─── Control Flow Tests ───

#[test]
fn test_jr_nz_taken() {
    let (mut cpu, mut bus) = setup(&[0x20, 0x05]);
    cpu.regs.set_zero(false);
    step(&mut cpu, &mut bus);
    assert_eq!(cpu.regs.pc, 0x0102 + 5);
}

#[test]
fn test_jr_nz_not_taken() {
    let (mut cpu, mut bus) = setup(&[0x20, 0x05]);
    cpu.regs.set_zero(true);
    step(&mut cpu, &mut bus);
    assert_eq!(cpu.regs.pc, 0x0102);
}

#[test]
fn test_call_and_ret() {
    // Place RET (0xC9) at 0x0200 in ROM during setup
    let mut opcodes = vec![0xCD, 0x00, 0x02]; // CALL 0x0200
    // Pad to reach 0x0200 - 0x0100 = 0x100 bytes
    opcodes.resize(0x100, 0x00);
    opcodes.push(0xC9); // RET at 0x0200

    let (mut cpu, mut bus) = setup(&opcodes);
    cpu.regs.sp = 0xFFFE;

    step(&mut cpu, &mut bus); // CALL
    assert_eq!(cpu.regs.pc, 0x0200);
    assert_eq!(cpu.regs.sp, 0xFFFC);

    step(&mut cpu, &mut bus); // RET
    assert_eq!(cpu.regs.pc, 0x0103);
    assert_eq!(cpu.regs.sp, 0xFFFE);
}

// ─── CB Prefix Tests ───

#[test]
fn test_cb_rlc_b() {
    let (mut cpu, mut bus) = setup(&[0xCB, 0x00]);
    cpu.regs.b = 0x85; // 1000_0101
    step(&mut cpu, &mut bus);
    assert_eq!(cpu.regs.b, 0x0B); // 0000_1011
    assert!(cpu.regs.carry());
    assert!(!cpu.regs.zero());
}

#[test]
fn test_cb_bit_7_h() {
    let (mut cpu, mut bus) = setup(&[0xCB, 0x7C]);
    cpu.regs.h = 0x80;
    step(&mut cpu, &mut bus);
    assert!(!cpu.regs.zero()); // bit 7 is set
    assert!(!cpu.regs.subtract());
    assert!(cpu.regs.half_carry());
}

#[test]
fn test_cb_swap_a() {
    let (mut cpu, mut bus) = setup(&[0xCB, 0x37]);
    cpu.regs.a = 0xF0;
    step(&mut cpu, &mut bus);
    assert_eq!(cpu.regs.a, 0x0F);
    assert!(!cpu.regs.zero());
}

// ─── Misc Tests ───

#[test]
fn test_daa_after_add() {
    let (mut cpu, mut bus) = setup(&[0x80, 0x27]);
    cpu.regs.a = 0x45;
    cpu.regs.b = 0x38;
    step(&mut cpu, &mut bus); // ADD: 0x45 + 0x38 = 0x7D
    step(&mut cpu, &mut bus); // DAA: adjusts to 0x83
    assert_eq!(cpu.regs.a, 0x83);
}

#[test]
fn test_cpl() {
    let (mut cpu, mut bus) = setup(&[0x2F]);
    cpu.regs.a = 0x35;
    step(&mut cpu, &mut bus);
    assert_eq!(cpu.regs.a, 0xCA);
    assert!(cpu.regs.subtract());
    assert!(cpu.regs.half_carry());
}

#[test]
fn test_scf() {
    let (mut cpu, mut bus) = setup(&[0x37]);
    step(&mut cpu, &mut bus);
    assert!(cpu.regs.carry());
    assert!(!cpu.regs.subtract());
    assert!(!cpu.regs.half_carry());
}

// ─── Interrupts ───

/// `ei; ei` with an interrupt pending: the second EI (IME already on) must not
/// re-arm the delayed enable, so the handler starts with IME off.
#[test]
fn test_ei_while_ime_on_does_not_reenable_in_handler() {
    let (mut cpu, mut bus) = setup(&[0xFB, 0xFB, 0x00]);
    bus.interrupts.interrupt_enable = 0x01;
    bus.interrupts.interrupt_flag = 0x01;
    for _ in 0..3 {
        cpu.handle_interrupts(&mut bus);
        step(&mut cpu, &mut bus);
    }
    assert_eq!(cpu.regs.pc, 0x0041); // dispatched to $40, first handler NOP ran
    assert!(!cpu.ime);
    assert!(!cpu.ime_pending);
}
