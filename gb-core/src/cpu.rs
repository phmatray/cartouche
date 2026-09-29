use crate::error::CpuError;
use crate::interrupts::{SERIAL_BIT, TIMER_BIT};
use crate::memory::MemoryBus;
use crate::registers::Registers;

pub struct Cpu {
    pub regs: Registers,
    pub halted: bool,
    pub ime: bool,
    pub ime_pending: bool,
    pub stopped: bool,
    pub halt_bug: bool,
    /// Locked up by an invalid opcode, like hardware: `halted` for good, no interrupt wakes it.
    pub locked: bool,
    /// Address of the invalid opcode that locked it (0 while not locked).
    pub locked_pc: u16,
}

impl Cpu {
    pub fn new() -> Self {
        Self {
            regs: Registers::default(),
            halted: false,
            ime: false,
            ime_pending: false,
            stopped: false,
            halt_bug: false,
            locked: false,
            locked_pc: 0,
        }
    }

    /// Handle pending interrupts: wake HALT, dispatch when IME is on.
    pub fn handle_interrupts(&mut self, bus: &mut MemoryBus) {
        let pending = bus.interrupts.pending();
        if pending == 0 || self.stopped {
            return; // only a button wakes stop mode (see `step`)
        }
        if self.halted {
            // Off the hot path: only a halted CPU with an interrupt pending gets here.
            if self.locked || pending & !bus.late_interrupts() == 0 {
                return;
            }
            self.halted = false;
            bus.hdma_unhalt();
        }
        if self.ime {
            self.dispatch(bus);
        }
    }

    /// The 5 M-cycle interrupt dispatch: the fetch at PC it discards, PC back, SP down, then
    /// the two pushes (as SameBoy's `GB_cpu_run`, MIT: the pushes land in M-cycles 4 and 5, where
    /// Gambatte's hwtest `oamdma_src0000_busyint0002` sees them hit a running OAM DMA, one
    /// M-cycle after `busyrst0002`'s RST pushes from the same point), and the handler's first
    /// fetch at the vector.
    #[inline(never)]
    fn dispatch(&mut self, bus: &mut MemoryBus) {
        self.ime = false;
        self.ime_pending = false; // the handler starts with interrupts off
        // After a HALT bug (EI; HALT with an interrupt pending) PC was never advanced past the
        // HALT's next byte: the dispatch returns to the HALT itself.
        if self.halt_bug {
            self.halt_bug = false;
            self.regs.pc = self.regs.pc.wrapping_sub(1);
        }
        let pc = self.regs.pc;
        bus.cycle_tick(); // M1: the fetch at PC, discarded
        if bus.hdma_on && crate::memory::knob(10) != 0 {
            bus.hdma_run();
        }
        bus.cycle_tick(); // M2: PC--
        bus.cycle_idu(self.regs.sp); // M3: SP--
        self.regs.sp = self.regs.sp.wrapping_sub(1);
        bus.cycle_write(self.regs.sp, (pc >> 8) as u8); // M4: push PC high
        // The interrupt is picked from IE as that push left it and IF as M4's components left it:
        // a push that wrote IE ($FFFF) redirects the dispatch, or cancels it to $0000 (Mooneye
        // ie_push); a source rising in M4 is taken.
        let (bit, vector) = bus.interrupts.highest(bus.interrupts.interrupt_enable).unwrap_or((0, 0x0000));
        bus.interrupts.interrupt_flag &= !bit;
        self.regs.sp = self.regs.sp.wrapping_sub(1);
        bus.cycle_tick(); // M5: push PC low, PC = vector
        // The bit is let go at the halted CPU's sampling point of M5: that source rising again
        // before it is absorbed, after it (`late_interrupts`) it retriggers. Every source pins it
        // from both sides (Gambatte `*_late_retrigger_1/2`: mode 0 at SCX 0 and 1, mode 2,
        // LY = LYC, VBlank, TIMA, serial). On a CGB the sources clocked from DIV, TIMA and serial,
        // rise before that point, in both speeds (`tc00_irq_late_retrigger_2/_ds_2` and
        // `start_wait_trigger_int8_read_if_2/_ds_2`: $E0 on the CGB, $E4/$E8 on the DMG); in double
        // speed the PPU's rise after it (`*_late_retrigger_ds_1`).
        let div = if bus.cgb_mode || bus.ppu.compat { TIMER_BIT | SERIAL_BIT } else { 0 };
        let late = if bus.double_speed { !div } else { bus.late_interrupts() & !div };
        let kept = bit & bus.if_late & late;
        // A push that writes IF ($FF0F) doesn't change the pick, but the pick's bit is cleared
        // from what it wrote (Gambatte irq_precedence `late_if_via_sp_if_1/2`, `if_and_ie_0_vector_1..4`).
        bus.write_access(self.regs.sp, pc as u8);
        bus.interrupts.interrupt_flag &= !(bit & !kept);
        self.regs.pc = vector;
    }

