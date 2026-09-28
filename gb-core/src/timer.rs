pub struct Timer {
    pub div_counter: u16,
    pub tima: u8,
    pub tma: u8,
    pub tac: u8,
}

impl Timer {
    pub fn new() -> Self {
        Self {
            div_counter: 0,
            tima: 0,
            tma: 0,
            tac: 0,
        }
    }

    fn tac_bit_mask(&self) -> u16 {
        self.bit_mask_for_tac(self.tac)
    }

    /// TIMA += 1, reloaded from TMA on overflow. Returns true on overflow (timer interrupt).
    fn increment(&mut self) -> bool {
        let (new_tima, overflow) = self.tima.overflowing_add(1);
        self.tima = if overflow { self.tma } else { new_tima };
        overflow
    }

    /// Advance timer by the given number of T-cycles.
    /// Returns true if a timer interrupt should be requested.
    pub fn step(&mut self, cycles: u32) -> bool {
        let mut interrupt = false;

        for _ in 0..cycles {
            let old_div = self.div_counter;
            self.div_counter = self.div_counter.wrapping_add(1);

            if self.tac & 0x04 != 0 {
                let bit_mask = self.tac_bit_mask();

                // Falling edge: selected bit was 1, now is 0
                if (old_div & bit_mask != 0) && (self.div_counter & bit_mask == 0) {
                    interrupt |= self.increment();
                }
            }
        }

        interrupt
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

    /// Returns true if the write made TIMA overflow (timer interrupt): resetting DIV or changing
    /// TAC can drop the selected DIV bit, a falling edge that ticks TIMA like any other.
    pub fn write(&mut self, addr: u16, value: u8) -> bool {
        match addr {
            0xFF04 => {
                let edge = self.tac & 0x04 != 0 && self.div_counter & self.tac_bit_mask() != 0;
                self.div_counter = 0;
                edge && self.increment()
            }
            0xFF05 => { self.tima = value; false }
            0xFF06 => { self.tma = value; false }
            0xFF07 => {
                let old_tac = self.tac;
                self.tac = value & 0x07;
                let old_bit = old_tac & 0x04 != 0 && self.div_counter & self.bit_mask_for_tac(old_tac) != 0;
                let new_bit = self.tac & 0x04 != 0 && self.div_counter & self.tac_bit_mask() != 0;
                old_bit && !new_bit && self.increment()
            }
            _ => false,
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
    fn an_overflow_from_a_div_or_tac_write_requests_the_interrupt() {
        // TAC 1 (16 cycles): DIV bit 3 set, TIMA at $FF.
        let armed = || Timer { div_counter: 0x0008, tima: 0xFF, tma: 0x42, tac: 0x05 };
        let mut t = armed();
        assert!(t.write(0xFF04, 0), "DIV reset: falling edge, overflow");
        assert_eq!(t.tima, 0x42);
        let mut t = armed();
        assert!(t.write(0xFF07, 0x00), "timer stopped: falling edge, overflow");
        assert_eq!(t.tima, 0x42);
        let mut t = armed();
        assert!(!t.write(0xFF07, 0x05), "same TAC: no edge");
        assert_eq!(t.tima, 0xFF);
    }
}
