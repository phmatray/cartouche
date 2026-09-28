use gb_core::cartridge::Cartridge;
use gb_core::disasm::disassemble_one;
use gb_core::memory::MemoryBus;

/// A NoMBC bus whose ROM holds `bytes` at $0100 (as cpu_tests.rs's `setup`).
fn bus(bytes: &[u8]) -> MemoryBus {
    let mut rom = vec![0u8; 0x8000];
    rom[0x0100..0x0100 + bytes.len()].copy_from_slice(bytes);
    let mut checksum: u8 = 0;
    for addr in 0x0134..=0x014C {
        checksum = checksum.wrapping_sub(rom[addr]).wrapping_sub(1);
    }
    rom[0x014D] = checksum;
    let mut bus = MemoryBus::new(Cartridge::from_rom(rom).unwrap(), false);
    bus.boot_rom_active = false;
    bus
}

/// Every base opcode at $0100, followed by $34 $12 (so n8 = $34, n16 = $1234, a JR lands on
/// $0102 + $34 = $0136). Written from the gbdev opcode table in RGBDS syntax.
const BASE: [(&str, u8); 256] = [
    // 0x00
    ("NOP", 1), ("LD BC, $1234", 3), ("LD [BC], A", 1), ("INC BC", 1),
    ("INC B", 1), ("DEC B", 1), ("LD B, $34", 2), ("RLCA", 1),
    ("LD [$1234], SP", 3), ("ADD HL, BC", 1), ("LD A, [BC]", 1), ("DEC BC", 1),
    ("INC C", 1), ("DEC C", 1), ("LD C, $34", 2), ("RRCA", 1),
    // 0x10
    ("STOP", 2), ("LD DE, $1234", 3), ("LD [DE], A", 1), ("INC DE", 1),
    ("INC D", 1), ("DEC D", 1), ("LD D, $34", 2), ("RLA", 1),
    ("JR $0136", 2), ("ADD HL, DE", 1), ("LD A, [DE]", 1), ("DEC DE", 1),
    ("INC E", 1), ("DEC E", 1), ("LD E, $34", 2), ("RRA", 1),
    // 0x20
    ("JR NZ, $0136", 2), ("LD HL, $1234", 3), ("LD [HL+], A", 1), ("INC HL", 1),
    ("INC H", 1), ("DEC H", 1), ("LD H, $34", 2), ("DAA", 1),
    ("JR Z, $0136", 2), ("ADD HL, HL", 1), ("LD A, [HL+]", 1), ("DEC HL", 1),
    ("INC L", 1), ("DEC L", 1), ("LD L, $34", 2), ("CPL", 1),
    // 0x30
    ("JR NC, $0136", 2), ("LD SP, $1234", 3), ("LD [HL-], A", 1), ("INC SP", 1),
    ("INC [HL]", 1), ("DEC [HL]", 1), ("LD [HL], $34", 2), ("SCF", 1),
    ("JR C, $0136", 2), ("ADD HL, SP", 1), ("LD A, [HL-]", 1), ("DEC SP", 1),
    ("INC A", 1), ("DEC A", 1), ("LD A, $34", 2), ("CCF", 1),
    // 0x40
    ("LD B, B", 1), ("LD B, C", 1), ("LD B, D", 1), ("LD B, E", 1),
    ("LD B, H", 1), ("LD B, L", 1), ("LD B, [HL]", 1), ("LD B, A", 1),
    ("LD C, B", 1), ("LD C, C", 1), ("LD C, D", 1), ("LD C, E", 1),
    ("LD C, H", 1), ("LD C, L", 1), ("LD C, [HL]", 1), ("LD C, A", 1),
    // 0x50
    ("LD D, B", 1), ("LD D, C", 1), ("LD D, D", 1), ("LD D, E", 1),
    ("LD D, H", 1), ("LD D, L", 1), ("LD D, [HL]", 1), ("LD D, A", 1),
    ("LD E, B", 1), ("LD E, C", 1), ("LD E, D", 1), ("LD E, E", 1),
    ("LD E, H", 1), ("LD E, L", 1), ("LD E, [HL]", 1), ("LD E, A", 1),
    // 0x60
    ("LD H, B", 1), ("LD H, C", 1), ("LD H, D", 1), ("LD H, E", 1),
    ("LD H, H", 1), ("LD H, L", 1), ("LD H, [HL]", 1), ("LD H, A", 1),
    ("LD L, B", 1), ("LD L, C", 1), ("LD L, D", 1), ("LD L, E", 1),
    ("LD L, H", 1), ("LD L, L", 1), ("LD L, [HL]", 1), ("LD L, A", 1),
    // 0x70
    ("LD [HL], B", 1), ("LD [HL], C", 1), ("LD [HL], D", 1), ("LD [HL], E", 1),
    ("LD [HL], H", 1), ("LD [HL], L", 1), ("HALT", 1), ("LD [HL], A", 1),
    ("LD A, B", 1), ("LD A, C", 1), ("LD A, D", 1), ("LD A, E", 1),
    ("LD A, H", 1), ("LD A, L", 1), ("LD A, [HL]", 1), ("LD A, A", 1),
    // 0x80
    ("ADD A, B", 1), ("ADD A, C", 1), ("ADD A, D", 1), ("ADD A, E", 1),
    ("ADD A, H", 1), ("ADD A, L", 1), ("ADD A, [HL]", 1), ("ADD A, A", 1),
    ("ADC A, B", 1), ("ADC A, C", 1), ("ADC A, D", 1), ("ADC A, E", 1),
    ("ADC A, H", 1), ("ADC A, L", 1), ("ADC A, [HL]", 1), ("ADC A, A", 1),
    // 0x90
    ("SUB A, B", 1), ("SUB A, C", 1), ("SUB A, D", 1), ("SUB A, E", 1),
    ("SUB A, H", 1), ("SUB A, L", 1), ("SUB A, [HL]", 1), ("SUB A, A", 1),
    ("SBC A, B", 1), ("SBC A, C", 1), ("SBC A, D", 1), ("SBC A, E", 1),
    ("SBC A, H", 1), ("SBC A, L", 1), ("SBC A, [HL]", 1), ("SBC A, A", 1),
    // 0xA0
    ("AND A, B", 1), ("AND A, C", 1), ("AND A, D", 1), ("AND A, E", 1),
    ("AND A, H", 1), ("AND A, L", 1), ("AND A, [HL]", 1), ("AND A, A", 1),
    ("XOR A, B", 1), ("XOR A, C", 1), ("XOR A, D", 1), ("XOR A, E", 1),
    ("XOR A, H", 1), ("XOR A, L", 1), ("XOR A, [HL]", 1), ("XOR A, A", 1),
    // 0xB0
    ("OR A, B", 1), ("OR A, C", 1), ("OR A, D", 1), ("OR A, E", 1),
    ("OR A, H", 1), ("OR A, L", 1), ("OR A, [HL]", 1), ("OR A, A", 1),
    ("CP A, B", 1), ("CP A, C", 1), ("CP A, D", 1), ("CP A, E", 1),
    ("CP A, H", 1), ("CP A, L", 1), ("CP A, [HL]", 1), ("CP A, A", 1),
    // 0xC0
    ("RET NZ", 1), ("POP BC", 1), ("JP NZ, $1234", 3), ("JP $1234", 3),
    ("CALL NZ, $1234", 3), ("PUSH BC", 1), ("ADD A, $34", 2), ("RST $00", 1),
    ("RET Z", 1), ("RET", 1), ("JP Z, $1234", 3), ("SWAP H", 2),
    ("CALL Z, $1234", 3), ("CALL $1234", 3), ("ADC A, $34", 2), ("RST $08", 1),
    // 0xD0
    ("RET NC", 1), ("POP DE", 1), ("JP NC, $1234", 3), ("DB $D3", 1),
    ("CALL NC, $1234", 3), ("PUSH DE", 1), ("SUB A, $34", 2), ("RST $10", 1),
    ("RET C", 1), ("RETI", 1), ("JP C, $1234", 3), ("DB $DB", 1),
    ("CALL C, $1234", 3), ("DB $DD", 1), ("SBC A, $34", 2), ("RST $18", 1),
    // 0xE0
    ("LDH [$FF34], A", 2), ("POP HL", 1), ("LDH [C], A", 1), ("DB $E3", 1),
    ("DB $E4", 1), ("PUSH HL", 1), ("AND A, $34", 2), ("RST $20", 1),
    ("ADD SP, $34", 2), ("JP HL", 1), ("LD [$1234], A", 3), ("DB $EB", 1),
    ("DB $EC", 1), ("DB $ED", 1), ("XOR A, $34", 2), ("RST $28", 1),
    // 0xF0
    ("LDH A, [$FF34]", 2), ("POP AF", 1), ("LDH A, [C]", 1), ("DI", 1),
    ("DB $F4", 1), ("PUSH AF", 1), ("OR A, $34", 2), ("RST $30", 1),
    ("LD HL, SP+$34", 2), ("LD SP, HL", 1), ("LD A, [$1234]", 3), ("EI", 1),
    ("DB $FC", 1), ("DB $FD", 1), ("CP A, $34", 2), ("RST $38", 1),
];