    /// Execute one instruction. Returns the number of T-cycles consumed.
    pub fn step(&mut self, bus: &mut MemoryBus) -> Result<u32, CpuError> {
        // IME as this instruction sees it: an EI just before takes effect only after it.
        let ime = self.ime;
        if self.ime_pending {
            self.ime = true;
            self.ime_pending = false;
        }

        if self.stopped {
            bus.stop_tick();
            // A selected joypad line going low wakes it; with none selected only a reset would.
            if bus.read_byte(0xFF00) & 0x0F != 0x0F {
                self.stopped = false;
            }
            return Ok(4);
        }

        if self.halted {
            if bus.hdma_on && bus.hdma_grace && bus.ppu.mode_clock as i32 - bus.hdma_at_pub() >= crate::memory::knob(13) - 1 { bus.hdma_run(); }
            if bus.hdma_on && bus.hdma_grace { bus.hdma_run(); }
            bus.hdma_grace = false;
            if bus.hdma_on { bus.hdma_missed = true; }
            bus.hdma_on = false; // an HBlank block while halted waits for the wake (`MemoryBus::hdma_halt`)
            return Ok(4);
        }

        let opcode = self.fetch_byte(bus);
        if bus.hdma_on {
            bus.hdma_run();
        }

        match opcode {
            // === NOP ===
            0x00 => Ok(4),

            // === LD rr, d16 ===
            0x01 => { let v = self.fetch_u16(bus); self.regs.set_bc(v); Ok(12) }
            0x11 => { let v = self.fetch_u16(bus); self.regs.set_de(v); Ok(12) }
            0x21 => { let v = self.fetch_u16(bus); self.regs.set_hl(v); Ok(12) }
            0x31 => { self.regs.sp = self.fetch_u16(bus); Ok(12) }

            // === LD (rr), A / LD A, (rr) ===
            0x02 => { bus.cycle_write(self.regs.bc(), self.regs.a); Ok(8) }
            0x12 => { bus.cycle_write(self.regs.de(), self.regs.a); Ok(8) }
            0x22 => { let hl = self.regs.hl(); bus.cycle_write(hl, self.regs.a); self.regs.set_hl(hl.wrapping_add(1)); Ok(8) }
            0x32 => { let hl = self.regs.hl(); bus.cycle_write(hl, self.regs.a); self.regs.set_hl(hl.wrapping_sub(1)); Ok(8) }
            0x0A => { self.regs.a = bus.cycle_read(self.regs.bc()); Ok(8) }
            0x1A => { self.regs.a = bus.cycle_read(self.regs.de()); Ok(8) }
            0x2A => { let hl = self.regs.hl(); self.regs.a = bus.cycle_read_inc(hl); self.regs.set_hl(hl.wrapping_add(1)); Ok(8) }
            0x3A => { let hl = self.regs.hl(); self.regs.a = bus.cycle_read_inc(hl); self.regs.set_hl(hl.wrapping_sub(1)); Ok(8) }

            // === LD (a16), SP ===
            0x08 => { let addr = self.fetch_u16(bus); bus.cycle_write(addr, self.regs.sp as u8); bus.cycle_write(addr.wrapping_add(1), (self.regs.sp >> 8) as u8); Ok(20) }

            // === INC rr ===
            0x03 => { let v = self.regs.bc(); bus.cycle_idu(v); self.regs.set_bc(v.wrapping_add(1)); Ok(8) }
            0x13 => { let v = self.regs.de(); bus.cycle_idu(v); self.regs.set_de(v.wrapping_add(1)); Ok(8) }
            0x23 => { let v = self.regs.hl(); bus.cycle_idu(v); self.regs.set_hl(v.wrapping_add(1)); Ok(8) }
            0x33 => { bus.cycle_idu(self.regs.sp); self.regs.sp = self.regs.sp.wrapping_add(1); Ok(8) }

            // === DEC rr ===
            0x0B => { let v = self.regs.bc(); bus.cycle_idu(v); self.regs.set_bc(v.wrapping_sub(1)); Ok(8) }
            0x1B => { let v = self.regs.de(); bus.cycle_idu(v); self.regs.set_de(v.wrapping_sub(1)); Ok(8) }
            0x2B => { let v = self.regs.hl(); bus.cycle_idu(v); self.regs.set_hl(v.wrapping_sub(1)); Ok(8) }
            0x3B => { bus.cycle_idu(self.regs.sp); self.regs.sp = self.regs.sp.wrapping_sub(1); Ok(8) }

            // === ADD HL, rr ===
            0x09 => { self.add_hl(self.regs.bc()); bus.cycle_tick(); Ok(8) }
            0x19 => { self.add_hl(self.regs.de()); bus.cycle_tick(); Ok(8) }
            0x29 => { self.add_hl(self.regs.hl()); bus.cycle_tick(); Ok(8) }
            0x39 => { self.add_hl(self.regs.sp); bus.cycle_tick(); Ok(8) }

            // === INC r8 ===
            0x04 => { self.regs.b = self.inc(self.regs.b); Ok(4) }
            0x0C => { self.regs.c = self.inc(self.regs.c); Ok(4) }
            0x14 => { self.regs.d = self.inc(self.regs.d); Ok(4) }
            0x1C => { self.regs.e = self.inc(self.regs.e); Ok(4) }
            0x24 => { self.regs.h = self.inc(self.regs.h); Ok(4) }
            0x2C => { self.regs.l = self.inc(self.regs.l); Ok(4) }
            0x34 => { let hl = self.regs.hl(); let v = self.inc(bus.cycle_read(hl)); bus.cycle_write(hl, v); Ok(12) }
            0x3C => { self.regs.a = self.inc(self.regs.a); Ok(4) }

            // === DEC r8 ===
            0x05 => { self.regs.b = self.dec(self.regs.b); Ok(4) }
            0x0D => { self.regs.c = self.dec(self.regs.c); Ok(4) }
            0x15 => { self.regs.d = self.dec(self.regs.d); Ok(4) }
            0x1D => { self.regs.e = self.dec(self.regs.e); Ok(4) }
            0x25 => { self.regs.h = self.dec(self.regs.h); Ok(4) }
            0x2D => { self.regs.l = self.dec(self.regs.l); Ok(4) }
            0x35 => { let hl = self.regs.hl(); let v = self.dec(bus.cycle_read(hl)); bus.cycle_write(hl, v); Ok(12) }
            0x3D => { self.regs.a = self.dec(self.regs.a); Ok(4) }

            // === LD r8, d8 ===
            0x06 => { self.regs.b = self.fetch_byte(bus); Ok(8) }
            0x0E => { self.regs.c = self.fetch_byte(bus); Ok(8) }
            0x16 => { self.regs.d = self.fetch_byte(bus); Ok(8) }
            0x1E => { self.regs.e = self.fetch_byte(bus); Ok(8) }
            0x26 => { self.regs.h = self.fetch_byte(bus); Ok(8) }
            0x2E => { self.regs.l = self.fetch_byte(bus); Ok(8) }
            0x36 => { let v = self.fetch_byte(bus); bus.cycle_write(self.regs.hl(), v); Ok(12) }
            0x3E => { self.regs.a = self.fetch_byte(bus); Ok(8) }

            // === Rotate A ===
            0x07 => { self.rlca(); Ok(4) }
            0x0F => { self.rrca(); Ok(4) }
            0x17 => { self.rla(); Ok(4) }
            0x1F => { self.rra(); Ok(4) }

            // === DAA ===
            0x27 => { self.daa(); Ok(4) }

            // === CPL ===
            0x2F => {
                self.regs.a = !self.regs.a;
                self.regs.set_subtract(true);
                self.regs.set_half_carry(true);
                Ok(4)
            }

            // === SCF ===
            0x37 => {
                self.regs.set_subtract(false);
                self.regs.set_half_carry(false);
                self.regs.set_carry(true);
                Ok(4)
            }

            // === CCF ===
            0x3F => {
                self.regs.set_subtract(false);
                self.regs.set_half_carry(false);
                self.regs.set_carry(!self.regs.carry());
                Ok(4)
            }

            // === JR e8 ===
            0x18 => {
                let offset = self.fetch_byte(bus) as i8;
                self.regs.pc = self.regs.pc.wrapping_add(offset as u16);
                bus.cycle_tick(); // internal: branch
                Ok(12)
            }
            0x20 => {
                let offset = self.fetch_byte(bus) as i8;
                if !self.regs.zero() {
                    self.regs.pc = self.regs.pc.wrapping_add(offset as u16);
                    bus.cycle_tick();
                    Ok(12)
                } else { Ok(8) }
            }
            0x28 => {
                let offset = self.fetch_byte(bus) as i8;
                if self.regs.zero() {
                    self.regs.pc = self.regs.pc.wrapping_add(offset as u16);
                    bus.cycle_tick();
                    Ok(12)
                } else { Ok(8) }
            }
            0x30 => {
                let offset = self.fetch_byte(bus) as i8;
                if !self.regs.carry() {
                    self.regs.pc = self.regs.pc.wrapping_add(offset as u16);
                    bus.cycle_tick();
                    Ok(12)
                } else { Ok(8) }
            }
            0x38 => {
                let offset = self.fetch_byte(bus) as i8;
                if self.regs.carry() {
                    self.regs.pc = self.regs.pc.wrapping_add(offset as u16);
                    bus.cycle_tick();
                    Ok(12)
                } else { Ok(8) }
            }

            // === STOP ===
            0x10 => {
                // Pan Docs, "Using the STOP Instruction": the second byte is skipped unless an
                // interrupt is pending.
                let pending = bus.interrupts.pending() != 0;
                if bus.try_speed_switch() {
                    self.regs.pc = self.regs.pc.wrapping_add(1);
                } else if bus.read_byte(0xFF00) & 0x0F != 0x0F {
                    // A selected button already held: no stop mode, DIV kept; HALT when nothing is pending.
                    if !pending {
                        self.regs.pc = self.regs.pc.wrapping_add(1);
                        self.halted = true;
                        bus.hdma_halt();
                    }
                } else {
                    if !pending { self.regs.pc = self.regs.pc.wrapping_add(1); }
                    bus.enter_stop();
                    self.stopped = true;
                }
                Ok(4)
            }

            // === LD r8, r8 (0x40-0x7F, excluding HALT at 0x76) ===
            0x40 => Ok(4), // LD B,B
            0x41 => { self.regs.b = self.regs.c; Ok(4) }
            0x42 => { self.regs.b = self.regs.d; Ok(4) }
            0x43 => { self.regs.b = self.regs.e; Ok(4) }
            0x44 => { self.regs.b = self.regs.h; Ok(4) }
            0x45 => { self.regs.b = self.regs.l; Ok(4) }
            0x46 => { self.regs.b = bus.cycle_read(self.regs.hl()); Ok(8) }
            0x47 => { self.regs.b = self.regs.a; Ok(4) }
            0x48 => { self.regs.c = self.regs.b; Ok(4) }
            0x49 => Ok(4), // LD C,C
            0x4A => { self.regs.c = self.regs.d; Ok(4) }
            0x4B => { self.regs.c = self.regs.e; Ok(4) }
            0x4C => { self.regs.c = self.regs.h; Ok(4) }
            0x4D => { self.regs.c = self.regs.l; Ok(4) }
            0x4E => { self.regs.c = bus.cycle_read(self.regs.hl()); Ok(8) }
            0x4F => { self.regs.c = self.regs.a; Ok(4) }
            0x50 => { self.regs.d = self.regs.b; Ok(4) }
            0x51 => { self.regs.d = self.regs.c; Ok(4) }
            0x52 => Ok(4), // LD D,D
            0x53 => { self.regs.d = self.regs.e; Ok(4) }
            0x54 => { self.regs.d = self.regs.h; Ok(4) }
            0x55 => { self.regs.d = self.regs.l; Ok(4) }
            0x56 => { self.regs.d = bus.cycle_read(self.regs.hl()); Ok(8) }
            0x57 => { self.regs.d = self.regs.a; Ok(4) }
            0x58 => { self.regs.e = self.regs.b; Ok(4) }
            0x59 => { self.regs.e = self.regs.c; Ok(4) }
            0x5A => { self.regs.e = self.regs.d; Ok(4) }
            0x5B => Ok(4), // LD E,E
            0x5C => { self.regs.e = self.regs.h; Ok(4) }
            0x5D => { self.regs.e = self.regs.l; Ok(4) }
            0x5E => { self.regs.e = bus.cycle_read(self.regs.hl()); Ok(8) }
            0x5F => { self.regs.e = self.regs.a; Ok(4) }
            0x60 => { self.regs.h = self.regs.b; Ok(4) }
            0x61 => { self.regs.h = self.regs.c; Ok(4) }
            0x62 => { self.regs.h = self.regs.d; Ok(4) }
            0x63 => { self.regs.h = self.regs.e; Ok(4) }
            0x64 => Ok(4), // LD H,H
            0x65 => { self.regs.h = self.regs.l; Ok(4) }
            0x66 => { self.regs.h = bus.cycle_read(self.regs.hl()); Ok(8) }
            0x67 => { self.regs.h = self.regs.a; Ok(4) }
            0x68 => { self.regs.l = self.regs.b; Ok(4) }
            0x69 => { self.regs.l = self.regs.c; Ok(4) }
            0x6A => { self.regs.l = self.regs.d; Ok(4) }
            0x6B => { self.regs.l = self.regs.e; Ok(4) }
            0x6C => { self.regs.l = self.regs.h; Ok(4) }
            0x6D => Ok(4), // LD L,L
            0x6E => { self.regs.l = bus.cycle_read(self.regs.hl()); Ok(8) }
            0x6F => { self.regs.l = self.regs.a; Ok(4) }
            0x70 => { bus.cycle_write(self.regs.hl(), self.regs.b); Ok(8) }
            0x71 => { bus.cycle_write(self.regs.hl(), self.regs.c); Ok(8) }
            0x72 => { bus.cycle_write(self.regs.hl(), self.regs.d); Ok(8) }
            0x73 => { bus.cycle_write(self.regs.hl(), self.regs.e); Ok(8) }
            0x74 => { bus.cycle_write(self.regs.hl(), self.regs.h); Ok(8) }
            0x75 => { bus.cycle_write(self.regs.hl(), self.regs.l); Ok(8) }

            // === HALT ===
            0x76 => {
                // An interrupt raised in this opcode fetch is pending already: the bug (Age
                // halt-m0-interrupt, SCX 0-2).
                if ime || bus.interrupts.pending() == 0 {
                    self.halted = true;
                    bus.hdma_halt();
                } else {
                    // HALT bug: IME=0 but interrupt pending — don't halt,
                    // and the next instruction byte will be read twice
                    self.halt_bug = true;
                }
                Ok(4)
            }

            0x77 => { bus.cycle_write(self.regs.hl(), self.regs.a); Ok(8) }
            0x78 => { self.regs.a = self.regs.b; Ok(4) }
            0x79 => { self.regs.a = self.regs.c; Ok(4) }
            0x7A => { self.regs.a = self.regs.d; Ok(4) }
            0x7B => { self.regs.a = self.regs.e; Ok(4) }
            0x7C => { self.regs.a = self.regs.h; Ok(4) }
            0x7D => { self.regs.a = self.regs.l; Ok(4) }
            0x7E => { self.regs.a = bus.cycle_read(self.regs.hl()); Ok(8) }
            0x7F => Ok(4), // LD A,A

            // === ALU: ADD A, r8 ===
            0x80 => { self.add_a(self.regs.b, false); Ok(4) }
            0x81 => { self.add_a(self.regs.c, false); Ok(4) }
            0x82 => { self.add_a(self.regs.d, false); Ok(4) }
            0x83 => { self.add_a(self.regs.e, false); Ok(4) }
            0x84 => { self.add_a(self.regs.h, false); Ok(4) }
            0x85 => { self.add_a(self.regs.l, false); Ok(4) }
            0x86 => { let v = bus.cycle_read(self.regs.hl()); self.add_a(v, false); Ok(8) }
            0x87 => { self.add_a(self.regs.a, false); Ok(4) }

            // === ALU: ADC A, r8 ===
            0x88 => { self.add_a(self.regs.b, true); Ok(4) }
            0x89 => { self.add_a(self.regs.c, true); Ok(4) }
            0x8A => { self.add_a(self.regs.d, true); Ok(4) }
            0x8B => { self.add_a(self.regs.e, true); Ok(4) }
            0x8C => { self.add_a(self.regs.h, true); Ok(4) }
            0x8D => { self.add_a(self.regs.l, true); Ok(4) }
            0x8E => { let v = bus.cycle_read(self.regs.hl()); self.add_a(v, true); Ok(8) }
            0x8F => { self.add_a(self.regs.a, true); Ok(4) }

            // === ALU: SUB A, r8 ===
            0x90 => { self.sub_a(self.regs.b, false); Ok(4) }
            0x91 => { self.sub_a(self.regs.c, false); Ok(4) }
            0x92 => { self.sub_a(self.regs.d, false); Ok(4) }
            0x93 => { self.sub_a(self.regs.e, false); Ok(4) }
            0x94 => { self.sub_a(self.regs.h, false); Ok(4) }
            0x95 => { self.sub_a(self.regs.l, false); Ok(4) }
            0x96 => { let v = bus.cycle_read(self.regs.hl()); self.sub_a(v, false); Ok(8) }
            0x97 => { self.sub_a(self.regs.a, false); Ok(4) }

            // === ALU: SBC A, r8 ===
            0x98 => { self.sub_a(self.regs.b, true); Ok(4) }
            0x99 => { self.sub_a(self.regs.c, true); Ok(4) }
            0x9A => { self.sub_a(self.regs.d, true); Ok(4) }
            0x9B => { self.sub_a(self.regs.e, true); Ok(4) }
            0x9C => { self.sub_a(self.regs.h, true); Ok(4) }
            0x9D => { self.sub_a(self.regs.l, true); Ok(4) }
            0x9E => { let v = bus.cycle_read(self.regs.hl()); self.sub_a(v, true); Ok(8) }
            0x9F => { self.sub_a(self.regs.a, true); Ok(4) }

            // === ALU: AND A, r8 ===
            0xA0 => { self.and_a(self.regs.b); Ok(4) }
            0xA1 => { self.and_a(self.regs.c); Ok(4) }
            0xA2 => { self.and_a(self.regs.d); Ok(4) }
            0xA3 => { self.and_a(self.regs.e); Ok(4) }
            0xA4 => { self.and_a(self.regs.h); Ok(4) }
            0xA5 => { self.and_a(self.regs.l); Ok(4) }
            0xA6 => { let v = bus.cycle_read(self.regs.hl()); self.and_a(v); Ok(8) }
            0xA7 => { self.and_a(self.regs.a); Ok(4) }

            // === ALU: XOR A, r8 ===
            0xA8 => { self.xor_a(self.regs.b); Ok(4) }
            0xA9 => { self.xor_a(self.regs.c); Ok(4) }
            0xAA => { self.xor_a(self.regs.d); Ok(4) }
            0xAB => { self.xor_a(self.regs.e); Ok(4) }
            0xAC => { self.xor_a(self.regs.h); Ok(4) }
            0xAD => { self.xor_a(self.regs.l); Ok(4) }
            0xAE => { let v = bus.cycle_read(self.regs.hl()); self.xor_a(v); Ok(8) }
            0xAF => { self.xor_a(self.regs.a); Ok(4) }

            // === ALU: OR A, r8 ===
            0xB0 => { self.or_a(self.regs.b); Ok(4) }
            0xB1 => { self.or_a(self.regs.c); Ok(4) }
            0xB2 => { self.or_a(self.regs.d); Ok(4) }
            0xB3 => { self.or_a(self.regs.e); Ok(4) }
            0xB4 => { self.or_a(self.regs.h); Ok(4) }
            0xB5 => { self.or_a(self.regs.l); Ok(4) }
            0xB6 => { let v = bus.cycle_read(self.regs.hl()); self.or_a(v); Ok(8) }
            0xB7 => { self.or_a(self.regs.a); Ok(4) }

            // === ALU: CP A, r8 ===
            0xB8 => { self.cp_a(self.regs.b); Ok(4) }
            0xB9 => { self.cp_a(self.regs.c); Ok(4) }
            0xBA => { self.cp_a(self.regs.d); Ok(4) }
            0xBB => { self.cp_a(self.regs.e); Ok(4) }
            0xBC => { self.cp_a(self.regs.h); Ok(4) }
            0xBD => { self.cp_a(self.regs.l); Ok(4) }
            0xBE => { let v = bus.cycle_read(self.regs.hl()); self.cp_a(v); Ok(8) }
            0xBF => { self.cp_a(self.regs.a); Ok(4) }

            // === ALU: immediate ===
            0xC6 => { let v = self.fetch_byte(bus); self.add_a(v, false); Ok(8) }
            0xCE => { let v = self.fetch_byte(bus); self.add_a(v, true); Ok(8) }
            0xD6 => { let v = self.fetch_byte(bus); self.sub_a(v, false); Ok(8) }
            0xDE => { let v = self.fetch_byte(bus); self.sub_a(v, true); Ok(8) }
            0xE6 => { let v = self.fetch_byte(bus); self.and_a(v); Ok(8) }
            0xEE => { let v = self.fetch_byte(bus); self.xor_a(v); Ok(8) }
            0xF6 => { let v = self.fetch_byte(bus); self.or_a(v); Ok(8) }
            0xFE => { let v = self.fetch_byte(bus); self.cp_a(v); Ok(8) }

            // === POP/PUSH ===
            0xC1 => { let v = self.pop_u16(bus); self.regs.set_bc(v); Ok(12) }
            0xD1 => { let v = self.pop_u16(bus); self.regs.set_de(v); Ok(12) }
            0xE1 => { let v = self.pop_u16(bus); self.regs.set_hl(v); Ok(12) }
            0xF1 => { let v = self.pop_u16(bus); self.regs.set_af(v); Ok(12) }
            0xC5 => { let v = self.regs.bc(); self.push_u16(bus, v); Ok(16) }
            0xD5 => { let v = self.regs.de(); self.push_u16(bus, v); Ok(16) }
            0xE5 => { let v = self.regs.hl(); self.push_u16(bus, v); Ok(16) }
            0xF5 => { let v = self.regs.af(); self.push_u16(bus, v); Ok(16) }

            // === JP a16 ===
            0xC3 => { self.regs.pc = self.fetch_u16(bus); bus.cycle_tick(); Ok(16) }
            // JP cc, a16
            0xC2 => { let addr = self.fetch_u16(bus); if !self.regs.zero() { self.regs.pc = addr; bus.cycle_tick(); Ok(16) } else { Ok(12) } }
            0xCA => { let addr = self.fetch_u16(bus); if self.regs.zero() { self.regs.pc = addr; bus.cycle_tick(); Ok(16) } else { Ok(12) } }
            0xD2 => { let addr = self.fetch_u16(bus); if !self.regs.carry() { self.regs.pc = addr; bus.cycle_tick(); Ok(16) } else { Ok(12) } }
            0xDA => { let addr = self.fetch_u16(bus); if self.regs.carry() { self.regs.pc = addr; bus.cycle_tick(); Ok(16) } else { Ok(12) } }

            // === JP HL ===
            0xE9 => { self.regs.pc = self.regs.hl(); Ok(4) }

            // === CALL a16 ===
            0xCD => { let addr = self.fetch_u16(bus); self.push_u16(bus, self.regs.pc); self.regs.pc = addr; Ok(24) }
            // CALL cc, a16
            0xC4 => { let addr = self.fetch_u16(bus); if !self.regs.zero() { self.push_u16(bus, self.regs.pc); self.regs.pc = addr; Ok(24) } else { Ok(12) } }
            0xCC => { let addr = self.fetch_u16(bus); if self.regs.zero() { self.push_u16(bus, self.regs.pc); self.regs.pc = addr; Ok(24) } else { Ok(12) } }
            0xD4 => { let addr = self.fetch_u16(bus); if !self.regs.carry() { self.push_u16(bus, self.regs.pc); self.regs.pc = addr; Ok(24) } else { Ok(12) } }
            0xDC => { let addr = self.fetch_u16(bus); if self.regs.carry() { self.push_u16(bus, self.regs.pc); self.regs.pc = addr; Ok(24) } else { Ok(12) } }

            // === RET ===
            0xC9 => { self.regs.pc = self.pop_u16(bus); bus.cycle_tick(); Ok(16) }
            // RET cc
            0xC0 => { bus.cycle_tick(); if !self.regs.zero() { self.regs.pc = self.pop_u16(bus); bus.cycle_tick(); Ok(20) } else { Ok(8) } }
            0xC8 => { bus.cycle_tick(); if self.regs.zero() { self.regs.pc = self.pop_u16(bus); bus.cycle_tick(); Ok(20) } else { Ok(8) } }
            0xD0 => { bus.cycle_tick(); if !self.regs.carry() { self.regs.pc = self.pop_u16(bus); bus.cycle_tick(); Ok(20) } else { Ok(8) } }
            0xD8 => { bus.cycle_tick(); if self.regs.carry() { self.regs.pc = self.pop_u16(bus); bus.cycle_tick(); Ok(20) } else { Ok(8) } }

            // === RETI ===
            0xD9 => { self.regs.pc = self.pop_u16(bus); bus.cycle_tick(); self.ime = true; Ok(16) }

            // === RST ===
            0xC7 => { self.push_u16(bus, self.regs.pc); self.regs.pc = 0x00; Ok(16) }
            0xCF => { self.push_u16(bus, self.regs.pc); self.regs.pc = 0x08; Ok(16) }
            0xD7 => { self.push_u16(bus, self.regs.pc); self.regs.pc = 0x10; Ok(16) }
            0xDF => { self.push_u16(bus, self.regs.pc); self.regs.pc = 0x18; Ok(16) }
            0xE7 => { self.push_u16(bus, self.regs.pc); self.regs.pc = 0x20; Ok(16) }
            0xEF => { self.push_u16(bus, self.regs.pc); self.regs.pc = 0x28; Ok(16) }
            0xF7 => { self.push_u16(bus, self.regs.pc); self.regs.pc = 0x30; Ok(16) }
            0xFF => { self.push_u16(bus, self.regs.pc); self.regs.pc = 0x38; Ok(16) }

            // === LDH ===
            0xE0 => { let offset = self.fetch_byte(bus); bus.cycle_write(0xFF00 + offset as u16, self.regs.a); Ok(12) }
            0xF0 => { let offset = self.fetch_byte(bus); self.regs.a = bus.cycle_read(0xFF00 + offset as u16); Ok(12) }
            0xE2 => { bus.cycle_write(0xFF00 + self.regs.c as u16, self.regs.a); Ok(8) }
            0xF2 => { self.regs.a = bus.cycle_read(0xFF00 + self.regs.c as u16); Ok(8) }

            // === LD (a16), A / LD A, (a16) ===
            0xEA => { let addr = self.fetch_u16(bus); bus.cycle_write(addr, self.regs.a); Ok(16) }
            0xFA => { let addr = self.fetch_u16(bus); self.regs.a = bus.cycle_read(addr); Ok(16) }

            // === ADD SP, e8 ===
            0xE8 => {
                let offset = self.fetch_byte(bus) as i8 as i16 as u16;
                let sp = self.regs.sp;
                self.regs.set_zero(false);
                self.regs.set_subtract(false);
                self.regs.set_half_carry((sp & 0x0F) + (offset & 0x0F) > 0x0F);
                self.regs.set_carry((sp & 0xFF) + (offset & 0xFF) > 0xFF);
                self.regs.sp = sp.wrapping_add(offset);
                bus.cycle_tick(); // internal
                bus.cycle_tick(); // internal
                Ok(16)
            }

            // === LD HL, SP+e8 ===
            0xF8 => {
                let offset = self.fetch_byte(bus) as i8 as i16 as u16;
                let sp = self.regs.sp;
                self.regs.set_zero(false);
                self.regs.set_subtract(false);
                self.regs.set_half_carry((sp & 0x0F) + (offset & 0x0F) > 0x0F);
                self.regs.set_carry((sp & 0xFF) + (offset & 0xFF) > 0xFF);
                self.regs.set_hl(sp.wrapping_add(offset));
                bus.cycle_tick(); // internal
                Ok(12)
            }

            // === LD SP, HL ===
            0xF9 => { self.regs.sp = self.regs.hl(); bus.cycle_tick(); Ok(8) }

            // === DI / EI ===
            0xF3 => { self.ime = false; Ok(4) }
            0xFB => { self.ime_pending = !self.ime; Ok(4) } // no-op while IME is already on

            // === CB prefix ===
            0xCB => self.execute_cb(bus),

            // === Invalid opcodes ===
            // They lock the CPU (Pan Docs, CPU instruction set): it never fetches again, and
            // nothing but a reset wakes it; the PPU, APU and timers run on. It sleeps through the
            // `halted` path, `handle_interrupts` keeps it there.
            0xD3 | 0xDB | 0xDD | 0xE3 | 0xE4 | 0xEB | 0xEC | 0xED | 0xF4 | 0xFC | 0xFD => {
                self.locked = true;
                self.locked_pc = self.regs.pc.wrapping_sub(1);
                self.halted = true;
                Ok(4)
            }
        }
    }

