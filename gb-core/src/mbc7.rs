//! MBC7 (cartridge type 0x22): a 2-axis accelerometer and a 93LC56 serial EEPROM behind the
//! A000-AFFF register window (Pan Docs "MBC7"). The EEPROM's 256 bytes live in `Cartridge::ram`.

/// Accelerometer reading at rest, and the change per g of tilt (Pan Docs).
const CENTER: f32 = 0x81D0 as f32;
const PER_G: f32 = 0x70 as f32;

pub struct Mbc7 {
    /// Host tilt in g: x > 0 = right side down, y > 0 = top side down. Held until the next `set_tilt`.
    tilt: (f32, f32),
    /// Latched X/Y as the game reads them; 0x8000 once erased (and at power-on).
    latched: (u16, u16),
    /// `0x55` was written to Ax0x: the next `0xAA` to Ax1x latches.
    erased: bool,
}

impl Mbc7 {
    pub fn new() -> Self {
        Mbc7 { tilt: (0.0, 0.0), latched: (0x8000, 0x8000), erased: false }
    }

    pub fn set_tilt(&mut self, x: f32, y: f32) {
        let clamp = |v: f32| if v.is_finite() { v.clamp(-2.0, 2.0) } else { 0.0 };
        self.tilt = (clamp(x), clamp(y));
    }

    /// Read of A000-AFFF (registers picked by address bits 4-7).
    pub fn read_reg(&self, offset: u16) -> u8 {
        match (offset >> 4) & 0x0F {
            0x2 => self.latched.0 as u8,
            0x3 => (self.latched.0 >> 8) as u8,
            0x4 => self.latched.1 as u8,
            0x5 => (self.latched.1 >> 8) as u8,
            0x6 => 0x00,
            _ => 0xFF,
        }
    }

    pub fn write_reg(&mut self, offset: u16, value: u8) {
        match (offset >> 4) & 0x0F {
            0x0 if value == 0x55 => {
                self.latched = (0x8000, 0x8000);
                self.erased = true;
            }
            0x1 if value == 0xAA && self.erased => {
                // Lower X towards the right, higher Y towards the top (Pan Docs).
                let axis = |g: f32| (CENTER + g * PER_G).round().clamp(0.0, u16::MAX as f32) as u16;
                self.latched = (axis(-self.tilt.0), axis(self.tilt.1));
                self.erased = false;
            }
            _ => {}
        }
    }
}
