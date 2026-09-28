//! SPC700 (the SNES audio CPU behind Super Game Boy sound): hand-assembled programs in audio RAM,
//! expected values written from the public documentation (fullsnes, Anomie's SPC700 doc).

use gb_core::spc700::{DspBus, Spc700};

/// Records every S-DSP register access; reads answer `0x40 | reg`.
#[derive(Default)]
struct Dsp {
    writes: Vec<(u8, u8)>,
    reads: Vec<u8>,
}

impl DspBus for Dsp {
    fn read(&mut self, reg: u8) -> u8 {
        self.reads.push(reg);
        0x40 | reg
    }
    fn write(&mut self, reg: u8, value: u8) {
        self.writes.push((reg, value));
    }
}

// ─── Memory map, ports, DSP, timers ───

#[test]
fn dsp_register_write_reaches_the_bus_once() {
    // AC3: $F2 = $4C (KON), $F3 = $01.
    let (mut spc, mut dsp) = (Spc700::new(), Dsp::default());
    spc.write(0xF2, 0x4C, &mut dsp);
    spc.write(0xF3, 0x01, &mut dsp);
    assert_eq!(dsp.writes, vec![(0x4C, 0x01)]);
    assert_eq!(spc.read(0xF2, &mut dsp), 0x4C);
}

#[test]
fn dsp_read_masks_the_address_and_high_writes_are_dropped() {
    let (mut spc, mut dsp) = (Spc700::new(), Dsp::default());
    spc.write(0xF2, 0x8C, &mut dsp);
    assert_eq!(spc.read(0xF3, &mut dsp), 0x4C); // read of $8C mirrors $0C
    assert_eq!(dsp.reads, vec![0x0C]);
    spc.write(0xF3, 0x55, &mut dsp); // $80-$FF are read-only
    assert!(dsp.writes.is_empty());
}

#[test]
fn ports_are_split_between_the_two_sides() {
    let (mut spc, mut dsp) = (Spc700::new(), Dsp::default());
    spc.ports_in = [1, 2, 3, 4];
    assert_eq!(spc.read(0xF5, &mut dsp), 2);
    spc.write(0xF6, 0x99, &mut dsp);
    assert_eq!(spc.ports_out, [0, 0, 0x99, 0]);
    assert_eq!(spc.read(0xF6, &mut dsp), 3); // the SPC700 reads the other side
    // $F1 bit 4 clears input ports 0-1, bit 5 ports 2-3.
    spc.write(0xF1, 0x10, &mut dsp);
    assert_eq!(spc.ports_in, [0, 0, 3, 4]);
    spc.write(0xF1, 0x20, &mut dsp);
    assert_eq!(spc.ports_in, [0, 0, 0, 0]);
}

#[test]
fn no_ipl_rom_top_page_is_ram() {
    let (mut spc, mut dsp) = (Spc700::new(), Dsp::default());
    spc.write(0xF1, 0x80, &mut dsp); // IPL enable bit: ignored
    spc.write(0xFFC0, 0x12, &mut dsp);
    assert_eq!(spc.read(0xFFC0, &mut dsp), 0x12);
    spc.write(0x1234, 0x56, &mut dsp);
    assert_eq!(spc.aram[0x1234], 0x56);
}

#[test]
fn timer_0_counts_at_8khz() {
    let (mut spc, mut dsp) = (Spc700::new(), Dsp::default());
    spc.write(0xFA, 4, &mut dsp); // target 4 → one output tick per 4 × 128 cycles
    spc.write(0xF1, 0x01, &mut dsp);
    spc.tick_timers(128 * 4 * 3 + 127);
    assert_eq!(spc.read(0xFD, &mut dsp), 3);
    assert_eq!(spc.read(0xFD, &mut dsp), 0, "counter clears on read");
}

#[test]
fn timer_2_counts_at_64khz_and_wraps_at_4_bits() {
    let (mut spc, mut dsp) = (Spc700::new(), Dsp::default());
    spc.write(0xFC, 1, &mut dsp);
    spc.write(0xF1, 0x04, &mut dsp);
    spc.tick_timers(16 * 17);
    assert_eq!(spc.read(0xFF, &mut dsp), 1); // 17 & 15
}

#[test]
fn timer_target_0_means_256_and_disabled_timers_hold() {
    let (mut spc, mut dsp) = (Spc700::new(), Dsp::default());
    spc.write(0xFB, 0, &mut dsp);
    spc.write(0xF1, 0x02, &mut dsp);
    spc.tick_timers(128 * 255);
    assert_eq!(spc.read(0xFE, &mut dsp), 0);
    spc.tick_timers(128);
    assert_eq!(spc.read(0xFE, &mut dsp), 1);
    spc.tick_timers(128 * 512); // timer 0 never enabled
    assert_eq!(spc.read(0xFD, &mut dsp), 0);
}

// ─── Instruction set ───
//
// Each case assembles one instruction at $0200 and runs a single `step`. Registers start at
// A=X=Y=0, SP=$EF, PSW=0 unless the case sets them. PSW bits: N80 V40 P20 B10 H08 I04 Z02 C01.