    fn execute_cb(&mut self, bus: &mut MemoryBus) -> Result<u32, CpuError> {
        let opcode = self.fetch_byte(bus);
        let reg_index = opcode & 0x07;
        let operation = opcode >> 3;

        let value = self.read_r8(bus, reg_index);
        let is_hl = reg_index == 6;
        let base_cycles: u32 = if is_hl { 16 } else { 8 };

        let result = match operation {
            0 => self.cb_rlc(value),     // RLC
            1 => self.cb_rrc(value),     // RRC
            2 => self.cb_rl(value),      // RL
            3 => self.cb_rr(value),      // RR
            4 => self.cb_sla(value),     // SLA
            5 => self.cb_sra(value),     // SRA
            6 => self.cb_swap(value),    // SWAP
            7 => self.cb_srl(value),     // SRL
            8..=15 => {
                // BIT b, r8
                let bit = (operation - 8) as u8;
                self.regs.set_zero(value & (1 << bit) == 0);
                self.regs.set_subtract(false);
                self.regs.set_half_carry(true);
                return Ok(if is_hl { 12 } else { 8 });
            }
            16..=23 => {
                // RES b, r8
                let bit = (operation - 16) as u8;
                value & !(1 << bit)
            }
            24..=31 => {
                // SET b, r8
                let bit = (operation - 24) as u8;
                value | (1 << bit)
            }
            _ => unreachable!(),
        };

        self.write_r8(bus, reg_index, result);
        Ok(base_cycles)
    }

