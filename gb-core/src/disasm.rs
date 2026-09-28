//! Side-effect-free SM83 disassembler in RGBDS syntax, decoded from the opcode's x/y/z/p/q
//! fields (Pan Docs / gbdev opcode table). Reads only through `MemoryBus::read_byte`, never
//! `cycle_read`, so it cannot tick hardware or trigger the OAM bug.

use crate::memory::MemoryBus;

const R: [&str; 8] = ["B", "C", "D", "E", "H", "L", "[HL]", "A"];
const RP: [&str; 4] = ["BC", "DE", "HL", "SP"];
const RP2: [&str; 4] = ["BC", "DE", "HL", "AF"];
const CC: [&str; 4] = ["NZ", "Z", "NC", "C"];
const ALU: [&str; 8] = ["ADD A,", "ADC A,", "SUB A,", "SBC A,", "AND A,", "XOR A,", "OR A,", "CP A,"];
const ROT: [&str; 8] = ["RLC", "RRC", "RL", "RR", "SLA", "SRA", "SWAP", "SRL"];

/// The instruction at `addr`: its text and its length in bytes (1-3).
pub fn disassemble_one(bus: &MemoryBus, addr: u16) -> (String, u8) {
    let op = bus.read_byte(addr);
    let n8 = bus.read_byte(addr.wrapping_add(1));
    let n16 = u16::from_le_bytes([n8, bus.read_byte(addr.wrapping_add(2))]);
    let (x, y, z) = (op >> 6, ((op >> 3) & 7) as usize, op & 7);
    let (p, q) = (y >> 1, y & 1);
    let jr = addr.wrapping_add(2).wrapping_add(n8 as i8 as u16);
    let e8 = if (n8 as i8) < 0 { format!("-${:02X}", (n8 as i8).unsigned_abs()) } else { format!("+${n8:02X}") };
    let one = |s: String| (s, 1);
    let two = |s: String| (s, 2);
    let three = |s: String| (s, 3);
    match (x, z) {
        (0, 0) => match y {
            0 => one("NOP".into()),
            1 => three(format!("LD [${n16:04X}], SP")),
            2 => two("STOP".into()),
            3 => two(format!("JR ${jr:04X}")),
            _ => two(format!("JR {}, ${jr:04X}", CC[y - 4])),
        },
        (0, 1) if q == 0 => three(format!("LD {}, ${n16:04X}", RP[p])),
        (0, 1) => one(format!("ADD HL, {}", RP[p])),
        (0, 2) => {
            let m = ["[BC]", "[DE]", "[HL+]", "[HL-]"][p];
            one(if q == 0 { format!("LD {m}, A") } else { format!("LD A, {m}") })
        }
        (0, 3) => one(format!("{} {}", ["INC", "DEC"][q], RP[p])),
        (0, 4) => one(format!("INC {}", R[y])),
        (0, 5) => one(format!("DEC {}", R[y])),
        (0, 6) => two(format!("LD {}, ${n8:02X}", R[y])),
        (0, _) => one(["RLCA", "RRCA", "RLA", "RRA", "DAA", "CPL", "SCF", "CCF"][y].into()),
        (1, 6) if y == 6 => one("HALT".into()),
        (1, _) => one(format!("LD {}, {}", R[y], R[z as usize])),
        (2, _) => one(format!("{} {}", ALU[y], R[z as usize])),
        (_, 0) => match y {
            0..=3 => one(format!("RET {}", CC[y])),
            4 => two(format!("LDH [$FF{n8:02X}], A")),
            5 => two(format!("ADD SP, {}", e8.trim_start_matches('+'))),
            6 => two(format!("LDH A, [$FF{n8:02X}]")),
            _ => two(format!("LD HL, SP{e8}")),
        },
        (_, 1) if q == 0 => one(format!("POP {}", RP2[p])),
        (_, 1) => one(["RET", "RETI", "JP HL", "LD SP, HL"][p].into()),
        (_, 2) => match y {
            0..=3 => three(format!("JP {}, ${n16:04X}", CC[y])),
            4 => one("LDH [C], A".into()),
            5 => three(format!("LD [${n16:04X}], A")),
            6 => one("LDH A, [C]".into()),
            _ => three(format!("LD A, [${n16:04X}]")),
        },
        (_, 3) => match y {
            0 => three(format!("JP ${n16:04X}")),
            1 => two(cb(n8)),
            6 => one("DI".into()),
            7 => one("EI".into()),
            _ => one(format!("DB ${op:02X}")),
        },
        (_, 4) if y < 4 => three(format!("CALL {}, ${n16:04X}", CC[y])),
        (_, 5) if q == 0 => one(format!("PUSH {}", RP2[p])),
        (_, 5) if p == 0 => three(format!("CALL ${n16:04X}")),
        (_, 6) => two(format!("{} ${n8:02X}", ALU[y])),
        (_, 7) => one(format!("RST ${:02X}", y * 8)),
        _ => one(format!("DB ${op:02X}")),
    }
}

fn cb(op: u8) -> String {
    let (y, r) = ((op >> 3) & 7, R[(op & 7) as usize]);
    match op >> 6 {
        0 => format!("{} {r}", ROT[y as usize]),
        1 => format!("BIT {y}, {r}"),
        2 => format!("RES {y}, {r}"),
        _ => format!("SET {y}, {r}"),
    }
}
