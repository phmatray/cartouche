//! SPC700: the SNES audio CPU that runs Super Game Boy sound programs (uploaded with `SOU_TRN`).
//!
//! Clean-room from public documentation (fullsnes, Anomie's SPC700 doc). 64 KB of audio RAM, the
//! `$F0-$FF` registers and three timers. There is no IPL ROM: `$FFC0-$FFFF` always reads RAM, and
//! programs are placed in `aram` directly. The S-DSP sits behind [`DspBus`] (`$F2`/`$F3`); it reads
//! its samples from the public `aram`.

/// The S-DSP's 128 registers as the SPC700 sees them through `$F2`/`$F3`.
pub trait DspBus {
    fn read(&mut self, reg: u8) -> u8;
    fn write(&mut self, reg: u8, value: u8);
}

/// Cycles of the 1.024 MHz SPC700 clock per timer tick: 8 kHz for timers 0-1, 64 kHz for timer 2.
const TIMER_PERIOD: [u32; 3] = [128, 128, 16];

#[derive(Clone, Copy, Default)]
struct Timer {
    /// `$FA-$FC`; 0 means 256.
    target: u8,
    /// The internal 8-bit counter compared with `target`.
    stage: u8,
    /// The 4-bit counter read (and cleared) at `$FD-$FF`.
    out: u8,
    /// SPC700 cycles towards the next tick.
    div: u32,
}

pub struct Spc700 {
    pub a: u8,
    pub x: u8,
    pub y: u8,
    pub sp: u8,
    pub pc: u16,
    pub psw: u8,
    pub aram: Box<[u8; 0x10000]>,
    /// Written by the other side (the SGB), read by the SPC700 at `$F4-$F7`.
    pub ports_in: [u8; 4],
    /// Written by the SPC700 at `$F4-$F7`, read by the other side.
    pub ports_out: [u8; 4],
    /// Set by `SLEEP`/`STOP`: the core stops executing until reset.
    pub halted: bool,
    dsp_addr: u8,
    control: u8,
    timers: [Timer; 3],
}

impl Default for Spc700 {
    fn default() -> Self {
        Self::new()
    }
}

impl Spc700 {
    pub fn new() -> Self {
        Spc700 {
            a: 0,
            x: 0,
            y: 0,
            sp: 0xEF,
            pc: 0,
            psw: 0,
            aram: vec![0; 0x10000].into_boxed_slice().try_into().unwrap(),
            ports_in: [0; 4],
            ports_out: [0; 4],
            halted: false,
            dsp_addr: 0,
            control: 0,
            timers: [Timer::default(); 3],
        }
    }

    pub fn read(&mut self, addr: u16, dsp: &mut impl DspBus) -> u8 {
        match addr {
            0xF2 => self.dsp_addr,
            0xF3 => dsp.read(self.dsp_addr & 0x7F),
            0xF4..=0xF7 => self.ports_in[addr as usize - 0xF4],
            0xFD..=0xFF => std::mem::take(&mut self.timers[addr as usize - 0xFD].out),
            // Write-only registers.
            0xF0 | 0xF1 | 0xFA..=0xFC => 0,
            _ => self.aram[addr as usize],
        }
    }

    /// Register writes also land in the RAM underneath, as on hardware.
    pub fn write(&mut self, addr: u16, value: u8, dsp: &mut impl DspBus) {
        match addr {
            // $F0 (test register) is accepted and ignored: its speed/halt bits are unsafe on hardware.
            0xF1 => {
                for (i, t) in self.timers.iter_mut().enumerate() {
                    // Enabling a stopped timer restarts both of its counters.
                    if value & !self.control & (1 << i) != 0 {
                        t.stage = 0;
                        t.out = 0;
                    }
                }
                if value & 0x10 != 0 {
                    self.ports_in[0] = 0;
                    self.ports_in[1] = 0;
                }
                if value & 0x20 != 0 {
                    self.ports_in[2] = 0;
                    self.ports_in[3] = 0;
                }
                self.control = value; // bit 7 (IPL ROM enable) has nothing to map
            }
            0xF2 => self.dsp_addr = value,
            0xF3 if self.dsp_addr < 0x80 => dsp.write(self.dsp_addr, value),
            0xF4..=0xF7 => self.ports_out[addr as usize - 0xF4] = value,
            0xFA..=0xFC => self.timers[addr as usize - 0xFA].target = value,
            _ => {}
        }
        self.aram[addr as usize] = value;
    }