    // === Helper: read/write r8 by index ===
    fn read_r8(&self, bus: &mut MemoryBus, index: u8) -> u8 {
        match index {
            0 => self.regs.b,
            1 => self.regs.c,
            2 => self.regs.d,
            3 => self.regs.e,
            4 => self.regs.h,
            5 => self.regs.l,
            6 => bus.cycle_read(self.regs.hl()),
            7 => self.regs.a,
            _ => unreachable!(),
        }
    }

    fn write_r8(&mut self, bus: &mut MemoryBus, index: u8, value: u8) {
        match index {
            0 => self.regs.b = value,
            1 => self.regs.c = value,
            2 => self.regs.d = value,
            3 => self.regs.e = value,
            4 => self.regs.h = value,
            5 => self.regs.l = value,
            6 => bus.cycle_write(self.regs.hl(), value),
            7 => self.regs.a = value,
            _ => unreachable!(),
        }
    }

    // === Fetch helpers ===
    fn fetch_byte(&mut self, bus: &mut MemoryBus) -> u8 {
        let value = bus.cycle_read(self.regs.pc);
        if self.halt_bug {
            self.halt_bug = false;
        } else {
            self.regs.pc = self.regs.pc.wrapping_add(1);
        }
        value
    }

    fn fetch_u16(&mut self, bus: &mut MemoryBus) -> u16 {
        let lo = self.fetch_byte(bus) as u16;
        let hi = self.fetch_byte(bus) as u16;
        (hi << 8) | lo
    }

