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
    /// EEPROM pins as last written (CS 0x80, CLK 0x40, DI 0x02) and the DO line.
    pins: u8,
    data_out: bool,
    /// Serial state: IDLE (waiting for a start bit), COMMAND (2-bit opcode + 8 address bits),
    /// READ (shifting `shift` out on DO) or DATA (shifting 16 bits in for `target`).
    phase: u8,
    shift: u16,
    bits: u8,
    /// Word the DATA phase programs, or `ALL` for WRAL.
    target: u16,
    write_enabled: bool,
}

const IDLE: u8 = 0;
const COMMAND: u8 = 1;
const READ: u8 = 2;
const DATA: u8 = 3;
const ALL: u16 = 0x100;

impl Mbc7 {
    pub fn new() -> Self {
        Mbc7 {
            tilt: (0.0, 0.0),
            latched: (0x8000, 0x8000),
            erased: false,
            pins: 0,
            data_out: true,
            phase: IDLE,
            shift: 0,
            bits: 0,
            target: 0,
            write_enabled: false,
        }
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
            0x8 => self.pins | self.data_out as u8,
            _ => 0xFF,
        }
    }

    /// Write of A000-AFFF; `ram` is the EEPROM (128 little-endian words).
    pub fn write_reg(&mut self, ram: &mut [u8], offset: u16, value: u8) {
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
            0x8 => self.eeprom_write(ram, value),
            _ => {}
        }
    }

    /// 93LC56 in 16-bit organisation: bits are taken on CLK rising edges while CS is high.
    fn eeprom_write(&mut self, ram: &mut [u8], value: u8) {
        let rising = value & 0x40 != 0 && self.pins & 0x40 == 0;
        let di = (value >> 1) as u16 & 1;
        self.pins = value & 0xC2;
        if value & 0x80 == 0 {
            (self.phase, self.data_out) = (IDLE, true);
            return;
        }
        if !rising { return; }
        match self.phase {
            IDLE if di == 1 => (self.phase, self.shift, self.bits) = (COMMAND, 0, 0),
            COMMAND => {
                self.shift = self.shift << 1 | di;
                self.bits += 1;
                if self.bits >= 10 { self.command(ram); }
            }
            READ => {
                self.data_out = self.shift & 0x8000 != 0;
                self.shift <<= 1;
            }
            DATA => {
                self.shift = self.shift << 1 | di;
                self.bits += 1;
                if self.bits >= 16 {
                    let word = self.shift;
                    if self.target == ALL {
                        (0..128).for_each(|a| self.program(ram, a, word));
                    } else {
                        self.program(ram, self.target, word);
                    }
                    (self.phase, self.data_out) = (IDLE, true);
                }
            }
            _ => {}
        }
    }

    fn command(&mut self, ram: &mut [u8]) {
        let addr = self.shift & 0x7F;
        (self.phase, self.data_out) = (IDLE, true);
        match (self.shift >> 8 & 3, self.shift >> 6 & 3) {
            // READ: a dummy 0, then the word MSB first, one bit per clock.
            (0b10, _) => {
                let i = addr as usize * 2;
                self.shift = u16::from_le_bytes([ram.get(i).copied().unwrap_or(0xFF), ram.get(i + 1).copied().unwrap_or(0xFF)]);
                (self.phase, self.data_out) = (READ, false);
            }
            (0b01, _) => (self.phase, self.shift, self.bits, self.target) = (DATA, 0, 0, addr),
            (0b11, _) => self.program(ram, addr, 0xFFFF),
            (0b00, 0b11) => self.write_enabled = true,
            (0b00, 0b00) => self.write_enabled = false,
            (0b00, 0b10) => (0..128).for_each(|a| self.program(ram, a, 0xFFFF)),
            (0b00, _) => (self.phase, self.shift, self.bits, self.target) = (DATA, 0, 0, ALL),
            _ => {}
        }
    }

    /// Serial and sensor state for save states (the EEPROM words travel with SRAM).
    pub fn export(&self) -> Vec<u8> {
        let mut out = vec![self.pins, self.data_out as u8, self.phase, self.bits, self.write_enabled as u8, self.erased as u8];
        for w in [self.shift, self.target, self.latched.0, self.latched.1] { out.extend(w.to_le_bytes()); }
        out
    }

    /// Restores `export`; anything else (an older state) puts the serial port back to power-on.
    pub fn import(&mut self, d: &[u8]) {
        let tilt = self.tilt;
        *self = Mbc7 { tilt, ..Mbc7::new() };
        let Some((b, w)) = d.split_first_chunk::<6>().filter(|(_, w)| w.len() >= 8) else { return };
        let w = |i: usize| u16::from_le_bytes([w[2 * i], w[2 * i + 1]]);
        (self.pins, self.data_out, self.phase, self.bits) = (b[0] & 0xC2, b[1] != 0, b[2].min(DATA), b[3].min(16));
        (self.write_enabled, self.erased) = (b[4] != 0, b[5] != 0);
        (self.shift, self.target, self.latched) = (w(0), w(1).min(ALL), (w(2), w(3)));
    }

    /// Programs one word; refused until EWEN (power-on is write-disabled).
    fn program(&self, ram: &mut [u8], addr: u16, word: u16) {
        let i = addr as usize * 2;
        if let (true, Some(dst)) = (self.write_enabled, ram.get_mut(i..i + 2)) {
            dst.copy_from_slice(&word.to_le_bytes());
        }
    }
}