type Regs = (u8, u8, u8, u8, u16, u8);

fn regs(s: &Spc700) -> Regs {
    (s.a, s.x, s.y, s.sp, s.pc, s.psw)
}

struct Runner {
    seen: [bool; 256],
}

impl Runner {
    fn run(&mut self, code: &[u8], setup: impl FnOnce(&mut Spc700)) -> (Spc700, u32) {
        self.seen[code[0] as usize] = true;
        let mut s = Spc700::new();
        s.aram[0x200..0x200 + code.len()].copy_from_slice(code);
        s.pc = 0x200;
        setup(&mut s);
        let cycles = s.step(&mut Dsp::default());
        (s, cycles)
    }
}

/// Runs one instruction and checks (A, X, Y, SP, PC, PSW) and the cycle count; returns the core.
macro_rules! case {
    ($t:ident, $code:expr, $setup:expr, $regs:expr, $cyc:expr) => {{
        let code: &[u8] = &$code;
        let (s, c) = $t.run(code, $setup);
        assert_eq!((regs(&s), c), ($regs, $cyc), "opcode {:02X}", code[0]);
        s
    }};
}

/// Operand modes of the A-register columns (low nibble 4-7), as (opcode offset, operand bytes,
/// X, Y, effective address, cycles for a load/ALU op; stores take one more).
const MODES: [(u8, &[u8], u8, u8, u16, u32); 8] = [
    (0x04, &[0x10], 0, 0, 0x0010, 3),       // d
    (0x14, &[0x0B], 5, 0, 0x0010, 4),       // d+X
    (0x05, &[0x34, 0x12], 0, 0, 0x1234, 4), // !a
    (0x15, &[0x2F, 0x12], 5, 0, 0x1234, 5), // !a+X
    (0x06, &[], 0x10, 0, 0x0010, 3),        // (X)
    (0x16, &[0x2F, 0x12], 0, 5, 0x1234, 5), // !a+Y
    (0x07, &[0x0B], 5, 0, 0x1234, 6),       // [d+X], pointer at $10 = $1234
    (0x17, &[0x10], 0, 5, 0x1234, 6),       // [d]+Y, pointer at $10 = $122F
];

fn place(s: &mut Spc700, off: u8, ea: u16, v: u8) {
    s.aram[ea as usize] = v;
    match off {
        0x07 => s.aram[0x10..0x12].copy_from_slice(&[0x34, 0x12]),
        0x17 => s.aram[0x10..0x12].copy_from_slice(&[0x2F, 0x12]),
        _ => {}
    }
}