    // === Stack helpers ===
    /// Internal SP-decrement cycle plus two writes (3 M-cycles).
    fn push_u16(&mut self, bus: &mut MemoryBus, value: u16) {
        bus.cycle_idu(self.regs.sp);
        self.regs.sp = self.regs.sp.wrapping_sub(1);
        bus.cycle_write(self.regs.sp, (value >> 8) as u8);
        self.regs.sp = self.regs.sp.wrapping_sub(1);
        bus.cycle_write(self.regs.sp, value as u8);
    }

    fn pop_u16(&mut self, bus: &mut MemoryBus) -> u16 {
        let lo = bus.cycle_read_inc(self.regs.sp) as u16;
        self.regs.sp = self.regs.sp.wrapping_add(1);
        let hi = bus.cycle_read_inc(self.regs.sp) as u16;
        self.regs.sp = self.regs.sp.wrapping_add(1);
        (hi << 8) | lo
    }

    // === ALU helpers ===
    fn add_a(&mut self, value: u8, with_carry: bool) {
        let carry = if with_carry && self.regs.carry() { 1u8 } else { 0 };
        let a = self.regs.a;
        let result = a as u16 + value as u16 + carry as u16;
        self.regs.a = result as u8;
        self.regs.set_zero(self.regs.a == 0);
        self.regs.set_subtract(false);
        self.regs.set_half_carry((a & 0x0F) + (value & 0x0F) + carry > 0x0F);
        self.regs.set_carry(result > 0xFF);
    }

