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

    /// The highest-priority interrupt pending in `ie` & IF: its IF bit (lowest set bit), and
    /// its vector, $40 + 8 x the bit's position. None when nothing is pending.
    pub fn highest(&self, ie: u8) -> Option<(u8, u16)> {
        let pending = ie & self.interrupt_flag & 0x1F;
        let bit = pending & pending.wrapping_neg();
        (bit != 0).then(|| (bit, 0x40 + 8 * bit.trailing_zeros() as u16))
    }
}