    /// Runs one instruction (2 idle cycles while halted), advances the timers, returns SPC cycles.
    pub fn step(&mut self, dsp: &mut impl DspBus) -> u32 {
        let cycles = if self.halted { 2 } else { self.exec(dsp) };
        self.tick_timers(cycles);
        cycles
    }

    pub fn export_state(&self, out: &mut Vec<u8>) {
        out.extend_from_slice(&[self.a, self.x, self.y, self.sp]);
        out.extend_from_slice(&self.pc.to_le_bytes());
        out.extend_from_slice(&[self.psw, self.halted as u8, self.dsp_addr, self.control]);
        out.extend_from_slice(&self.ports_in);
        out.extend_from_slice(&self.ports_out);
        for t in &self.timers {
            out.extend_from_slice(&[t.target, t.stage, t.out]);
            out.extend_from_slice(&t.div.to_le_bytes());
        }
        out.extend_from_slice(&self.aram[..]);
    }

    /// Reads what `export_state` wrote at `*pos`; truncated data is rejected and changes nothing.
    pub fn import_state(&mut self, data: &[u8], pos: &mut usize) -> bool {
        const LEN: usize = 10 + 8 + 3 * 7 + 0x10000;
        let Some(d) = data.get(*pos..).and_then(|d| d.get(..LEN)) else { return false };
        *pos += LEN;
        [self.a, self.x, self.y, self.sp] = [d[0], d[1], d[2], d[3]];
        self.pc = u16::from_le_bytes([d[4], d[5]]);
        [self.psw, self.dsp_addr, self.control] = [d[6], d[8], d[9]];
        self.halted = d[7] != 0;
        self.ports_in.copy_from_slice(&d[10..14]);
        self.ports_out.copy_from_slice(&d[14..18]);
        for (i, (t, s)) in self.timers.iter_mut().zip(d[18..39].chunks(7)).enumerate() {
            // Clamped: a damaged state must not leave a timer ticking through billions of periods.
            *t = Timer {
                target: s[0],
                stage: s[1],
                out: s[2] & 0x0F,
                div: u32::from_le_bytes([s[3], s[4], s[5], s[6]]).min(TIMER_PERIOD[i] - 1),
            };
        }
        self.aram.copy_from_slice(&d[39..]);
        true
    }

    pub fn tick_timers(&mut self, cycles: u32) {
        for (i, t) in self.timers.iter_mut().enumerate() {
            t.div += cycles;
            while t.div >= TIMER_PERIOD[i] {
                t.div -= TIMER_PERIOD[i];
                if self.control & (1 << i) != 0 {
                    t.stage = t.stage.wrapping_add(1);
                    if t.stage == t.target {
                        t.stage = 0;
                        t.out = (t.out + 1) & 0x0F;
                    }
                }
            }
        }
    }
}

// PSW bits.
const N: u8 = 0x80;
const V: u8 = 0x40;
const P: u8 = 0x20;
const B: u8 = 0x10;
const H: u8 = 0x08;
const I: u8 = 0x04;
const Z: u8 = 0x02;
const C: u8 = 0x01;

// ─── Instruction set ───
//
// Cycle counts from fullsnes' SPC700 opcode table. Bus accesses are not cycle-timed and dummy
// reads are not performed.
// ponytail: instruction-granular timing; move timer ticks inside instructions if a program ever
// depends on the sub-instruction position of a timer read.
impl Spc700 {
    fn flag(&self, f: u8) -> bool {
        self.psw & f != 0
    }

    fn set(&mut self, f: u8, on: bool) {
        if on {
            self.psw |= f
        } else {
            self.psw &= !f
        }
    }

    fn nz(&mut self, v: u8) {
        self.set(N, v & 0x80 != 0);
        self.set(Z, v == 0);
    }

    fn nz16(&mut self, v: u16) {
        self.set(N, v & 0x8000 != 0);
        self.set(Z, v == 0);
    }

    fn ya(&self) -> u16 {
        u16::from_le_bytes([self.a, self.y])
    }