    fn sub_a(&mut self, value: u8, with_carry: bool) {
        let carry = if with_carry && self.regs.carry() { 1u8 } else { 0 };
        let a = self.regs.a;
        let result = a as i16 - value as i16 - carry as i16;
        self.regs.a = result as u8;
        self.regs.set_zero(self.regs.a == 0);
        self.regs.set_subtract(true);
        self.regs.set_half_carry((a & 0x0F) < (value & 0x0F) + carry);
        self.regs.set_carry(result < 0);
    }

    fn and_a(&mut self, value: u8) {
        self.regs.a &= value;
        self.regs.set_zero(self.regs.a == 0);
        self.regs.set_subtract(false);
        self.regs.set_half_carry(true);
        self.regs.set_carry(false);
    }

    fn xor_a(&mut self, value: u8) {
        self.regs.a ^= value;
        self.regs.set_zero(self.regs.a == 0);
        self.regs.set_subtract(false);
        self.regs.set_half_carry(false);
        self.regs.set_carry(false);
    }

    fn or_a(&mut self, value: u8) {
        self.regs.a |= value;
        self.regs.set_zero(self.regs.a == 0);
        self.regs.set_subtract(false);
        self.regs.set_half_carry(false);
        self.regs.set_carry(false);
    }

    fn cp_a(&mut self, value: u8) {
        let a = self.regs.a;
        self.sub_a(value, false);
        self.regs.a = a; // CP doesn't store the result
    }