#[test]
fn every_opcode() {
    let mut t = Runner { seen: [false; 256] };

    // Column 0: NOP, branches, flag operations.
    case!(t, [0x00], |_| {}, (0, 0, 0, 0xEF, 0x201, 0), 2);
    case!(t, [0x10, 0x05], |_| {}, (0, 0, 0, 0xEF, 0x207, 0), 4); // BPL taken
    case!(t, [0x30, 0x05], |_| {}, (0, 0, 0, 0xEF, 0x202, 0), 2); // BMI not taken
    case!(t, [0x50, 0xFE], |_| {}, (0, 0, 0, 0xEF, 0x200, 0), 4); // BVC back
    case!(t, [0x70, 0x10], |s| s.psw = 0x40, (0, 0, 0, 0xEF, 0x212, 0x40), 4); // BVS
    case!(t, [0x90, 0x10], |s| s.psw = 0x01, (0, 0, 0, 0xEF, 0x202, 0x01), 2); // BCC not taken
    case!(t, [0xB0, 0x10], |s| s.psw = 0x01, (0, 0, 0, 0xEF, 0x212, 0x01), 4); // BCS
    case!(t, [0xD0, 0x80], |_| {}, (0, 0, 0, 0xEF, 0x182, 0), 4); // BNE -128
    case!(t, [0xF0, 0x7F], |s| s.psw = 0x02, (0, 0, 0, 0xEF, 0x281, 0x02), 4); // BEQ +127
    case!(t, [0x20], |s| s.psw = 0xFF, (0, 0, 0, 0xEF, 0x201, 0xDF), 2); // CLRP
    case!(t, [0x40], |_| {}, (0, 0, 0, 0xEF, 0x201, 0x20), 2); // SETP
    case!(t, [0x60], |s| s.psw = 0xFF, (0, 0, 0, 0xEF, 0x201, 0xFE), 2); // CLRC
    case!(t, [0x80], |_| {}, (0, 0, 0, 0xEF, 0x201, 0x01), 2); // SETC
    case!(t, [0xA0], |_| {}, (0, 0, 0, 0xEF, 0x201, 0x04), 3); // EI
    case!(t, [0xC0], |s| s.psw = 0xFF, (0, 0, 0, 0xEF, 0x201, 0xFB), 3); // DI
    case!(t, [0xE0], |s| s.psw = 0xFF, (0, 0, 0, 0xEF, 0x201, 0xB7), 2); // CLRV clears V and H

    // Column 1: TCALL n jumps through the vector at $FFDE - 2n, pushing the return address.
    for n in 0..16u16 {
        let v = 0xFFDE - 2 * n as usize;
        let s = case!(t, [(n as u8) << 4 | 1], |s| s.aram[v..v + 2].copy_from_slice(&[0x34, 0x12]),
            (0, 0, 0, 0xED, 0x1234, 0), 8);
        assert_eq!(s.aram[0x1EE..0x1F0], [0x01, 0x02]);
    }

    // Columns 2 and 3: SET1/CLR1 d.b, BBS/BBC d.b,r (bit b = opcode >> 5).
    for b in 0..8u8 {
        let s = case!(t, [b << 5 | 0x02, 0x10], |_| {}, (0, 0, 0, 0xEF, 0x202, 0), 4);
        assert_eq!(s.aram[0x10], 1 << b);
        let s = case!(t, [b << 5 | 0x12, 0x10], |s| s.aram[0x10] = 0xFF, (0, 0, 0, 0xEF, 0x202, 0), 4);
        assert_eq!(s.aram[0x10], !(1 << b));
        case!(t, [b << 5 | 0x03, 0x10, 0x05], |s| s.aram[0x10] = 1 << b, (0, 0, 0, 0xEF, 0x208, 0), 7);
        case!(t, [b << 5 | 0x13, 0x10, 0x05], |s| s.aram[0x10] = 1 << b, (0, 0, 0, 0xEF, 0x203, 0), 5);
    }
    // The P flag moves the direct page to $0100.
    let s = case!(t, [0x02, 0x10], |s| s.psw = 0x20, (0, 0, 0, 0xEF, 0x202, 0x20), 4);
    assert_eq!((s.aram[0x10], s.aram[0x110]), (0, 1));

    // Columns 4-9, rows 0-B: OR, AND, EOR, CMP, ADC, SBC with A (or the destination) = $C3,
    // operand = $5A and carry set in.
    let alu = [
        (0x00, 0xDB, 0x81), // OR:  $DB, N
        (0x20, 0x42, 0x01), // AND: $42
        (0x40, 0x99, 0x81), // EOR: $99, N
        (0x60, 0xC3, 0x01), // CMP: $C3 - $5A = $69, no borrow, A unchanged
        (0x80, 0x1E, 0x01), // ADC: $C3 + $5A + 1 = $11E, C
        (0xA0, 0x69, 0x41), // SBC: $C3 - $5A = $69, C (no borrow), V (-61 - 90 overflows)
    ];
    for (base, res, psw) in alu {
        for (off, tail, x, y, ea, cyc) in MODES {
            let code = [&[base + off][..], tail].concat();
            let pc = 0x201 + tail.len() as u16;
            case!(t, code, |s| { s.a = 0xC3; s.x = x; s.y = y; s.psw = 1; place(s, off, ea, 0x5A) },
                (res, x, y, 0xEF, pc, psw), cyc);
        }
        case!(t, [base + 0x08, 0x5A], |s| { s.a = 0xC3; s.psw = 1 }, (res, 0, 0, 0xEF, 0x202, psw), 2);
        let s = case!(t, [base + 0x18, 0x5A, 0x10], |s| { s.aram[0x10] = 0xC3; s.psw = 1 },
            (0, 0, 0, 0xEF, 0x203, psw), 5); // d,#i
        assert_eq!(s.aram[0x10], res);
        let s = case!(t, [base + 0x09, 0x20, 0x10], |s| { s.aram[0x10] = 0xC3; s.aram[0x20] = 0x5A; s.psw = 1 },
            (0, 0, 0, 0xEF, 0x203, psw), 6); // dd,ds
        assert_eq!(s.aram[0x10], res);
        let s = case!(t, [base + 0x19], |s| { s.x = 0x10; s.y = 0x20; s.aram[0x10] = 0xC3; s.aram[0x20] = 0x5A; s.psw = 1 },
            (0, 0x10, 0x20, 0xEF, 0x201, psw), 5); // (X),(Y)
        assert_eq!(s.aram[0x10], res);
    }
    // Half carry out of bit 3: $19 + $28 → H.
    case!(t, [0x88, 0x28], |s| s.a = 0x19, (0x41, 0, 0, 0xEF, 0x202, 0x08), 2);
    // Zero result.
    case!(t, [0x28, 0x0F], |s| s.a = 0xF0, (0, 0, 0, 0xEF, 0x202, 0x02), 2);

    // Columns 4-8, rows C-F: MOV A loads and stores in the same modes.
    for (off, tail, x, y, ea, cyc) in MODES {
        let pc = 0x201 + tail.len() as u16;
        let code = [&[0xE0 + off][..], tail].concat();
        case!(t, code, |s| { s.x = x; s.y = y; s.psw = 1; place(s, off, ea, 0x5A) }, (0x5A, x, y, 0xEF, pc, 0x01), cyc);
        let code = [&[0xC0 + off][..], tail].concat();
        let s = case!(t, code, |s| { s.a = 0x80; s.x = x; s.y = y; place(s, off, ea, 0) }, (0x80, x, y, 0xEF, pc, 0), cyc + 1);
        assert_eq!(s.aram[ea as usize], 0x80, "store {:02X}", 0xC0 + off);
    }
    case!(t, [0xE8, 0x00], |s| s.a = 0x33, (0, 0, 0, 0xEF, 0x202, 0x02), 2);
    case!(t, [0xE4, 0x10], |s| { s.psw = 0x20; s.aram[0x110] = 0x77 }, (0x77, 0, 0, 0xEF, 0x202, 0x20), 3);
    case!(t, [0xF4, 0x1B], |s| { s.x = 0xF5; s.aram[0x10] = 0x77 }, (0x77, 0xF5, 0, 0xEF, 0x202, 0), 4); // d+X wraps in the page

    // Columns 8-9, rows C-F: X register moves and compares.
    case!(t, [0xC8, 0x41], |s| s.x = 0x40, (0, 0x40, 0, 0xEF, 0x202, 0x80), 2); // CMP X,#i
    let s = case!(t, [0xD8, 0x10], |s| s.x = 0x77, (0, 0x77, 0, 0xEF, 0x202, 0), 4); // MOV d,X
    assert_eq!(s.aram[0x10], 0x77);
    case!(t, [0xF8, 0x10], |s| s.aram[0x10] = 0x80, (0, 0x80, 0, 0xEF, 0x202, 0x80), 3); // MOV X,d
    let s = case!(t, [0xC9, 0x34, 0x12], |s| s.x = 0x77, (0, 0x77, 0, 0xEF, 0x203, 0), 5); // MOV !a,X
    assert_eq!(s.aram[0x1234], 0x77);
    let s = case!(t, [0xD9, 0x0B], |s| { s.x = 0x77; s.y = 5 }, (0, 0x77, 5, 0xEF, 0x202, 0), 5); // MOV d+Y,X
    assert_eq!(s.aram[0x10], 0x77);
    case!(t, [0xE9, 0x34, 0x12], |s| s.x = 0x55, (0, 0, 0, 0xEF, 0x203, 0x02), 4); // MOV X,!a
    case!(t, [0xF9, 0x0B], |s| { s.y = 5; s.aram[0x10] = 1 }, (0, 1, 5, 0xEF, 0x202, 0), 4); // MOV X,d+Y

    // Column A: bit operations on m.b ($1234 bit 5 → operand $B234), 16-bit words, MOV dd,ds.
    let bit = |v: u8, psw: u8| move |s: &mut Spc700| { s.aram[0x1234] = v; s.psw = psw };
    case!(t, [0x0A, 0x34, 0xB2], bit(0x20, 0), (0, 0, 0, 0xEF, 0x203, 0x01), 5); // OR1 C,m.b
    case!(t, [0x2A, 0x34, 0xB2], bit(0x20, 0), (0, 0, 0, 0xEF, 0x203, 0x00), 5); // OR1 C,/m.b
    case!(t, [0x4A, 0x34, 0xB2], bit(0x00, 1), (0, 0, 0, 0xEF, 0x203, 0x00), 4); // AND1 C,m.b
    case!(t, [0x6A, 0x34, 0xB2], bit(0x00, 1), (0, 0, 0, 0xEF, 0x203, 0x01), 4); // AND1 C,/m.b
    case!(t, [0x8A, 0x34, 0xB2], bit(0x20, 1), (0, 0, 0, 0xEF, 0x203, 0x00), 5); // EOR1 C,m.b
    case!(t, [0xAA, 0x34, 0xB2], bit(0x20, 0), (0, 0, 0, 0xEF, 0x203, 0x01), 4); // MOV1 C,m.b
    let s = case!(t, [0xCA, 0x34, 0xB2], bit(0x00, 1), (0, 0, 0, 0xEF, 0x203, 0x01), 6); // MOV1 m.b,C
    assert_eq!(s.aram[0x1234], 0x20);
    let s = case!(t, [0xEA, 0x34, 0xB2], bit(0x21, 0), (0, 0, 0, 0xEF, 0x203, 0), 5); // NOT1 m.b
    assert_eq!(s.aram[0x1234], 0x01);
    let s = case!(t, [0x1A, 0x10], |s| s.aram[0x10..0x12].copy_from_slice(&[0x00, 0x01]),
        (0, 0, 0, 0xEF, 0x202, 0), 6); // DECW $0100 → $00FF
    assert_eq!(s.aram[0x10..0x12], [0xFF, 0x00]);
    let s = case!(t, [0x3A, 0x10], |s| s.aram[0x10..0x12].copy_from_slice(&[0xFF, 0xFF]),
        (0, 0, 0, 0xEF, 0x202, 0x02), 6); // INCW $FFFF → 0, Z
    assert_eq!(s.aram[0x10..0x12], [0x00, 0x00]);
    case!(t, [0x5A, 0x10], |s| { s.y = 0x12; s.a = 0x34; s.aram[0x10..0x12].copy_from_slice(&[0x35, 0x12]) },
        (0x34, 0, 0x12, 0xEF, 0x202, 0x80), 4); // CMPW $1234 - $1235: N, borrow
    case!(t, [0x7A, 0x10], |s| { s.y = 0x0F; s.a = 0xF0; s.psw = 1; s.aram[0x10..0x12].copy_from_slice(&[0x20, 0x00]) },
        (0x10, 0, 0x10, 0xEF, 0x202, 0x08), 5); // ADDW $0FF0 + $0020 = $1010, H, carry in ignored
    case!(t, [0x9A, 0x10], |s| { s.y = 0x10; s.a = 0x00; s.aram[0x10..0x12].copy_from_slice(&[0x01, 0x00]) },
        (0xFF, 0, 0x0F, 0xEF, 0x202, 0x01), 5); // SUBW $1000 - 1 = $0FFF, C (no borrow)
    case!(t, [0xBA, 0x10], |s| s.aram[0x10..0x12].copy_from_slice(&[0x34, 0x92]),
        (0x34, 0, 0x92, 0xEF, 0x202, 0x80), 5); // MOVW YA,d
    let s = case!(t, [0xDA, 0x10], |s| { s.a = 0x34; s.y = 0x12 }, (0x34, 0, 0x12, 0xEF, 0x202, 0), 5); // MOVW d,YA
    assert_eq!(s.aram[0x10..0x12], [0x34, 0x12]);
    let s = case!(t, [0xFA, 0x20, 0x10], |s| s.aram[0x20] = 0x80, (0, 0, 0, 0xEF, 0x203, 0), 5); // MOV dd,ds
    assert_eq!(s.aram[0x10], 0x80);

    // Columns B-C, rows 0-B: shifts, rotates, INC/DEC on d, d+X, !a and A.
    let mem = |ea: usize, v: u8, x: u8, psw: u8| move |s: &mut Spc700| { s.aram[ea] = v; s.x = x; s.psw = psw };
    let rmw: [(u8, &[u8], u8, u8, u8, u8, u8, u32); 18] = [
        // opcode, operands, X, value, PSW in, result, PSW out, cycles
        (0x0B, &[0x10], 0, 0x81, 0, 0x02, 0x01, 4),       // ASL d
        (0x1B, &[0x0B], 5, 0x40, 0, 0x80, 0x80, 5),       // ASL d+X
        (0x0C, &[0x34, 0x12], 0, 0x80, 0, 0x00, 0x03, 5), // ASL !a
        (0x2B, &[0x10], 0, 0x80, 1, 0x01, 0x01, 4),       // ROL d
        (0x3B, &[0x0B], 5, 0x40, 0, 0x80, 0x80, 5),       // ROL d+X
        (0x2C, &[0x34, 0x12], 0, 0x00, 1, 0x01, 0x00, 5), // ROL !a
        (0x4B, &[0x10], 0, 0x01, 0, 0x00, 0x03, 4),       // LSR d
        (0x5B, &[0x0B], 5, 0x80, 0, 0x40, 0x00, 5),       // LSR d+X
        (0x4C, &[0x34, 0x12], 0, 0x03, 0, 0x01, 0x01, 5), // LSR !a
        (0x6B, &[0x10], 0, 0x02, 1, 0x81, 0x80, 4),       // ROR d
        (0x7B, &[0x0B], 5, 0x01, 0, 0x00, 0x03, 5),       // ROR d+X
        (0x6C, &[0x34, 0x12], 0, 0x01, 1, 0x80, 0x81, 5), // ROR !a
        (0x8B, &[0x10], 0, 0x01, 1, 0x00, 0x03, 4),       // DEC d (carry untouched)
        (0x9B, &[0x0B], 5, 0x00, 0, 0xFF, 0x80, 5),       // DEC d+X
        (0x8C, &[0x34, 0x12], 0, 0x81, 0, 0x80, 0x80, 5), // DEC !a
        (0xAB, &[0x10], 0, 0xFF, 0, 0x00, 0x02, 4),       // INC d
        (0xBB, &[0x0B], 5, 0x7F, 0, 0x80, 0x80, 5),       // INC d+X
        (0xAC, &[0x34, 0x12], 0, 0x00, 0, 0x01, 0x00, 5), // INC !a
    ];
    for (op, tail, x, v, pin, res, pout, cyc) in rmw {
        let ea = if tail.len() == 2 { 0x1234 } else { 0x10 };
        let code = [&[op][..], tail].concat();
        let s = case!(t, code, mem(ea, v, x, pin), (0, x, 0, 0xEF, 0x201 + tail.len() as u16, pout), cyc);
        assert_eq!(s.aram[ea], res, "opcode {op:02X}");
    }
    case!(t, [0x1C], |s| s.a = 0x01, (0x02, 0, 0, 0xEF, 0x201, 0), 2); // ASL A
    case!(t, [0x3C], |s| s.a = 0x80, (0x00, 0, 0, 0xEF, 0x201, 0x03), 2); // ROL A
    case!(t, [0x5C], |s| { s.a = 0x02; s.psw = 1 }, (0x01, 0, 0, 0xEF, 0x201, 0), 2); // LSR A
    case!(t, [0x7C], |s| s.a = 0x04, (0x02, 0, 0, 0xEF, 0x201, 0), 2); // ROR A
    case!(t, [0x9C], |s| s.a = 0x10, (0x0F, 0, 0, 0xEF, 0x201, 0), 2); // DEC A
    case!(t, [0xBC], |s| s.a = 0x7F, (0x80, 0, 0, 0xEF, 0x201, 0x80), 2); // INC A

    // Columns B-C, rows C-F: Y moves.
    let s = case!(t, [0xCB, 0x10], |s| s.y = 0x33, (0, 0, 0x33, 0xEF, 0x202, 0), 4); // MOV d,Y
    assert_eq!(s.aram[0x10], 0x33);
    let s = case!(t, [0xDB, 0x0B], |s| { s.x = 5; s.y = 0x33 }, (0, 5, 0x33, 0xEF, 0x202, 0), 5); // MOV d+X,Y
    assert_eq!(s.aram[0x10], 0x33);
    case!(t, [0xEB, 0x10], |s| s.y = 0x44, (0, 0, 0, 0xEF, 0x202, 0x02), 3); // MOV Y,d
    case!(t, [0xFB, 0x0B], |s| { s.x = 5; s.aram[0x10] = 0x90 }, (0, 5, 0x90, 0xEF, 0x202, 0x80), 4); // MOV Y,d+X
    let s = case!(t, [0xCC, 0x34, 0x12], |s| s.y = 0x33, (0, 0, 0x33, 0xEF, 0x203, 0), 5); // MOV !a,Y
    assert_eq!(s.aram[0x1234], 0x33);
    case!(t, [0xDC], |_| {}, (0, 0, 0xFF, 0xEF, 0x201, 0x80), 2); // DEC Y
    case!(t, [0xEC, 0x34, 0x12], |s| s.aram[0x1234] = 0x12, (0, 0, 0x12, 0xEF, 0x203, 0), 4); // MOV Y,!a
    case!(t, [0xFC], |s| s.y = 0xFF, (0, 0, 0, 0xEF, 0x201, 0x02), 2); // INC Y

    // Column D: pushes, register transfers, immediates.
    let s = case!(t, [0x0D], |s| s.psw = 0xC3, (0, 0, 0, 0xEE, 0x201, 0xC3), 4); // PUSH PSW
    assert_eq!(s.aram[0x1EF], 0xC3);
    let s = case!(t, [0x2D], |s| s.a = 0x42, (0x42, 0, 0, 0xEE, 0x201, 0), 4); // PUSH A
    assert_eq!(s.aram[0x1EF], 0x42);
    let s = case!(t, [0x4D], |s| s.x = 0x43, (0, 0x43, 0, 0xEE, 0x201, 0), 4); // PUSH X
    assert_eq!(s.aram[0x1EF], 0x43);
    let s = case!(t, [0x6D], |s| s.y = 0x44, (0, 0, 0x44, 0xEE, 0x201, 0), 4); // PUSH Y
    assert_eq!(s.aram[0x1EF], 0x44);
    case!(t, [0x1D], |s| s.x = 1, (0, 0, 0, 0xEF, 0x201, 0x02), 2); // DEC X
    case!(t, [0x3D], |s| s.x = 0x7F, (0, 0x80, 0, 0xEF, 0x201, 0x80), 2); // INC X
    case!(t, [0x5D], |s| s.a = 0x80, (0x80, 0x80, 0, 0xEF, 0x201, 0x80), 2); // MOV X,A
    case!(t, [0x7D], |s| s.a = 5, (0, 0, 0, 0xEF, 0x201, 0x02), 2); // MOV A,X
    case!(t, [0x8D, 0x7F], |_| {}, (0, 0, 0x7F, 0xEF, 0x202, 0), 2); // MOV Y,#i
    case!(t, [0x9D], |_| {}, (0, 0xEF, 0, 0xEF, 0x201, 0x80), 2); // MOV X,SP
    case!(t, [0xAD, 0x40], |s| s.y = 0x40, (0, 0, 0x40, 0xEF, 0x202, 0x03), 2); // CMP Y,#i
    case!(t, [0xBD], |_| {}, (0, 0, 0, 0x00, 0x201, 0), 2); // MOV SP,X: no flags
    case!(t, [0xCD, 0x00], |s| s.x = 5, (0, 0, 0, 0xEF, 0x202, 0x02), 2); // MOV X,#i
    case!(t, [0xDD], |s| s.y = 0x81, (0x81, 0, 0x81, 0xEF, 0x201, 0x80), 2); // MOV A,Y
    case!(t, [0xED], |s| s.psw = 0x01, (0, 0, 0, 0xEF, 0x201, 0), 3); // NOTC
    case!(t, [0xFD], |s| s.a = 1, (1, 0, 1, 0xEF, 0x201, 0), 2); // MOV Y,A

    // Column E: test-and-set, compares, CBNE/DBNZ, pops, DIV, DAS.
    let s = case!(t, [0x0E, 0x34, 0x12], |s| { s.a = 0x0F; s.aram[0x1234] = 0x30 }, (0x0F, 0, 0, 0xEF, 0x203, 0x80), 6); // TSET1
    assert_eq!(s.aram[0x1234], 0x3F);
    let s = case!(t, [0x4E, 0x34, 0x12], |s| { s.a = 0x0F; s.aram[0x1234] = 0x3F }, (0x0F, 0, 0, 0xEF, 0x203, 0x80), 6); // TCLR1
    assert_eq!(s.aram[0x1234], 0x30);
    case!(t, [0x1E, 0x34, 0x12], |s| { s.x = 0x10; s.aram[0x1234] = 0x10 }, (0, 0x10, 0, 0xEF, 0x203, 0x03), 4); // CMP X,!a
    case!(t, [0x3E, 0x10], |s| { s.x = 0x10; s.aram[0x10] = 0x20 }, (0, 0x10, 0, 0xEF, 0x202, 0x80), 3); // CMP X,d
    case!(t, [0x5E, 0x34, 0x12], |s| { s.y = 0x20; s.aram[0x1234] = 0x10 }, (0, 0, 0x20, 0xEF, 0x203, 0x01), 4); // CMP Y,!a
    case!(t, [0x7E, 0x10], |s| s.aram[0x10] = 1, (0, 0, 0, 0xEF, 0x202, 0x80), 3); // CMP Y,d
    case!(t, [0x2E, 0x10, 0x05], |s| { s.a = 1; s.aram[0x10] = 2 }, (1, 0, 0, 0xEF, 0x208, 0), 7); // CBNE taken
    case!(t, [0xDE, 0x0B, 0x05], |s| { s.a = 2; s.x = 5; s.aram[0x10] = 2 }, (2, 5, 0, 0xEF, 0x203, 0), 6); // CBNE d+X
    let s = case!(t, [0x6E, 0x10, 0xFD], |s| s.aram[0x10] = 1, (0, 0, 0, 0xEF, 0x203, 0), 5); // DBNZ d, falls through
    assert_eq!(s.aram[0x10], 0);
    case!(t, [0xFE, 0xFE], |s| s.y = 2, (0, 0, 1, 0xEF, 0x200, 0), 6); // DBNZ Y, taken
    let pop = |v: u8| move |s: &mut Spc700| { s.sp = 0xEE; s.aram[0x1EF] = v };
    case!(t, [0x8E], pop(0xC3), (0, 0, 0, 0xEF, 0x201, 0xC3), 4); // POP PSW
    case!(t, [0xAE], pop(0x55), (0x55, 0, 0, 0xEF, 0x201, 0), 4); // POP A: no flags
    case!(t, [0xCE], pop(0x80), (0, 0x80, 0, 0xEF, 0x201, 0), 4); // POP X
    case!(t, [0xEE], pop(0x01), (0, 0, 1, 0xEF, 0x201, 0), 4); // POP Y
    case!(t, [0x9E], |s| { s.y = 0x01; s.a = 0x23; s.x = 0x10 }, (0x12, 0x10, 0x03, 0xEF, 0x201, 0x08), 12); // DIV $0123 / $10
    case!(t, [0xBE], |s| { s.a = 0x2F; s.psw = 0x01 }, (0x29, 0, 0, 0xEF, 0x201, 0x01), 3); // DAS: $46 - $17 → $29

    // Column F: BRK, jumps, calls, returns, MOV d,#i, XCN, auto-increment, MUL, DAA, SLEEP/STOP.
    let s = case!(t, [0x0F], |s| { s.psw = 0x05; s.aram[0xFFDE..0xFFE0].copy_from_slice(&[0x00, 0x30]) },
        (0, 0, 0, 0xEC, 0x3000, 0x11), 8); // BRK: B set, I cleared
    assert_eq!(s.aram[0x1ED..0x1F0], [0x05, 0x01, 0x02]);
    case!(t, [0x1F, 0x30, 0x12], |s| { s.x = 4; s.aram[0x1234..0x1236].copy_from_slice(&[0x78, 0x56]) },
        (0, 4, 0, 0xEF, 0x5678, 0), 6); // JMP [!a+X]
    case!(t, [0x2F, 0x10], |_| {}, (0, 0, 0, 0xEF, 0x212, 0), 4); // BRA
    let s = case!(t, [0x3F, 0x34, 0x12], |_| {}, (0, 0, 0, 0xED, 0x1234, 0), 8); // CALL
    assert_eq!(s.aram[0x1EE..0x1F0], [0x03, 0x02]);
    let s = case!(t, [0x4F, 0x20], |_| {}, (0, 0, 0, 0xED, 0xFF20, 0), 6); // PCALL
    assert_eq!(s.aram[0x1EE..0x1F0], [0x02, 0x02]);
    case!(t, [0x5F, 0x34, 0x12], |_| {}, (0, 0, 0, 0xEF, 0x1234, 0), 3); // JMP !a
    case!(t, [0x6F], |s| { s.sp = 0xED; s.aram[0x1EE..0x1F0].copy_from_slice(&[0x34, 0x12]) },
        (0, 0, 0, 0xEF, 0x1234, 0), 5); // RET
    case!(t, [0x7F], |s| { s.sp = 0xEC; s.aram[0x1ED..0x1F0].copy_from_slice(&[0xC3, 0x34, 0x12]) },
        (0, 0, 0, 0xEF, 0x1234, 0xC3), 6); // RETI
    let s = case!(t, [0x8F, 0x80, 0x10], |_| {}, (0, 0, 0, 0xEF, 0x203, 0), 5); // MOV d,#i: no flags
    assert_eq!(s.aram[0x10], 0x80);
    case!(t, [0x9F], |s| s.a = 0x08, (0x80, 0, 0, 0xEF, 0x201, 0x80), 5); // XCN
    let s = case!(t, [0xAF], |s| { s.a = 0x42; s.x = 0x10 }, (0x42, 0x11, 0, 0xEF, 0x201, 0), 4); // MOV (X)+,A
    assert_eq!(s.aram[0x10], 0x42);
    case!(t, [0xBF], |s| { s.a = 5; s.x = 0x10 }, (0, 0x11, 0, 0xEF, 0x201, 0x02), 4); // MOV A,(X)+
    case!(t, [0xCF], |s| { s.y = 0x12; s.a = 0x34 }, (0xA8, 0, 0x03, 0xEF, 0x201, 0), 9); // MUL: $12 × $34 = $03A8
    case!(t, [0xDF], |s| { s.a = 0x41; s.psw = 0x08 }, (0x47, 0, 0, 0xEF, 0x201, 0x08), 3); // DAA: $19 + $28 → $47
    let s = case!(t, [0xEF], |_| {}, (0, 0, 0, 0xEF, 0x201, 0), 3); // SLEEP
    assert!(s.halted);
    let s = case!(t, [0xFF], |_| {}, (0, 0, 0, 0xEF, 0x201, 0), 3); // STOP
    assert!(s.halted);

    let missing: Vec<String> = (0..256).filter(|&o| !t.seen[o]).map(|o| format!("{o:02X}")).collect();
    assert!(missing.is_empty(), "opcodes never exercised: {missing:?}");
}