    fn set_ya(&mut self, v: u16) {
        [self.a, self.y] = v.to_le_bytes();
    }

    fn fetch(&mut self, dsp: &mut impl DspBus) -> u8 {
        let v = self.read(self.pc, dsp);
        self.pc = self.pc.wrapping_add(1);
        v
    }

    fn fetch16(&mut self, dsp: &mut impl DspBus) -> u16 {
        let lo = self.fetch(dsp);
        u16::from_le_bytes([lo, self.fetch(dsp)])
    }

    fn read16(&mut self, addr: u16, dsp: &mut impl DspBus) -> u16 {
        let lo = self.read(addr, dsp);
        u16::from_le_bytes([lo, self.read(addr.wrapping_add(1), dsp)])
    }

    /// Direct page: $00xx, or $01xx with P set.
    fn dp(&self, d: u8) -> u16 {
        if self.flag(P) { 0x100 | d as u16 } else { d as u16 }
    }

    /// A word in the direct page; its high byte wraps within the page.
    fn read_dp16(&mut self, d: u8, dsp: &mut impl DspBus) -> u16 {
        let lo = self.read(self.dp(d), dsp);
        u16::from_le_bytes([lo, self.read(self.dp(d.wrapping_add(1)), dsp)])
    }

    fn write_dp16(&mut self, d: u8, v: u16, dsp: &mut impl DspBus) {
        let [lo, hi] = v.to_le_bytes();
        self.write(self.dp(d), lo, dsp);
        self.write(self.dp(d.wrapping_add(1)), hi, dsp);
    }

    fn push(&mut self, v: u8, dsp: &mut impl DspBus) {
        self.write(0x100 | self.sp as u16, v, dsp);
        self.sp = self.sp.wrapping_sub(1);
    }

    fn pop(&mut self, dsp: &mut impl DspBus) -> u8 {
        self.sp = self.sp.wrapping_add(1);
        self.read(0x100 | self.sp as u16, dsp)
    }

    fn push16(&mut self, v: u16, dsp: &mut impl DspBus) {
        self.push((v >> 8) as u8, dsp);
        self.push(v as u8, dsp);
    }

    fn pop16(&mut self, dsp: &mut impl DspBus) -> u16 {
        let lo = self.pop(dsp);
        u16::from_le_bytes([lo, self.pop(dsp)])
    }

    fn a_dp(&mut self, dsp: &mut impl DspBus) -> u16 {
        let d = self.fetch(dsp);
        self.dp(d)
    }

    fn a_dpx(&mut self, dsp: &mut impl DspBus) -> u16 {
        let d = self.fetch(dsp);
        self.dp(d.wrapping_add(self.x))
    }

    fn a_dpy(&mut self, dsp: &mut impl DspBus) -> u16 {
        let d = self.fetch(dsp);
        self.dp(d.wrapping_add(self.y))
    }

    /// The operand address of the A-register columns 4-7 and the cycles of a load/ALU op there.
    fn a_col(&mut self, op: u8, dsp: &mut impl DspBus) -> (u16, u32) {
        match op & 0x1F {
            0x04 => (self.a_dp(dsp), 3),
            0x14 => (self.a_dpx(dsp), 4),
            0x05 => (self.fetch16(dsp), 4),
            0x15 => (self.fetch16(dsp).wrapping_add(self.x as u16), 5),
            0x06 => (self.dp(self.x), 3),
            0x16 => (self.fetch16(dsp).wrapping_add(self.y as u16), 5),
            0x07 => {
                let d = self.fetch(dsp).wrapping_add(self.x);
                (self.read_dp16(d, dsp), 6)
            }
            _ => {
                let d = self.fetch(dsp);
                (self.read_dp16(d, dsp).wrapping_add(self.y as u16), 6)
            }
        }
    }

    /// `m.b` operand: a 13-bit absolute address and a bit number; returns (address, bit, byte).
    fn mbit(&mut self, dsp: &mut impl DspBus) -> (u16, u8, u8) {
        let w = self.fetch16(dsp);
        let addr = w & 0x1FFF;
        (addr, (w >> 13) as u8, self.read(addr, dsp))
    }