#[test]
fn every_base_opcode_matches_the_reference_table() {
    for (op, &(text, len)) in BASE.iter().enumerate() {
        let bus = bus(&[op as u8, 0x34, 0x12]);
        assert_eq!(disassemble_one(&bus, 0x0100), (text.to_string(), len), "opcode ${op:02X}");
    }
}

#[test]
fn every_cb_opcode_matches_the_reference_table() {
    // The CB page is a grid: rows of 8 by operation, columns B C D E H L [HL] A.
    const OPS: [&str; 8] = ["RLC", "RRC", "RL", "RR", "SLA", "SRA", "SWAP", "SRL"];
    const REGS: [&str; 8] = ["B", "C", "D", "E", "H", "L", "[HL]", "A"];
    for op in 0..=255u8 {
        let reg = REGS[(op & 7) as usize];
        let bit = (op >> 3) & 7;
        let text = match op {
            0x00..=0x3F => format!("{} {reg}", OPS[(op >> 3) as usize]),
            0x40..=0x7F => format!("BIT {bit}, {reg}"),
            0x80..=0xBF => format!("RES {bit}, {reg}"),
            _ => format!("SET {bit}, {reg}"),
        };
        let bus = bus(&[0xCB, op]);
        assert_eq!(disassemble_one(&bus, 0x0100), (text, 2), "opcode CB ${op:02X}");
    }
    assert_eq!(disassemble_one(&bus(&[0xCB, 0x7C]), 0x0100).0, "BIT 7, H");
}

#[test]
fn relative_jumps_show_the_absolute_target() {
    // JR NZ, -3 at $0150 lands on $0152 - 3.
    let mut bytes = vec![0u8; 0x52];
    bytes[0x50] = 0x20;
    bytes[0x51] = 0xFD;
    assert_eq!(disassemble_one(&bus(&bytes), 0x0150), ("JR NZ, $014F".to_string(), 2));
}

#[test]
fn signed_offsets_read_as_signed() {
    assert_eq!(disassemble_one(&bus(&[0xE8, 0xFD]), 0x0100).0, "ADD SP, -$03");
    assert_eq!(disassemble_one(&bus(&[0xF8, 0x80]), 0x0100).0, "LD HL, SP-$80");
}

#[test]
fn ldh_shows_the_full_address() {
    assert_eq!(disassemble_one(&bus(&[0xE0, 0x44]), 0x0100), ("LDH [$FF44], A".to_string(), 2));
}

#[test]
fn undefined_opcodes_read_as_data() {
    assert_eq!(disassemble_one(&bus(&[0xD3]), 0x0100), ("DB $D3".to_string(), 1));
}