#[test]
fn div_edge_cases() {
    // Division by zero and quotient overflow, per the documented DIV algorithm: A = $FF.
    let mut t = Runner { seen: [false; 256] };
    case!(t, [0x9E], |s| s.a = 0x10, (0xFF, 0, 0x10, 0xEF, 0x201, 0xC8), 12);
    case!(t, [0x9E], |s| { s.y = 0x04; s.x = 0x02 }, (0xFF, 0x02, 0x02, 0xEF, 0x201, 0xC8), 12);
}

#[test]
fn daa_and_das_adjust_with_carry() {
    let mut t = Runner { seen: [false; 256] };
    // $99 + $01 = $9A → DAA → $00 with carry.
    case!(t, [0xDF], |s| s.a = 0x9A, (0x00, 0, 0, 0xEF, 0x201, 0x03), 3);
    // $10 - $20 = $F0 with a borrow (C clear) → DAS → $90, C stays clear.
    case!(t, [0xBE], |s| { s.a = 0xF0; s.psw = 0x08 }, (0x90, 0, 0, 0xEF, 0x201, 0x88), 3);
}

#[test]
fn a_halted_core_stays_put_but_timers_run() {
    let (mut spc, mut dsp) = (Spc700::new(), Dsp::default());
    spc.aram[0x200] = 0xEF; // SLEEP
    spc.pc = 0x200;
    spc.write(0xFC, 1, &mut dsp);
    spc.write(0xF1, 0x04, &mut dsp);
    let mut cycles = 0;
    while cycles < 3 + 16 * 4 {
        cycles += spc.step(&mut dsp);
    }
    assert_eq!(spc.pc, 0x201);
    assert_eq!(spc.read(0xFF, &mut dsp), 4);
}