    /// Relative branch: returns the 2 extra cycles of a taken branch.
    fn branch(&mut self, cond: bool, dsp: &mut impl DspBus) -> u32 {
        let r = self.fetch(dsp) as i8;
        if cond {
            self.pc = self.pc.wrapping_add(r as u16);
            2
        } else {
            0
        }
    }

    fn cmp(&mut self, a: u8, b: u8) {
        self.set(C, a >= b);
        self.nz(a.wrapping_sub(b));
    }

    fn adc(&mut self, a: u8, b: u8) -> u8 {
        let r = a as u16 + b as u16 + (self.psw & C) as u16;
        let r8 = r as u8;
        self.set(C, r > 0xFF);
        self.set(H, (a ^ b ^ r8) & 0x10 != 0);
        self.set(V, !(a ^ b) & (a ^ r8) & 0x80 != 0);
        self.nz(r8);
        r8
    }

    /// OR, AND, EOR, CMP, ADC, SBC by `op >> 5`; CMP leaves `a` as it is.
    fn alu(&mut self, k: u8, a: u8, b: u8) -> u8 {
        let r = match k {
            0 => a | b,
            1 => a & b,
            2 => a ^ b,
            3 => {
                self.cmp(a, b);
                return a;
            }
            4 => return self.adc(a, b),
            _ => return self.adc(a, !b),
        };
        self.nz(r);
        r
    }

    /// Columns 4-9, rows 0-B.
    fn alu_op(&mut self, op: u8, dsp: &mut impl DspBus) -> u32 {
        let k = op >> 5;
        match op & 0x1F {
            0x08 => {
                let v = self.fetch(dsp);
                self.a = self.alu(k, self.a, v);
                2
            }
            0x18 | 0x09 | 0x19 => {
                let (src, dst) = match op & 0x1F {
                    0x18 => {
                        let i = self.fetch(dsp);
                        (i, self.a_dp(dsp))
                    }
                    0x09 => {
                        let s = self.a_dp(dsp);
                        let v = self.read(s, dsp);
                        (v, self.a_dp(dsp))
                    }
                    _ => (self.read(self.dp(self.y), dsp), self.dp(self.x)),
                };
                let d = self.read(dst, dsp);
                let r = self.alu(k, d, src);
                if k != 3 {
                    self.write(dst, r, dsp);
                }
                if op & 0x1F == 0x09 { 6 } else { 5 }
            }
            _ => {
                let (addr, cycles) = self.a_col(op, dsp);
                let v = self.read(addr, dsp);
                self.a = self.alu(k, self.a, v);
                cycles
            }
        }
    }

    /// ASL, ROL, LSR, ROR, DEC, INC by `op >> 5`.
    fn rmw(&mut self, k: u8, v: u8) -> u8 {
        let c = self.psw & C;
        let r = match k {
            0 | 1 => {
                self.set(C, v & 0x80 != 0);
                v << 1 | if k == 1 { c } else { 0 }
            }
            2 | 3 => {
                self.set(C, v & 1 != 0);
                v >> 1 | if k == 3 { c << 7 } else { 0 }
            }
            4 => v.wrapping_sub(1),
            _ => v.wrapping_add(1),
        };
        self.nz(r);
        r
    }

    fn div(&mut self) {
        let (ya, x, y) = (self.ya() as u32, self.x as u32, self.y as u32);
        self.set(V, y >= x);
        self.set(H, y & 0x0F >= x & 0x0F);
        if y < x << 1 {
            self.a = (ya / x) as u8;
            self.y = (ya % x) as u8;
        } else {
            // Quotient overflow (and X = 0): the hardware's result, per Anomie's doc.
            let d = ya - (x << 9);
            self.a = 255u32.wrapping_sub(d / (256 - x)) as u8;
            self.y = (x + d % (256 - x)) as u8;
        }
        self.nz(self.a);
    }