    fn inc(&mut self, value: u8) -> u8 {
        let result = value.wrapping_add(1);
        self.regs.set_zero(result == 0);
        self.regs.set_subtract(false);
        self.regs.set_half_carry((value & 0x0F) + 1 > 0x0F);
        result
    }

    fn dec(&mut self, value: u8) -> u8 {
        let result = value.wrapping_sub(1);
        self.regs.set_zero(result == 0);
        self.regs.set_subtract(true);
        self.regs.set_half_carry((value & 0x0F) == 0);
        result
    }

    fn add_hl(&mut self, value: u16) {
        let hl = self.regs.hl();
        let result = hl as u32 + value as u32;
        self.regs.set_subtract(false);
        self.regs.set_half_carry((hl & 0x0FFF) + (value & 0x0FFF) > 0x0FFF);
        self.regs.set_carry(result > 0xFFFF);
        self.regs.set_hl(result as u16);
    }

    // === Rotate A (non-CB) ===
    fn rlca(&mut self) {
        let carry = self.regs.a >> 7;
        self.regs.a = (self.regs.a << 1) | carry;
        self.regs.set_zero(false);
        self.regs.set_subtract(false);
        self.regs.set_half_carry(false);
        self.regs.set_carry(carry != 0);
    }

    fn rrca(&mut self) {
        let carry = self.regs.a & 1;
        self.regs.a = (self.regs.a >> 1) | (carry << 7);
        self.regs.set_zero(false);
        self.regs.set_subtract(false);
        self.regs.set_half_carry(false);
        self.regs.set_carry(carry != 0);
    }

