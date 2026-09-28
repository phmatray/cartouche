pub struct Timer {
    pub div_counter: u16,
    pub tima: u8,
    pub tma: u8,
    pub tac: u8,
    /// TIMA overflowed in the last M-cycle: it reads $00 until TMA is loaded (and IF.2 set) at
    /// the start of the next one. A TIMA write meanwhile cancels both.
    pub reload_pending: bool,
    /// TMA was loaded into TIMA this M-cycle: a TIMA write is ignored, a TMA write lands in TIMA.
    reloading: bool,
}

impl Timer {
    pub fn new() -> Self {
        Self {
            div_counter: 0,
            tima: 0,
            tma: 0,
            tac: 0,
            reload_pending: false,
            reloading: false,
        }
    }

    fn tac_bit_mask(&self) -> u16 {
        self.bit_mask_for_tac(self.tac)
    }

    /// TIMA += 1; an overflow leaves $00 and arms the reload for the next M-cycle.
    fn increment(&mut self) {
        let (new_tima, overflow) = self.tima.overflowing_add(1);
        self.tima = new_tima;
        self.reload_pending |= overflow;
    }

    /// Advance timer by the given number of T-cycles (one M-cycle per call from the bus).
    /// Returns true when TIMA overflowed: the hardware raises IF.2 with the reload one M-cycle
    /// later, but the CPU samples IF before its opcode fetch here, so the bus requests it now
    /// (and withdraws it if a TIMA write cancels the reload).
    pub fn step(&mut self, cycles: u32) -> bool {
        self.reloading = self.reload_pending;
        if self.reload_pending {
            self.tima = self.tma;
            self.reload_pending = false;
        }

        for _ in 0..cycles {
            let old_div = self.div_counter;
            self.div_counter = self.div_counter.wrapping_add(1);

            if self.tac & 0x04 != 0 {
                let bit_mask = self.tac_bit_mask();

                // Falling edge: selected bit was 1, now is 0
                if (old_div & bit_mask != 0) && (self.div_counter & bit_mask == 0) {
                    self.increment();
                }
            }
        }

        self.reload_pending
    }

    pub fn read(&self, addr: u16) -> u8 {
        match addr {
            0xFF04 => (self.div_counter >> 8) as u8,
            0xFF05 => self.tima,
            0xFF06 => self.tma,
            0xFF07 => self.tac | 0xF8,
            _ => 0xFF,
        }
    }

    /// Resetting DIV or changing TAC can drop the selected DIV bit, a falling edge that ticks
    /// TIMA like any other (an overflow then reloads on the next M-cycle, as usual).
    pub fn write(&mut self, addr: u16, value: u8) {
        match addr {
            0xFF04 => {
                let edge = self.tac & 0x04 != 0 && self.div_counter & self.tac_bit_mask() != 0;
                self.div_counter = 0;
                if edge { self.increment(); }
            }
            0xFF05 if self.reloading => {}
            0xFF05 => { self.tima = value; self.reload_pending = false; }
            0xFF06 => {
                self.tma = value;
                if self.reloading { self.tima = value; }
            }
            0xFF07 => {
                let old_tac = self.tac;
                self.tac = value & 0x07;
                let old_bit = old_tac & 0x04 != 0 && self.div_counter & self.bit_mask_for_tac(old_tac) != 0;
                let new_bit = self.tac & 0x04 != 0 && self.div_counter & self.tac_bit_mask() != 0;
                if old_bit && !new_bit { self.increment(); }
            }
            _ => {}
        }
    }

    fn bit_mask_for_tac(&self, tac: u8) -> u16 {
        match tac & 0x03 {
            0 => 1 << 9,  // every 1024 T-cycles
            1 => 1 << 3,  // every 16 T-cycles
            2 => 1 << 5,  // every 64 T-cycles
            _ => 1 << 7,  // every 256 T-cycles
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn an_overflow_from_a_div_or_tac_write_arms_the_reload() {
        // TAC 1 (16 cycles): DIV bit 3 set, TIMA at $FF.
        let armed = || Timer { div_counter: 0x0008, tima: 0xFF, tma: 0x42, tac: 0x05, ..Timer::new() };
        let mut t = armed();
        t.write(0xFF04, 0);
        assert!(t.reload_pending, "DIV reset: falling edge, overflow");
        t.step(4);
        assert_eq!(t.tima, 0x42, "reloaded on the next M-cycle");
        let mut t = armed();
        t.write(0xFF07, 0x00);
        assert!(t.reload_pending, "timer stopped: falling edge, overflow");
        let mut t = armed();
        t.write(0xFF07, 0x05);
        assert!(!t.reload_pending, "same TAC: no edge");
        assert_eq!(t.tima, 0xFF);
    }

    #[test]
    fn overflow_reloads_one_m_cycle_later_and_a_tima_write_cancels_it() {
        // TAC 5 (16 cycles), DIV one M-cycle before the falling edge of bit 3.
        let armed = || Timer { div_counter: 0x000C, tima: 0xFF, tma: 0x42, tac: 0x05, ..Timer::new() };
        let mut t = armed();
        assert!(t.step(4), "overflow: the interrupt is requested (one M-cycle ahead, see step)");
        assert_eq!(t.read(0xFF05), 0x00, "TIMA reads $00 for one M-cycle");
        assert!(!t.step(4));
        assert_eq!(t.read(0xFF05), 0x42, "then TMA");

        let mut t = armed();
        t.step(4);
        t.write(0xFF05, 0x10);
        assert!(!t.reload_pending, "a TIMA write in the overflow cycle cancels the reload");
        t.step(4);
        assert_eq!(t.read(0xFF05), 0x10);

        let mut t = armed();
        t.step(4);
        t.step(4);
        t.write(0xFF05, 0x10);
        assert_eq!(t.read(0xFF05), 0x42, "a TIMA write in the reload cycle is ignored");
        t.write(0xFF06, 0x77);
        assert_eq!(t.read(0xFF05), 0x77, "a TMA write in the reload cycle lands in TIMA");
    }
}