    fn exec(&mut self, dsp: &mut impl DspBus) -> u32 {
        let op = self.fetch(dsp);
        match op {
            0x00 => 2, // NOP
            // BPL BMI BVC BVS BCC BCS BNE BEQ: flag N, V, C, Z by bits 7-6, taken if it equals bit 5.
            0x10 | 0x30 | 0x50 | 0x70 | 0x90 | 0xB0 | 0xD0 | 0xF0 => {
                let f = [N, V, C, Z][op as usize >> 6];
                2 + self.branch(self.flag(f) == (op & 0x20 != 0), dsp)
            }
            0x20 => { self.psw &= !P; 2 } // CLRP
            0x40 => { self.psw |= P; 2 } // SETP
            0x60 => { self.psw &= !C; 2 } // CLRC
            0x80 => { self.psw |= C; 2 } // SETC
            0xA0 => { self.psw |= I; 3 } // EI
            0xC0 => { self.psw &= !I; 3 } // DI
            0xE0 => { self.psw &= !(V | H); 2 } // CLRV
            // TCALL n
            _ if op & 0x0F == 0x01 => {
                self.push16(self.pc, dsp);
                self.pc = self.read16(0xFFDE - 2 * (op >> 4) as u16, dsp);
                8
            }
            // SET1 / CLR1 d.b
            _ if op & 0x0F == 0x02 => {
                let addr = self.a_dp(dsp);
                let (m, v) = (1 << (op >> 5), self.read(addr, dsp));
                self.write(addr, if op & 0x10 == 0 { v | m } else { v & !m }, dsp);
                4
            }
            // BBS / BBC d.b,r
            _ if op & 0x0F == 0x03 => {
                let addr = self.a_dp(dsp);
                let set = self.read(addr, dsp) >> (op >> 5) & 1 != 0;
                5 + self.branch(set == (op & 0x10 == 0), dsp)
            }
            0x00..=0xBF if matches!(op & 0x0F, 0x4..=0x9) => self.alu_op(op, dsp),
            // ASL ROL LSR ROR DEC INC on d, d+X, !a, A
            0x00..=0xBF if matches!(op & 0x0F, 0xB | 0xC) => {
                let k = op >> 5;
                let (addr, cycles) = match op & 0x1F {
                    0x0B => (self.a_dp(dsp), 4),
                    0x1B => (self.a_dpx(dsp), 5),
                    0x0C => (self.fetch16(dsp), 5),
                    _ => {
                        self.a = self.rmw(k, self.a);
                        return 2;
                    }
                };
                let v = self.read(addr, dsp);
                let r = self.rmw(k, v);
                self.write(addr, r, dsp);
                cycles
            }

            // MOV A to/from memory
            0xC4..=0xC7 | 0xD4..=0xD7 => {
                let (addr, cycles) = self.a_col(op, dsp);
                self.write(addr, self.a, dsp);
                cycles + 1
            }
            0xE4..=0xE7 | 0xF4..=0xF7 => {
                let (addr, cycles) = self.a_col(op, dsp);
                self.a = self.read(addr, dsp);
                self.nz(self.a);
                cycles
            }
            0xE8 => { self.a = self.fetch(dsp); self.nz(self.a); 2 }

            // X moves and compares
            0xC8 => { let v = self.fetch(dsp); self.cmp(self.x, v); 2 }
            0xD8 => { let addr = self.a_dp(dsp); self.write(addr, self.x, dsp); 4 }
            0xF8 => { let addr = self.a_dp(dsp); self.x = self.read(addr, dsp); self.nz(self.x); 3 }
            0xC9 => { let addr = self.fetch16(dsp); self.write(addr, self.x, dsp); 5 }
            0xD9 => { let addr = self.a_dpy(dsp); self.write(addr, self.x, dsp); 5 }
            0xE9 => { let addr = self.fetch16(dsp); self.x = self.read(addr, dsp); self.nz(self.x); 4 }
            0xF9 => { let addr = self.a_dpy(dsp); self.x = self.read(addr, dsp); self.nz(self.x); 4 }

            // OR1 AND1 EOR1 MOV1 C,m.b (and /m.b)
            0x0A | 0x2A | 0x4A | 0x6A | 0x8A | 0xAA => {
                let (_, b, v) = self.mbit(dsp);
                let (bit, c) = (v >> b & 1 != 0, self.flag(C));
                let (c, cycles) = match op {
                    0x0A => (c | bit, 5),
                    0x2A => (c | !bit, 5),
                    0x4A => (c & bit, 4),
                    0x6A => (c & !bit, 4),
                    0x8A => (c ^ bit, 5),
                    _ => (bit, 4),
                };
                self.set(C, c);
                cycles
            }
            0xCA => {
                let (addr, b, v) = self.mbit(dsp);
                let v = if self.flag(C) { v | 1 << b } else { v & !(1 << b) };
                self.write(addr, v, dsp);
                6
            }
            0xEA => { let (addr, b, v) = self.mbit(dsp); self.write(addr, v ^ 1 << b, dsp); 5 }

            // 16-bit words
            0x1A | 0x3A => {
                let d = self.fetch(dsp);
                let w = self.read_dp16(d, dsp);
                let r = if op == 0x3A { w.wrapping_add(1) } else { w.wrapping_sub(1) };
                self.write_dp16(d, r, dsp);
                self.nz16(r);
                6
            }
            0x5A => {
                let d = self.fetch(dsp);
                let (ya, w) = (self.ya(), self.read_dp16(d, dsp));
                self.set(C, ya >= w);
                self.nz16(ya.wrapping_sub(w));
                4
            }
            0x7A | 0x9A => {
                // ADDW / SUBW: two 8-bit ADC/SBC; H, V, C and N come from the high byte.
                let d = self.fetch(dsp);
                let w = self.read_dp16(d, dsp);
                let [lo, hi] = if op == 0x7A { w.to_le_bytes() } else { (!w).to_le_bytes() };
                self.set(C, op == 0x9A);
                self.a = self.adc(self.a, lo);
                self.y = self.adc(self.y, hi);
                self.set(Z, self.ya() == 0);
                5
            }
            0xBA => { let d = self.fetch(dsp); let w = self.read_dp16(d, dsp); self.set_ya(w); self.nz16(w); 5 }
            0xDA => { let d = self.fetch(dsp); self.write_dp16(d, self.ya(), dsp); 5 }
            0xFA => {
                let s = self.a_dp(dsp);
                let v = self.read(s, dsp);
                let d = self.a_dp(dsp);
                self.write(d, v, dsp);
                5
            }

            // Y moves
            0xCB => { let addr = self.a_dp(dsp); self.write(addr, self.y, dsp); 4 }
            0xDB => { let addr = self.a_dpx(dsp); self.write(addr, self.y, dsp); 5 }
            0xEB => { let addr = self.a_dp(dsp); self.y = self.read(addr, dsp); self.nz(self.y); 3 }
            0xFB => { let addr = self.a_dpx(dsp); self.y = self.read(addr, dsp); self.nz(self.y); 4 }
            0xCC => { let addr = self.fetch16(dsp); self.write(addr, self.y, dsp); 5 }
            0xEC => { let addr = self.fetch16(dsp); self.y = self.read(addr, dsp); self.nz(self.y); 4 }
            0xDC => { self.y = self.y.wrapping_sub(1); self.nz(self.y); 2 }
            0xFC => { self.y = self.y.wrapping_add(1); self.nz(self.y); 2 }

            // Stack and register transfers
            0x0D => { self.push(self.psw, dsp); 4 }
            0x2D => { self.push(self.a, dsp); 4 }
            0x4D => { self.push(self.x, dsp); 4 }
            0x6D => { self.push(self.y, dsp); 4 }
            0x8E => { self.psw = self.pop(dsp); 4 }
            0xAE => { self.a = self.pop(dsp); 4 }
            0xCE => { self.x = self.pop(dsp); 4 }
            0xEE => { self.y = self.pop(dsp); 4 }
            0x1D => { self.x = self.x.wrapping_sub(1); self.nz(self.x); 2 }
            0x3D => { self.x = self.x.wrapping_add(1); self.nz(self.x); 2 }
            0x5D => { self.x = self.a; self.nz(self.x); 2 }
            0x7D => { self.a = self.x; self.nz(self.a); 2 }
            0x8D => { self.y = self.fetch(dsp); self.nz(self.y); 2 }
            0x9D => { self.x = self.sp; self.nz(self.x); 2 }
            0xAD => { let v = self.fetch(dsp); self.cmp(self.y, v); 2 }
            0xBD => { self.sp = self.x; 2 }
            0xCD => { self.x = self.fetch(dsp); self.nz(self.x); 2 }
            0xDD => { self.a = self.y; self.nz(self.a); 2 }
            0xED => { self.psw ^= C; 3 }
            0xFD => { self.y = self.a; self.nz(self.y); 2 }

            // TSET1 / TCLR1 !a: N and Z from A - m
            0x0E | 0x4E => {
                let addr = self.fetch16(dsp);
                let v = self.read(addr, dsp);
                self.nz(self.a.wrapping_sub(v));
                self.write(addr, if op == 0x0E { v | self.a } else { v & !self.a }, dsp);
                6
            }
            0x1E => { let addr = self.fetch16(dsp); let v = self.read(addr, dsp); self.cmp(self.x, v); 4 }
            0x3E => { let addr = self.a_dp(dsp); let v = self.read(addr, dsp); self.cmp(self.x, v); 3 }
            0x5E => { let addr = self.fetch16(dsp); let v = self.read(addr, dsp); self.cmp(self.y, v); 4 }
            0x7E => { let addr = self.a_dp(dsp); let v = self.read(addr, dsp); self.cmp(self.y, v); 3 }
            0x2E => { let addr = self.a_dp(dsp); let v = self.read(addr, dsp); 5 + self.branch(self.a != v, dsp) }
            0xDE => { let addr = self.a_dpx(dsp); let v = self.read(addr, dsp); 6 + self.branch(self.a != v, dsp) }
            0x6E => {
                let addr = self.a_dp(dsp);
                let v = self.read(addr, dsp).wrapping_sub(1);
                self.write(addr, v, dsp);
                5 + self.branch(v != 0, dsp)
            }
            0xFE => { self.y = self.y.wrapping_sub(1); 4 + self.branch(self.y != 0, dsp) }
            0x9E => { self.div(); 12 }
            0xBE => {
                // DAS
                if !self.flag(C) || self.a > 0x99 {
                    self.a = self.a.wrapping_sub(0x60);
                    self.psw &= !C;
                }
                if !self.flag(H) || self.a & 0x0F > 9 {
                    self.a = self.a.wrapping_sub(6);
                }
                self.nz(self.a);
                3
            }
            0xDF => {
                // DAA
                if self.flag(C) || self.a > 0x99 {
                    self.a = self.a.wrapping_add(0x60);
                    self.psw |= C;
                }
                if self.flag(H) || self.a & 0x0F > 9 {
                    self.a = self.a.wrapping_add(6);
                }
                self.nz(self.a);
                3
            }

            // Control flow
            0x0F => {
                // BRK
                self.push16(self.pc, dsp);
                self.push(self.psw, dsp);
                self.psw = (self.psw | B) & !I;
                self.pc = self.read16(0xFFDE, dsp);
                8
            }
            0x1F => { let addr = self.fetch16(dsp).wrapping_add(self.x as u16); self.pc = self.read16(addr, dsp); 6 }
            0x2F => 2 + self.branch(true, dsp),
            0x3F => { let addr = self.fetch16(dsp); self.push16(self.pc, dsp); self.pc = addr; 8 }
            0x4F => { let u = self.fetch(dsp); self.push16(self.pc, dsp); self.pc = 0xFF00 | u as u16; 6 }
            0x5F => { self.pc = self.fetch16(dsp); 3 }
            0x6F => { self.pc = self.pop16(dsp); 5 }
            0x7F => { self.psw = self.pop(dsp); self.pc = self.pop16(dsp); 6 }

            // Column F leftovers
            0x8F => { let i = self.fetch(dsp); let addr = self.a_dp(dsp); self.write(addr, i, dsp); 5 }
            0x9F => { self.a = self.a.rotate_left(4); self.nz(self.a); 5 }
            0xAF => { self.write(self.dp(self.x), self.a, dsp); self.x = self.x.wrapping_add(1); 4 }
            0xBF => {
                self.a = self.read(self.dp(self.x), dsp);
                self.x = self.x.wrapping_add(1);
                self.nz(self.a);
                4
            }
            0xCF => { self.set_ya(self.y as u16 * self.a as u16); self.nz(self.y); 9 }
            0xEF | 0xFF => { self.halted = true; 3 } // SLEEP, STOP
            _ => unreachable!("opcode {op:02X} is decoded above"),
        }
    }
}