    fn rla(&mut self) {
        let old_carry = if self.regs.carry() { 1u8 } else { 0 };
        let new_carry = self.regs.a >> 7;
        self.regs.a = (self.regs.a << 1) | old_carry;
        self.regs.set_zero(false);
        self.regs.set_subtract(false);
        self.regs.set_half_carry(false);
        self.regs.set_carry(new_carry != 0);
    }

    fn rra(&mut self) {
        let old_carry = if self.regs.carry() { 1u8 } else { 0 };
        let new_carry = self.regs.a & 1;
        self.regs.a = (self.regs.a >> 1) | (old_carry << 7);
        self.regs.set_zero(false);
        self.regs.set_subtract(false);
        self.regs.set_half_carry(false);
        self.regs.set_carry(new_carry != 0);
    }

    fn daa(&mut self) {
        let mut a = self.regs.a as i16;

        if !self.regs.subtract() {
            if self.regs.half_carry() || (a & 0x0F) > 9 {
                a += 0x06;
            }
            if self.regs.carry() || a > 0x9F {
                a += 0x60;
            }
        } else {
            if self.regs.half_carry() {
                a = (a.wrapping_sub(6)) & 0xFF;
            }
            if self.regs.carry() {
                a -= 0x60;
            }
        }

        self.regs.set_half_carry(false);
        if a & 0x100 != 0 {
            self.regs.set_carry(true);
        }
        self.regs.a = (a & 0xFF) as u8;
        self.regs.set_zero(self.regs.a == 0);
    }

    // === CB rotate/shift helpers ===
    fn cb_rlc(&mut self, value: u8) -> u8 {
        let carry = value >> 7;
        let result = (value << 1) | carry;
        self.regs.set_zero(result == 0);
        self.regs.set_subtract(false);
        self.regs.set_half_carry(false);
        self.regs.set_carry(carry != 0);
        result
    }

    fn cb_rrc(&mut self, value: u8) -> u8 {
        let carry = value & 1;
        let result = (value >> 1) | (carry << 7);
        self.regs.set_zero(result == 0);
        self.regs.set_subtract(false);
        self.regs.set_half_carry(false);
        self.regs.set_carry(carry != 0);
        result
    }

    fn cb_rl(&mut self, value: u8) -> u8 {
        let old_carry = if self.regs.carry() { 1u8 } else { 0 };
        let new_carry = value >> 7;
        let result = (value << 1) | old_carry;
        self.regs.set_zero(result == 0);
        self.regs.set_subtract(false);
        self.regs.set_half_carry(false);
        self.regs.set_carry(new_carry != 0);
        result
    }

    fn cb_rr(&mut self, value: u8) -> u8 {
        let old_carry = if self.regs.carry() { 1u8 } else { 0 };
        let new_carry = value & 1;
        let result = (value >> 1) | (old_carry << 7);
        self.regs.set_zero(result == 0);
        self.regs.set_subtract(false);
        self.regs.set_half_carry(false);
        self.regs.set_carry(new_carry != 0);
        result
    }

    fn cb_sla(&mut self, value: u8) -> u8 {
        let carry = value >> 7;
        let result = value << 1;
        self.regs.set_zero(result == 0);
        self.regs.set_subtract(false);
        self.regs.set_half_carry(false);
        self.regs.set_carry(carry != 0);
        result
    }

    fn cb_sra(&mut self, value: u8) -> u8 {
        let carry = value & 1;
        let result = (value >> 1) | (value & 0x80);
        self.regs.set_zero(result == 0);
        self.regs.set_subtract(false);
        self.regs.set_half_carry(false);
        self.regs.set_carry(carry != 0);
        result
    }

    fn cb_swap(&mut self, value: u8) -> u8 {
        let result = (value >> 4) | (value << 4);
        self.regs.set_zero(result == 0);
        self.regs.set_subtract(false);
        self.regs.set_half_carry(false);
        self.regs.set_carry(false);
        result
    }

    fn cb_srl(&mut self, value: u8) -> u8 {
        let carry = value & 1;
        let result = value >> 1;
        self.regs.set_zero(result == 0);
        self.regs.set_subtract(false);
        self.regs.set_half_carry(false);
        self.regs.set_carry(carry != 0);
        result
    }
}
