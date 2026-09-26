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
        match self.tac & 0x03 {
            0 => 1 << 9,  // every 1024 T-cycles
            1 => 1 << 3,  // every 16 T-cycles
            2 => 1 << 5,  // every 64 T-cycles
            3 => 1 << 7,  // every 256 T-cycles
            _ => unreachable!(),
        }
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
                    let (new_tima, overflow) = self.tima.overflowing_add(1);
                    if overflow {
                        self.tima = self.tma;
                        interrupt = true;
                    } else {
                        self.tima = new_tima;
                    }
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

    pub fn write(&mut self, addr: u16, value: u8) {
        match addr {
            0xFF04 => {
                // Writing any value to DIV resets it to 0.
                // If the timer is enabled, the falling edge caused by
                // clearing div_counter can tick TIMA.
                if self.tac & 0x04 != 0 {
                    let bit_mask = self.tac_bit_mask();
                    if self.div_counter & bit_mask != 0 {
                        let (new_tima, overflow) = self.tima.overflowing_add(1);
                        if overflow {
                            self.tima = self.tma;
                            // Note: should also trigger interrupt, but
                            // we can't from here; caller would need to check.
                        } else {
                            self.tima = new_tima;
                        }
                    }
                }
                self.div_counter = 0;
            }
            0xFF05 => self.tima = value,
            0xFF06 => self.tma = value,
            0xFF07 => {
                let old_tac = self.tac;
                self.tac = value & 0x07;
                // Changing TAC can cause a falling edge if the old selected
                // bit was 1 and the new selected bit is 0 (or timer disabled).
                if old_tac & 0x04 != 0 {
                    let old_bit = self.div_counter & self.bit_mask_for_tac(old_tac);
                    let new_enabled = self.tac & 0x04 != 0;
                    let new_bit = if new_enabled {
                        self.div_counter & self.tac_bit_mask()
                    } else {
                        0
                    };
                    if old_bit != 0 && new_bit == 0 {
                        let (new_tima, overflow) = self.tima.overflowing_add(1);
                        if overflow {
                            self.tima = self.tma;
                        } else {
                            self.tima = new_tima;
                        }
                    }
                }
            }
            _ => {}
        }
    }

    fn bit_mask_for_tac(&self, tac: u8) -> u16 {
        match tac & 0x03 {
            0 => 1 << 9,
            1 => 1 << 3,
            2 => 1 << 5,
            3 => 1 << 7,
            _ => unreachable!(),
        }
    }
}