#[test]
fn timer_loop_program_counts_overflows() {
    // AC2: timer 0 at target 1 overflows every 128 cycles; the loop adds $FD into $10.
    let program = [
        0x8F, 0x01, 0xFA, // MOV $FA,#$01      5
        0x8F, 0x01, 0xF1, // MOV $F1,#$01      5
        0xE4, 0xFD, //       loop: MOV A,$FD   3
        0x60, //             CLRC              2
        0x84, 0x10, //       ADC A,$10         3
        0xC4, 0x10, //       MOV $10,A         4
        0x2F, 0xF7, //       BRA loop          4
    ];
    let (mut spc, mut dsp) = (Spc700::new(), Dsp::default());
    spc.aram[0x200..0x200 + program.len()].copy_from_slice(&program);
    spc.pc = 0x200;
    let mut cycles = 0;
    // 10 cycles of setup, then 85 loops of 16: overflows at cycles 128, 256 … 1280 are all read.
    while cycles < 10 + 16 * 85 {
        cycles += spc.step(&mut dsp);
    }
    assert_eq!(cycles, 1370);
    assert_eq!(spc.aram[0x10], 10);
}

#[test]
fn a_program_writes_the_dsp() {
    // AC3 through code: MOV $F2,#$4C; MOV $F3,#$01.
    let (mut spc, mut dsp) = (Spc700::new(), Dsp::default());
    spc.aram[0x200..0x206].copy_from_slice(&[0x8F, 0x4C, 0xF2, 0x8F, 0x01, 0xF3]);
    spc.pc = 0x200;
    spc.step(&mut dsp);
    spc.step(&mut dsp);
    assert_eq!(dsp.writes, vec![(0x4C, 0x01)]);
}
