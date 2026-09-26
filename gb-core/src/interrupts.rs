pub const VBLANK_BIT: u8 = 0x01;
pub const STAT_BIT: u8 = 0x02;
pub const TIMER_BIT: u8 = 0x04;
pub const SERIAL_BIT: u8 = 0x08;
pub const JOYPAD_BIT: u8 = 0x10;

pub struct InterruptController {
    pub interrupt_enable: u8, // 0xFFFF (IE)
    pub interrupt_flag: u8,   // 0xFF0F (IF)
}

impl InterruptController {
    pub fn new() -> Self {
        Self {
            interrupt_enable: 0,
            interrupt_flag: 0,
        }
    }

    pub fn pending(&self) -> u8 {
        self.interrupt_enable & self.interrupt_flag & 0x1F
    }

    pub fn request(&mut self, bit: u8) {
        self.interrupt_flag |= bit;
    }

    /// Returns the vector address of the highest-priority pending interrupt
    /// and clears its IF bit. Returns None if no interrupt is pending.
    pub fn acknowledge(&mut self) -> Option<u16> {
        let pending = self.pending();
        if pending == 0 {
            return None;
        }

        // Lowest set bit = highest priority
        let bit = pending & pending.wrapping_neg();
        self.interrupt_flag &= !bit;

        let vector = match bit {
            VBLANK_BIT => 0x0040,
            STAT_BIT => 0x0048,
            TIMER_BIT => 0x0050,
            SERIAL_BIT => 0x0058,
            JOYPAD_BIT => 0x0060,
            _ => return None,
        };

        Some(vector)
    }
}
