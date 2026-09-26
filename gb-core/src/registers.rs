const ZERO_FLAG: u8 = 0b1000_0000;
const SUBTRACT_FLAG: u8 = 0b0100_0000;
const HALF_CARRY_FLAG: u8 = 0b0010_0000;
const CARRY_FLAG: u8 = 0b0001_0000;

#[derive(Debug, Clone)]
pub struct Registers {
    pub a: u8,
    pub b: u8,
    pub c: u8,
    pub d: u8,
    pub e: u8,
    pub f: u8,
    pub h: u8,
    pub l: u8,
    pub sp: u16,
    pub pc: u16,
}

impl Default for Registers {
    fn default() -> Self {
        Self {
            a: 0, b: 0, c: 0, d: 0, e: 0, f: 0, h: 0, l: 0,
            sp: 0, pc: 0,
        }
    }
}

impl Registers {
    pub fn af(&self) -> u16 {
        (self.a as u16) << 8 | self.f as u16
    }

    pub fn bc(&self) -> u16 {
        (self.b as u16) << 8 | self.c as u16
    }

    pub fn de(&self) -> u16 {
        (self.d as u16) << 8 | self.e as u16
    }

    pub fn hl(&self) -> u16 {
        (self.h as u16) << 8 | self.l as u16
    }

    pub fn set_af(&mut self, val: u16) {
        self.a = (val >> 8) as u8;
        self.f = (val & 0xF0) as u8; // lower 4 bits always 0
    }

    pub fn set_bc(&mut self, val: u16) {
        self.b = (val >> 8) as u8;
        self.c = val as u8;
    }

    pub fn set_de(&mut self, val: u16) {
        self.d = (val >> 8) as u8;
        self.e = val as u8;
    }

    pub fn set_hl(&mut self, val: u16) {
        self.h = (val >> 8) as u8;
        self.l = val as u8;
    }

    // Flag getters
    pub fn zero(&self) -> bool {
        self.f & ZERO_FLAG != 0
    }

    pub fn subtract(&self) -> bool {
        self.f & SUBTRACT_FLAG != 0
    }

    pub fn half_carry(&self) -> bool {
        self.f & HALF_CARRY_FLAG != 0
    }

    pub fn carry(&self) -> bool {
        self.f & CARRY_FLAG != 0
    }

    // Flag setters
    pub fn set_zero(&mut self, val: bool) {
        if val {
            self.f |= ZERO_FLAG;
        } else {
            self.f &= !ZERO_FLAG;
        }
    }

    pub fn set_subtract(&mut self, val: bool) {
        if val {
            self.f |= SUBTRACT_FLAG;
        } else {
            self.f &= !SUBTRACT_FLAG;
        }
    }

    pub fn set_half_carry(&mut self, val: bool) {
        if val {
            self.f |= HALF_CARRY_FLAG;
        } else {
            self.f &= !HALF_CARRY_FLAG;
        }
    }

    pub fn set_carry(&mut self, val: bool) {
        if val {
            self.f |= CARRY_FLAG;
        } else {
            self.f &= !CARRY_FLAG;
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn test_af_lower_bits_masked() {
        let mut regs = Registers::default();
        regs.set_af(0x01FF);
        assert_eq!(regs.a, 0x01);
        assert_eq!(regs.f, 0xF0); // lower 4 bits cleared
    }

    #[test]
    fn test_register_pairs() {
        let mut regs = Registers::default();
        regs.set_bc(0x1234);
        assert_eq!(regs.b, 0x12);
        assert_eq!(regs.c, 0x34);
        assert_eq!(regs.bc(), 0x1234);

        regs.set_de(0x5678);
        assert_eq!(regs.de(), 0x5678);

        regs.set_hl(0x9ABC);
        assert_eq!(regs.hl(), 0x9ABC);
    }

    #[test]
    fn test_flags() {
        let mut regs = Registers::default();
        regs.set_zero(true);
        assert!(regs.zero());
        assert_eq!(regs.f, 0x80);

        regs.set_carry(true);
        assert!(regs.carry());
        assert_eq!(regs.f, 0x90);

        regs.set_zero(false);
        assert!(!regs.zero());
        assert_eq!(regs.f, 0x10);
    }
}
