use crate::error::CartridgeError;

/// Wall-clock milliseconds since the epoch: `Date.now()` in the browser, the system clock natively
/// (js_sys::Date panics outside wasm, which crashed MBC3+TIMER carts in native tests/tools).
fn now_ms() -> f64 {
    #[cfg(target_arch = "wasm32")]
    {
        js_sys::Date::now()
    }
    #[cfg(not(target_arch = "wasm32"))]
    {
        std::time::SystemTime::now()
            .duration_since(std::time::UNIX_EPOCH)
            .map_or(0.0, |d| d.as_secs_f64() * 1000.0)
    }
}

pub struct Rtc {
    /// Base timestamp (ms since epoch) when RTC was last synchronized
    base_timestamp: f64,
    /// Latched register values (frozen on latch)
    latched: [u8; 5], // seconds, minutes, hours, days_low, days_high
    /// Whether the latch sequence is in progress (wrote 0x00, waiting for 0x01)
    latch_ready: bool,
    /// Halt flag — when true, RTC does not advance
    halted: bool,
    /// The elapsed seconds at the time halt was engaged
    halted_elapsed: f64,
    /// Currently selected RTC register (0x08-0x0C), or None if RAM bank selected
    selected_register: Option<u8>,
}

impl Rtc {
    fn new() -> Self {
        Self {
            base_timestamp: now_ms(),
            latched: [0; 5],
            latch_ready: false,
            halted: false,
            halted_elapsed: 0.0,
            selected_register: None,
        }
    }

    fn elapsed_seconds(&self) -> f64 {
        if self.halted {
            self.halted_elapsed
        } else {
            (now_ms() - self.base_timestamp) / 1000.0
        }
    }

    fn latch(&mut self) {
        let total_secs = self.elapsed_seconds().max(0.0) as u64;
        let secs = (total_secs % 60) as u8;
        let mins = ((total_secs / 60) % 60) as u8;
        let hours = ((total_secs / 3600) % 24) as u8;
        let days = (total_secs / 86400) as u16;

        self.latched[0] = secs;
        self.latched[1] = mins;
        self.latched[2] = hours;
        self.latched[3] = (days & 0xFF) as u8;
        let mut high = ((days >> 8) & 0x01) as u8;
        if self.halted { high |= 0x40; }
        if days > 511 { high |= 0x80; } // day counter overflow
        self.latched[4] = high;
    }

    fn read(&self, reg: u8) -> u8 {
        match reg {
            0x08 => self.latched[0],
            0x09 => self.latched[1],
            0x0A => self.latched[2],
            0x0B => self.latched[3],
            0x0C => self.latched[4],
            _ => 0xFF,
        }
    }

    fn write(&mut self, reg: u8, value: u8) {
        let total_secs = self.elapsed_seconds().max(0.0) as u64;
        let mut secs = (total_secs % 60) as u64;
        let mut mins = ((total_secs / 60) % 60) as u64;
        let mut hours = ((total_secs / 3600) % 24) as u64;
        // The 9-bit day counter, and its carry (DH bit 7): sticky, only a DH write sets or clears it.
        let mut days = (total_secs / 86400) % 512;
        let mut carry = total_secs / 86400 >= 512;

        match reg {
            0x08 => secs = (value % 60) as u64,
            0x09 => mins = (value % 60) as u64,
            0x0A => hours = (value % 24) as u64,
            0x0B => days = (days & 0x100) | value as u64,
            0x0C => {
                days = (days & 0xFF) | (((value & 0x01) as u64) << 8);
                carry = value & 0x80 != 0;
                let new_halt = value & 0x40 != 0;
                if new_halt && !self.halted {
                    self.halted_elapsed = self.elapsed_seconds();
                } else if !new_halt && self.halted {
                    self.base_timestamp = now_ms() - self.halted_elapsed * 1000.0;
                }
                self.halted = new_halt;
            }
            _ => return,
        }

        let new_total = secs + mins * 60 + hours * 3600 + (days + if carry { 512 } else { 0 }) * 86400;
        if self.halted {
            self.halted_elapsed = new_total as f64;
        } else {
            self.base_timestamp = now_ms() - (new_total as f64) * 1000.0;
        }
    }
}

/// The HuC3's clock: minutes of the day and a day counter, reached through a nibble-wide command
/// protocol (Pan Docs HuC3). Its 256 nibbles of memory hold the time at 0x00-0x05 (after 0x60) and
/// the alarm at 0x58-0x5F.
pub struct Huc3Rtc {
    /// Wall clock (ms since epoch) at which the clock read 0 days, 00:00.
    base_timestamp: f64,
    memory: [u8; 256],
    address: u8,
    result: u8,
    last_opcode: u8,
}

impl Huc3Rtc {
    fn new() -> Self {
        Self { base_timestamp: now_ms(), memory: [0; 256], address: 0, result: 0, last_opcode: 0 }
    }

    fn minutes_and_days(&self) -> (u16, u16) {
        let total = ((now_ms() - self.base_timestamp) / 60000.0).max(0.0) as u64;
        ((total % 1440) as u16, (total / 1440 % 4096) as u16)
    }

    fn set(&mut self, minutes: u16, days: u16) {
        let total = (minutes % 1440) as f64 + (days % 4096) as f64 * 1440.0;
        self.base_timestamp = now_ms() - total * 60000.0;
    }

    /// Reads `n` nibbles of memory from `at`, low nibble first.
    fn nibbles(&self, at: usize, n: usize) -> u32 {
        (0..n).fold(0, |v, i| v | ((self.memory[at + i] as u32 & 0xF) << (4 * i)))
    }

    fn set_nibbles(&mut self, at: usize, n: usize, v: u32) {
        for i in 0..n { self.memory[at + i] = (v >> (4 * i) & 0xF) as u8; }
    }

    /// A write to A000-BFFF in mode 0xB: opcode in bits 6-4, argument in bits 3-0.
    fn command(&mut self, value: u8) {
        let (op, arg) = (value >> 4 & 0x07, value & 0x0F);
        self.last_opcode = op;
        let at = self.address as usize;
        match op {
            0x1 => { self.result = self.memory[at]; self.address = self.address.wrapping_add(1); }
            0x3 => { self.memory[at] = arg; self.address = self.address.wrapping_add(1); }
            0x4 => self.address = self.address & 0xF0 | arg,
            0x5 => self.address = self.address & 0x0F | arg << 4,
            0x6 => match arg {
                0x0 => {
                    let (minutes, days) = self.minutes_and_days();
                    self.set_nibbles(0, 3, minutes as u32);
                    self.set_nibbles(3, 3, days as u32);
                }
                0x1 => self.set(self.nibbles(0, 3) as u16, self.nibbles(3, 3) as u16),
                0x2 => self.result = 0x1,
                _ => {}
            },
            _ => {}
        }
    }

    /// A read of A000-BFFF in mode 0xC.
    fn read(&self) -> u8 {
        0x80 | self.last_opcode << 4 | self.result
    }

    /// Cartouche's own `.sav` footer: minutes of the day, days, alarm minutes, alarm days and alarm
    /// enabled as u32 LE, then the unix time (u64 LE, seconds) they were taken at.
    fn export_footer(&self) -> [u8; HUC3_FOOTER_LEN] {
        let (minutes, days) = self.minutes_and_days();
        let words = [minutes as u32, days as u32, self.nibbles(0x58, 3), self.nibbles(0x5B, 4), self.nibbles(0x5F, 1) & 1];
        let mut out = [0; HUC3_FOOTER_LEN];
        for (i, w) in words.iter().enumerate() { out[i * 4..i * 4 + 4].copy_from_slice(&w.to_le_bytes()); }
        out[20..].copy_from_slice(&((now_ms() / 1000.0) as u64).to_le_bytes());
        out
    }

    /// Restores the footer; the clock goes on by the wall time elapsed since it was written.
    fn import_footer(&mut self, f: &[u8]) {
        let word = |i: usize| u32::from_le_bytes(f[i * 4..i * 4 + 4].try_into().unwrap());
        let saved_at = u64::from_le_bytes(f[20..28].try_into().unwrap()) as f64;
        let elapsed = (word(0) % 1440) as f64 * 60.0 + (word(1) % 4096) as f64 * 86400.0;
        self.base_timestamp = (saved_at - elapsed) * 1000.0;
        self.set_nibbles(0x58, 3, word(2));
        self.set_nibbles(0x5B, 4, word(3));
        self.set_nibbles(0x5F, 1, word(4) & 1);
    }
}

const HUC3_FOOTER_LEN: usize = 28;

pub const MAPPER_STATE_LEN: usize = 7;

pub enum MbcType {
    NoMbc,
    Mbc1 {
        ram_enabled: bool,
        rom_bank: u8,
        ram_bank: u8,
        mode: bool,
    },
    Mbc2 {
        ram_enabled: bool,
        rom_bank: u8,
    },
    Mbc3 {
        ram_enabled: bool,
        rom_bank: u8,
        ram_bank: u8,
    },
    Mbc5 {
        ram_enabled: bool,
        rom_bank: u16,
        ram_bank: u8,
    },
    /// Pocket camera (MAC-GBD): RAM banks 0-15, or the capture unit's registers when bit 4 is set.
    Camera {
        ram_enabled: bool,
        rom_bank: u8,
        ram_bank: u8,
    },
    /// Hudson HuC1: `0000-1FFF` picks RAM or the IR port (`0x0E`), no separate RAM enable.
    Huc1 {
        ir_mode: bool,
        rom_bank: u8,
        ram_bank: u8,
    },
    /// Hudson HuC3: `0000-1FFF` picks what A000-BFFF is (RAM, the clock's command port, IR...).
    Huc3 {
        mode: u8,
        rom_bank: u8,
        ram_bank: u8,
    },
    /// MBC7 (tilt): A000-AFFF is the accelerometer/EEPROM window once both enables are set.
    Mbc7 {
        rom_bank: u8,
        ram_enable_1: bool,
        ram_enable_2: bool,
    },
}

pub struct Cartridge {
    rom: Vec<u8>,
    ram: Vec<u8>,
    mbc: MbcType,
    rom_bank_count: usize,
    rtc: Option<Rtc>,
    huc3: Option<Huc3Rtc>,
    rumble: bool,
    /// Rumble motor (RAM bank register bit 3 on rumble carts), and M-cycles it ran / elapsed since
    /// the host last asked (`take_rumble`).
    motor: bool,
    motor_on: u32,
    motor_total: u32,
    pub camera: Option<Box<crate::camera::Camera>>,
    mbc7: Option<Box<crate::mbc7::Mbc7>>,
}

impl Cartridge {
    pub fn from_rom(mut data: Vec<u8>) -> Result<Self, CartridgeError> {
        // A dump with a 512-byte copier header in front (16 KB banks + 0x200): drop it.
        if data.len() % 0x4000 == 0x200 {
            data.drain(..0x200);
        }
        if data.len() < 0x150 {
            return Err(CartridgeError::RomTooSmall {
                expected: 0x150,
                actual: data.len(),
            });
        }

        let cart_type = data[0x0147];
        let rom_size = data[0x0148];
        let ram_size = data[0x0149];

        // Verify header checksum
        let mut checksum: u8 = 0;
        for addr in 0x0134..=0x014C {
            checksum = checksum.wrapping_sub(data[addr]).wrapping_sub(1);
        }
        if checksum != data[0x014D] {
            return Err(CartridgeError::InvalidChecksum {
                expected: checksum,
                actual: data[0x014D],
            });
        }

        let mbc = match cart_type {
            0x00 => MbcType::NoMbc,
            0x01..=0x03 => MbcType::Mbc1 {
                ram_enabled: false,
                rom_bank: 1,
                ram_bank: 0,
                mode: false,
            },
            0x05..=0x06 => MbcType::Mbc2 {
                ram_enabled: false,
                rom_bank: 1,
            },
            0x0F..=0x13 => MbcType::Mbc3 {
                ram_enabled: false,
                rom_bank: 1,
                ram_bank: 0,
            },
            0x19..=0x1E => MbcType::Mbc5 {
                ram_enabled: false,
                rom_bank: 1,
                ram_bank: 0,
            },
            0xFC => MbcType::Camera {
                ram_enabled: false,
                rom_bank: 1,
                ram_bank: 0,
            },
            0xFE => MbcType::Huc3 { mode: 0, rom_bank: 1, ram_bank: 0 },
            0xFF => MbcType::Huc1 { ir_mode: false, rom_bank: 1, ram_bank: 0 },
            0x22 => MbcType::Mbc7 { rom_bank: 1, ram_enable_1: false, ram_enable_2: false },
            _ => return Err(CartridgeError::UnsupportedType { cart_type }),
        };

        // $00-$08: 32 KB << n. Anything else (a damaged or hand-made header) is sized from the file,
        // never 0 banks: `2 << n` wraps to 0 for some of them. A header smaller than the file (a
        // homebrew that never updated it) does not hide the banks past it: the chip is the file's size.
        let file_banks = data.len().div_ceil(0x4000).next_power_of_two().max(2);
        let rom_bank_count = if rom_size <= 8 { (2usize << rom_size).max(file_banks) } else { file_banks };

        // MBC2 has built-in 512x4-bit RAM; ignore the ram_size header byte for it
        let ram_bytes = match cart_type {
            0x05..=0x06 => 512,
            // MBC7: a 93LC56 EEPROM (128 16-bit words); the header says 0x00.
            0x22 => 256,
            _ => match ram_size {
                0x00 => 0,
                0x01 => 2 * 1024,
                0x02 => 8 * 1024,
                0x03 => 32 * 1024,
                0x04 => 128 * 1024,
                0x05 => 64 * 1024,
                _ => 0,
            },
        };

        let rtc = match cart_type {
            0x0F | 0x10 => Some(Rtc::new()),
            _ => None,
        };

        Ok(Cartridge {
            rom: data,
            ram: vec![0; ram_bytes],
            mbc,
            rom_bank_count,
            rtc,
            huc3: (cart_type == 0xFE).then(Huc3Rtc::new),
            rumble: matches!(cart_type, 0x1C..=0x1E),
            motor: false,
            motor_on: 0,
            motor_total: 0,
            camera: (cart_type == 0xFC).then(|| Box::new(crate::camera::Camera::new())),
            mbc7: (cart_type == 0x22).then(|| Box::new(crate::mbc7::Mbc7::new())),
        })
    }

    pub fn read_rom(&self, addr: u16) -> u8 {
        match &self.mbc {
            MbcType::NoMbc => self.rom.get(addr as usize).copied().unwrap_or(0xFF),

            MbcType::Mbc1 {
                rom_bank, mode, ram_bank, ..
            } => match addr {
                0x0000..=0x3FFF => {
                    if *mode {
                        let bank = (*ram_bank as usize) << 5;
                        let offset = (bank % self.rom_bank_count) * 0x4000 + addr as usize;
                        self.rom.get(offset).copied().unwrap_or(0xFF)
                    } else {
                        self.rom.get(addr as usize).copied().unwrap_or(0xFF)
                    }
                }
                0x4000..=0x7FFF => {
                    let bank = ((*ram_bank as usize) << 5) | (*rom_bank as usize);
                    let effective_bank = bank % self.rom_bank_count.max(1);
                    let offset = effective_bank * 0x4000 + (addr as usize - 0x4000);
                    self.rom.get(offset).copied().unwrap_or(0xFF)
                }
                _ => 0xFF,
            },

            MbcType::Mbc2 { rom_bank, .. } => match addr {
                0x0000..=0x3FFF => self.rom.get(addr as usize).copied().unwrap_or(0xFF),
                0x4000..=0x7FFF => {
                    let bank = (*rom_bank as usize) % self.rom_bank_count.max(1);
                    let offset = bank * 0x4000 + (addr as usize - 0x4000);
                    self.rom.get(offset).copied().unwrap_or(0xFF)
                }
                _ => 0xFF,
            },

            MbcType::Mbc3 { rom_bank, .. } => match addr {
                0x0000..=0x3FFF => self.rom.get(addr as usize).copied().unwrap_or(0xFF),
                0x4000..=0x7FFF => {
                    let bank = (*rom_bank as usize) % self.rom_bank_count.max(1);
                    let offset = bank * 0x4000 + (addr as usize - 0x4000);
                    self.rom.get(offset).copied().unwrap_or(0xFF)
                }
                _ => 0xFF,
            },

            MbcType::Camera { rom_bank, .. }
            | MbcType::Huc1 { rom_bank, .. }
            | MbcType::Huc3 { rom_bank, .. }
            | MbcType::Mbc7 { rom_bank, .. } => match addr {
                0x0000..=0x3FFF => self.rom.get(addr as usize).copied().unwrap_or(0xFF),
                0x4000..=0x7FFF => {
                    let bank = (*rom_bank as usize) % self.rom_bank_count.max(1);
                    let offset = bank * 0x4000 + (addr as usize - 0x4000);
                    self.rom.get(offset).copied().unwrap_or(0xFF)
                }
                _ => 0xFF,
            },

            MbcType::Mbc5 { rom_bank, .. } => match addr {
                0x0000..=0x3FFF => self.rom.get(addr as usize).copied().unwrap_or(0xFF),
                0x4000..=0x7FFF => {
                    let bank = (*rom_bank as usize) % self.rom_bank_count.max(1);
                    let offset = bank * 0x4000 + (addr as usize - 0x4000);
                    self.rom.get(offset).copied().unwrap_or(0xFF)
                }
                _ => 0xFF,
            },
        }
    }

    pub fn write_rom(&mut self, addr: u16, value: u8) {
        match &mut self.mbc {
            MbcType::NoMbc => {}

            MbcType::Mbc1 {
                ram_enabled,
                rom_bank,
                ram_bank,
                mode,
            } => match addr {
                0x0000..=0x1FFF => *ram_enabled = (value & 0x0F) == 0x0A,
                0x2000..=0x3FFF => {
                    let bank = value & 0x1F;
                    *rom_bank = if bank == 0 { 1 } else { bank };
                }
                0x4000..=0x5FFF => *ram_bank = value & 0x03,
                0x6000..=0x7FFF => *mode = (value & 0x01) != 0,
                _ => {}
            },

            MbcType::Mbc2 { ram_enabled, rom_bank } => {
                // Only 0x0000-0x3FFF is used for control writes
                if addr <= 0x3FFF {
                    if addr & 0x0100 == 0 {
                        // A8=0: RAM enable (low nibble 0xA enables, as on MBC1/3/5: $FA or $1A too)
                        *ram_enabled = value & 0x0F == 0x0A;
                    } else {
                        // A8=1: ROM bank select (lower 4 bits, bank 0 maps to bank 1)
                        let bank = value & 0x0F;
                        *rom_bank = if bank == 0 { 1 } else { bank };
                    }
                }
            }

            MbcType::Mbc3 {
                ram_enabled,
                rom_bank,
                ram_bank,
            } => match addr {
                0x0000..=0x1FFF => *ram_enabled = (value & 0x0F) == 0x0A,
                0x2000..=0x3FFF => {
                    let bank = value & 0x7F;
                    *rom_bank = if bank == 0 { 1 } else { bank };
                }
                0x4000..=0x5FFF => {
                    // 0-7: MBC30 (64 KB) has 8 RAM banks; on a 32 KB MBC3 banks 4-7 mirror 0-3.
                    if value <= 0x07 {
                        *ram_bank = value;
                        if let Some(ref mut rtc) = self.rtc {
                            rtc.selected_register = None;
                        }
                    } else if value >= 0x08 && value <= 0x0C {
                        if let Some(ref mut rtc) = self.rtc {
                            rtc.selected_register = Some(value);
                        }
                    }
                }
                0x6000..=0x7FFF => {
                    if let Some(ref mut rtc) = self.rtc {
                        if value == 0x00 {
                            rtc.latch_ready = true;
                        } else if value == 0x01 && rtc.latch_ready {
                            rtc.latch();
                            rtc.latch_ready = false;
                        } else {
                            rtc.latch_ready = false;
                        }
                    }
                }
                _ => {}
            },

            MbcType::Mbc5 {
                ram_enabled,
                rom_bank,
                ram_bank,
            } => match addr {
                0x0000..=0x1FFF => *ram_enabled = (value & 0x0F) == 0x0A,
                0x2000..=0x2FFF => {
                    *rom_bank = (*rom_bank & 0x100) | value as u16;
                }
                0x3000..=0x3FFF => {
                    *rom_bank = (*rom_bank & 0xFF) | ((value as u16 & 0x01) << 8);
                }
                0x4000..=0x5FFF => {
                    // On rumble carts (0x1C-0x1E) bit 3 drives the motor, not the RAM bank.
                    *ram_bank = value & if self.rumble { 0x07 } else { 0x0F };
                    if self.rumble { self.motor = value & 0x08 != 0; }
                }
                _ => {}
            },

            MbcType::Camera { ram_enabled, rom_bank, ram_bank } => match addr {
                0x0000..=0x1FFF => *ram_enabled = (value & 0x0F) == 0x0A,
                0x2000..=0x3FFF => *rom_bank = value & 0x3F,
                0x4000..=0x5FFF => *ram_bank = value & 0x1F,
                _ => {}
            },

            // Unlike MBC1, a written 0 maps bank 0 (Pan Docs HuC1).
            MbcType::Huc1 { ir_mode, rom_bank, ram_bank } => match addr {
                0x0000..=0x1FFF => *ir_mode = value & 0x0F == 0x0E,
                0x2000..=0x3FFF => *rom_bank = value & 0x3F,
                0x4000..=0x5FFF => *ram_bank = value & 0x03,
                _ => {}
            },

            MbcType::Huc3 { mode, rom_bank, ram_bank } => match addr {
                0x0000..=0x1FFF => *mode = value & 0x0F,
                0x2000..=0x3FFF => *rom_bank = value & 0x7F,
                0x4000..=0x5FFF => *ram_bank = value & 0x03,
                _ => {}
            },

            // ponytail: bank 0 is not remapped to 1 (Pan Docs leaves it unconfirmed).
            MbcType::Mbc7 { rom_bank, ram_enable_1, ram_enable_2 } => match addr {
                0x0000..=0x1FFF => *ram_enable_1 = value == 0x0A,
                0x2000..=0x3FFF => *rom_bank = value & 0x7F,
                0x4000..=0x5FFF => *ram_enable_2 = value == 0x40,
                _ => {}
            },
        }
    }

    /// Advances cartridge hardware by one CPU M-cycle: the camera's capture, the rumble duty meter.
    pub fn tick(&mut self) {
        if self.rumble {
            self.motor_total = self.motor_total.saturating_add(1);
            if self.motor { self.motor_on = self.motor_on.saturating_add(1); }
        }
        if let Some(cam) = &mut self.camera {
            if let Some(picture) = cam.tick(1) {
                let at = crate::camera::PICTURE_AT;
                if let Some(dst) = self.ram.get_mut(at..at + picture.len()) { dst.copy_from_slice(&picture); }
            }
        }
    }

    /// Whether the cartridge has a rumble motor (types 0x1C-0x1E).
    pub fn has_rumble(&self) -> bool {
        self.rumble
    }

    /// Share of the time the motor ran since the last call (0-1): games pulse it to vary the strength.
    pub fn take_rumble(&mut self) -> f32 {
        let level = if self.motor_total == 0 { self.motor as u8 as f32 } else { self.motor_on as f32 / self.motor_total as f32 };
        (self.motor_on, self.motor_total) = (0, 0);
        level
    }

    pub fn read_ram(&self, offset: u16) -> u8 {
        match &self.mbc {
            MbcType::NoMbc => self.ram.get(offset as usize).copied().unwrap_or(0xFF),

            MbcType::Mbc1 {
                ram_enabled,
                ram_bank,
                mode,
                ..
            } => {
                if !ram_enabled || self.ram.is_empty() {
                    return 0xFF;
                }
                let bank = if *mode { *ram_bank as usize } else { 0 };
                let addr = self.ram_index(bank, offset);
                self.ram.get(addr).copied().unwrap_or(0xFF)
            }

            MbcType::Mbc2 { ram_enabled, .. } => {
                if !*ram_enabled {
                    return 0xFF;
                }
                // 512-byte internal RAM; upper nibble reads as 0xF (unused bits)
                let idx = (offset & 0x01FF) as usize;
                self.ram.get(idx).map(|b| b | 0xF0).unwrap_or(0xFF)
            }

            MbcType::Mbc3 {
                ram_enabled,
                ram_bank,
                ..
            } => {
                if !ram_enabled {
                    return 0xFF;
                }
                if let Some(ref rtc) = self.rtc {
                    if let Some(reg) = rtc.selected_register {
                        return rtc.read(reg);
                    }
                }
                let addr = self.ram_index(*ram_bank as usize, offset);
                self.ram.get(addr).copied().unwrap_or(0xFF)
            }

            MbcType::Mbc5 {
                ram_enabled,
                ram_bank,
                ..
            } => {
                if !ram_enabled || self.ram.is_empty() {
                    return 0xFF;
                }
                let addr = self.ram_index(*ram_bank as usize, offset);
                self.ram.get(addr).copied().unwrap_or(0xFF)
            }

            // RAM reads work without the enable (it only guards writes); mid-capture they read 0.
            MbcType::Camera { ram_bank, .. } => {
                let cam = self.camera.as_deref();
                if ram_bank & 0x10 != 0 {
                    return cam.map_or(0, |c| c.read((offset & 0x7F) as usize));
                }
                if cam.is_some_and(|c| c.busy()) { return 0x00; }
                let addr = self.ram_index((*ram_bank & 0x0F) as usize, offset);
                self.ram.get(addr).copied().unwrap_or(0xFF)
            }

            // ponytail: no infrared link, so the IR receiver never sees light.
            MbcType::Huc1 { ir_mode: true, .. } => 0xC0,
            MbcType::Huc1 { ram_bank, .. } => {
                if self.ram.is_empty() { return 0xFF; }
                self.ram[self.ram_index(*ram_bank as usize, offset)]
            }

            // ponytail: the speaker and IR are not emulated; IR reads no light.
            MbcType::Huc3 { mode, ram_bank, .. } => match mode {
                0x0 | 0xA if !self.ram.is_empty() => self.ram[self.ram_index(*ram_bank as usize, offset)],
                0xC => self.huc3.as_ref().map_or(0xFF, Huc3Rtc::read),
                0xD => 0x01,
                0xE => 0xC0,
                _ => 0xFF,
            },

            MbcType::Mbc7 { ram_enable_1: true, ram_enable_2: true, .. } if offset < 0x1000 => {
                self.mbc7.as_ref().map_or(0xFF, |m| m.read_reg(offset))
            }
            MbcType::Mbc7 { .. } => 0xFF,
        }
    }

    /// Banked SRAM index; the bank number wraps to the RAM actually present, as the MBC ignores
    /// the unused high bank bits (a 32 KB cart mirrors banks 4-15 onto 0-3).
    fn ram_index(&self, bank: usize, offset: u16) -> usize {
        if self.ram.is_empty() { return 0; }
        (bank * 0x2000 + offset as usize) % self.ram.len()
    }

    pub fn cgb_mode(&self) -> bool {
        self.rom.get(0x0143).map_or(false, |&b| b & 0x80 != 0)
    }

    /// Something to keep across sessions: cartridge RAM, or the clock (MBC3+TIMER+BATTERY without RAM).
    pub fn has_battery(&self) -> bool {
        !self.ram.is_empty() || self.rtc.is_some() || self.huc3.is_some()
    }

    /// SRAM, plus on MBC3+TIMER the 48-byte clock footer used by VBA-M, BGB, mGBA and SameBoy:
    /// live s/m/h/DL/DH and latched s/m/h/DL/DH as u32 LE, then the unix time (u64 LE) they were taken at.
    /// Byte `i` of the cartridge RAM, whatever bank is paged in or whether it is enabled (RetroAchievements reads).
    pub fn ram_byte(&self, i: usize) -> Option<u8> {
        self.ram.get(i).copied()
    }

    pub fn export_sram(&self) -> Vec<u8> {
        let mut data = self.ram.clone();
        if let Some(ref rtc) = self.rtc {
            let mut live = Rtc { latched: [0; 5], ..*rtc };
            live.latch();
            for b in live.latched.iter().chain(rtc.latched.iter()) {
                data.extend_from_slice(&(*b as u32).to_le_bytes());
            }
            data.extend_from_slice(&((now_ms() / 1000.0) as u64).to_le_bytes());
        }
        if let Some(ref huc3) = self.huc3 {
            data.extend_from_slice(&huc3.export_footer());
        }
        data
    }

    /// Mapper registers for save states (SRAM and RTC go through export_sram):
    /// rom_bank (u16 LE), ram_bank, ram_enabled, MBC1 mode, RTC register select, RTC latch armed.
    pub fn export_state(&self) -> [u8; MAPPER_STATE_LEN] {
        let (rom_bank, ram_bank, ram_enabled, mode) = match self.mbc {
            MbcType::NoMbc => (0, 0, false, false),
            MbcType::Mbc1 { ram_enabled, rom_bank, ram_bank, mode } => (rom_bank as u16, ram_bank, ram_enabled, mode),
            MbcType::Mbc2 { ram_enabled, rom_bank } => (rom_bank as u16, 0, ram_enabled, false),
            MbcType::Mbc3 { ram_enabled, rom_bank, ram_bank } => (rom_bank as u16, ram_bank, ram_enabled, false),
            MbcType::Mbc5 { ram_enabled, rom_bank, ram_bank } => (rom_bank, ram_bank, ram_enabled, false),
            MbcType::Camera { ram_enabled, rom_bank, ram_bank } => (rom_bank as u16, ram_bank, ram_enabled, false),
            MbcType::Huc1 { ir_mode, rom_bank, ram_bank } => (rom_bank as u16, ram_bank, false, ir_mode),
            MbcType::Huc3 { rom_bank, ram_bank, .. } => (rom_bank as u16, ram_bank, false, false),
            MbcType::Mbc7 { rom_bank, ram_enable_1, ram_enable_2 } => (rom_bank as u16, 0, ram_enable_1, ram_enable_2),
        };
        let (sel, latch) = self.rtc.as_ref().map_or((0, false), |r| (r.selected_register.unwrap_or(0), r.latch_ready));
        let [lo, hi] = rom_bank.to_le_bytes();
        [lo, hi, ram_bank, ram_enabled as u8, mode as u8, sel, latch as u8]
    }

    pub fn import_state(&mut self, s: &[u8; MAPPER_STATE_LEN]) {
        let rb = u16::from_le_bytes([s[0], s[1]]);
        let (en, rab, md) = (s[3] != 0, s[2], s[4] != 0);
        match &mut self.mbc {
            MbcType::NoMbc => {}
            MbcType::Mbc1 { ram_enabled, rom_bank, ram_bank, mode } => {
                (*ram_enabled, *rom_bank, *ram_bank, *mode) = (en, rb as u8, rab, md)
            }
            MbcType::Mbc2 { ram_enabled, rom_bank } => (*ram_enabled, *rom_bank) = (en, rb as u8),
            MbcType::Mbc3 { ram_enabled, rom_bank, ram_bank } => (*ram_enabled, *rom_bank, *ram_bank) = (en, rb as u8, rab),
            MbcType::Mbc5 { ram_enabled, rom_bank, ram_bank } => (*ram_enabled, *rom_bank, *ram_bank) = (en, rb, rab),
            MbcType::Camera { ram_enabled, rom_bank, ram_bank } => (*ram_enabled, *rom_bank, *ram_bank) = (en, rb as u8, rab),
            MbcType::Huc1 { ir_mode, rom_bank, ram_bank } => (*ir_mode, *rom_bank, *ram_bank) = (md, rb as u8, rab),
            MbcType::Huc3 { rom_bank, ram_bank, .. } => (*rom_bank, *ram_bank) = (rb as u8, rab),
            MbcType::Mbc7 { rom_bank, ram_enable_1, ram_enable_2 } => (*rom_bank, *ram_enable_1, *ram_enable_2) = (rb as u8, en, md),
        }
        if let Some(rtc) = &mut self.rtc {
            rtc.selected_register = (s[5] != 0).then_some(s[5]);
            rtc.latch_ready = s[6] != 0;
        }
    }

    /// Mapper state beyond the fixed `export_state` block, for the save state's length-prefixed
    /// mapper block. MBC7: its serial and sensor state (`Mbc7::export`). Empty for every other mapper
    /// but HuC3: mode, address, last result, last opcode, then
    /// its 256 memory nibbles packed two per byte (low nibble first).
    pub fn export_extra(&self) -> Vec<u8> {
        if let Some(m) = &self.mbc7 { return m.export(); }
        let (MbcType::Huc3 { mode, .. }, Some(h)) = (&self.mbc, &self.huc3) else { return Vec::new() };
        let mut out = vec![*mode, h.address, h.result, h.last_opcode];
        out.extend(h.memory.chunks(2).map(|p| p[0] & 0xF | p[1] << 4));
        out
    }

    /// Restores `export_extra`. Anything shorter (a state saved before the block existed) puts the
    /// registers back to power-on; the HuC3 memory is left as the battery save restored it.
    pub fn import_extra(&mut self, data: &[u8]) {
        if let Some(m) = &mut self.mbc7 { return m.import(data); }
        let (MbcType::Huc3 { mode, .. }, Some(h)) = (&mut self.mbc, &mut self.huc3) else { return };
        let Some((regs, packed)) = data.split_first_chunk::<4>().filter(|(_, p)| p.len() >= 128) else {
            (*mode, h.address, h.result, h.last_opcode) = (0, 0, 0, 0);
            return;
        };
        (*mode, h.address, h.result, h.last_opcode) = (regs[0] & 0x0F, regs[1], regs[2] & 0x0F, regs[3] & 0x07);
        for (i, b) in packed[..128].iter().enumerate() {
            (h.memory[2 * i], h.memory[2 * i + 1]) = (b & 0xF, b >> 4);
        }
    }

    pub fn import_sram(&mut self, data: &[u8]) {
        let ram_len = self.ram.len();
        // Standard clock footer (44 B with a u32 time, 48 B with a u64): ten u32 registers, all < 256.
        // The legacy Cartouche layout starts with an f64 ms timestamp, whose bytes 1-3 are never all 0.
        // Found from the end of the file, after a RAM part of any cartridge RAM size: other emulators
        // may save more or less RAM than the header says.
        let word = |f: &[u8], i: usize| u32::from_le_bytes(f[i * 4..i * 4 + 4].try_into().unwrap());
        let footer = self.rtc.as_ref().and([48, 44].into_iter().find(|&n| {
            let Some(ram_part) = data.len().checked_sub(n) else { return false };
            (ram_part == 0 || ram_part.is_power_of_two()) && (0..10).all(|i| word(&data[ram_part..], i) < 256)
        })).map(|n| &data[data.len() - n..]);
        let len = (data.len() - footer.map_or(0, |f| f.len())).min(ram_len);
        self.ram[..len].copy_from_slice(&data[..len]);

        // Restore RTC state if present
        if let Some(ref mut rtc) = self.rtc {
            if let Some(footer) = footer {
                let word = |i: usize| word(footer, i);
                let saved_at = if footer.len() == 48 {
                    u64::from_le_bytes(footer[40..48].try_into().unwrap()) as f64
                } else {
                    word(10) as f64
                };
                let dh = word(4) as u8;
                let days = (word(3) & 0xFF) as u64 | ((dh as u64 & 1) << 8) | if dh & 0x80 != 0 { 512 } else { 0 };
                let total = (word(0) % 60 + (word(1) % 60) * 60 + (word(2) % 24) * 3600) as u64 + days * 86400;
                rtc.halted = dh & 0x40 != 0;
                rtc.halted_elapsed = total as f64;
                rtc.base_timestamp = (saved_at - total as f64) * 1000.0;
                for (i, l) in rtc.latched.iter_mut().enumerate() { *l = word(5 + i) as u8; }
            } else if data.len() >= ram_len + 17 {
                let rtc_data = &data[ram_len..];
                rtc.base_timestamp = f64::from_le_bytes(
                    rtc_data[0..8].try_into().unwrap_or([0; 8]),
                );
                rtc.halted = rtc_data[8] != 0;
                rtc.halted_elapsed = f64::from_le_bytes(
                    rtc_data[9..17].try_into().unwrap_or([0; 8]),
                );
                if rtc_data.len() >= 22 {
                    rtc.latched.copy_from_slice(&rtc_data[17..22]);
                }
            }
        }
        if let Some(huc3) = &mut self.huc3 {
            if data.len() == ram_len + HUC3_FOOTER_LEN {
                huc3.import_footer(&data[ram_len..]);
            }
        }
    }

    pub fn write_ram(&mut self, offset: u16, value: u8) {
        match &self.mbc {
            MbcType::NoMbc => {
                if let Some(byte) = self.ram.get_mut(offset as usize) {
                    *byte = value;
                }
            }
            MbcType::Mbc1 {
                ram_enabled,
                ram_bank,
                mode,
                ..
            } => {
                if !ram_enabled || self.ram.is_empty() {
                    return;
                }
                let bank = if *mode { *ram_bank as usize } else { 0 };
                let addr = self.ram_index(bank, offset);
                if let Some(byte) = self.ram.get_mut(addr) {
                    *byte = value;
                }
            }
            MbcType::Mbc2 { ram_enabled, .. } => {
                if !*ram_enabled {
                    return;
                }
                // Only lower nibble is stored; upper 4 bits are unused
                let idx = (offset & 0x01FF) as usize;
                if let Some(byte) = self.ram.get_mut(idx) {
                    *byte = value & 0x0F;
                }
            }
            MbcType::Mbc3 {
                ram_enabled,
                ram_bank,
                ..
            } => {
                if !ram_enabled {
                    return;
                }
                if let Some(ref mut rtc) = self.rtc {
                    if let Some(reg) = rtc.selected_register {
                        rtc.write(reg, value);
                        return;
                    }
                }
                let addr = self.ram_index(*ram_bank as usize, offset);
                if let Some(byte) = self.ram.get_mut(addr) {
                    *byte = value;
                }
            }
            MbcType::Mbc5 {
                ram_enabled,
                ram_bank,
                ..
            } => {
                if !ram_enabled || self.ram.is_empty() {
                    return;
                }
                let addr = self.ram_index(*ram_bank as usize, offset);
                if let Some(byte) = self.ram.get_mut(addr) {
                    *byte = value;
                }
            }
            &MbcType::Camera { ram_enabled, ram_bank, .. } => {
                if ram_bank & 0x10 != 0 {
                    if let Some(cam) = &mut self.camera { cam.write((offset & 0x7F) as usize, value); }
                    return;
                }
                if !ram_enabled || self.camera.as_ref().is_some_and(|c| c.busy()) { return; }
                let addr = self.ram_index((ram_bank & 0x0F) as usize, offset);
                if let Some(byte) = self.ram.get_mut(addr) {
                    *byte = value;
                }
            }
            &MbcType::Huc1 { ir_mode: false, ram_bank, .. } => {
                let addr = self.ram_index(ram_bank as usize, offset);
                if let Some(byte) = self.ram.get_mut(addr) {
                    *byte = value;
                }
            }
            MbcType::Huc1 { .. } => {}
            &MbcType::Huc3 { mode: 0xA, ram_bank, .. } => {
                let addr = self.ram_index(ram_bank as usize, offset);
                if let Some(byte) = self.ram.get_mut(addr) {
                    *byte = value;
                }
            }
            MbcType::Huc3 { mode: 0xB, .. } => {
                if let Some(huc3) = &mut self.huc3 { huc3.command(value); }
            }
            MbcType::Huc3 { .. } => {}
            MbcType::Mbc7 { ram_enable_1: true, ram_enable_2: true, .. } if offset < 0x1000 => {
                if let Some(m) = &mut self.mbc7 { m.write_reg(&mut self.ram, offset, value); }
            }
            MbcType::Mbc7 { .. } => {}
        }
    }

    /// Whether the cartridge has an MBC7 accelerometer (type 0x22).
    pub fn has_tilt(&self) -> bool {
        self.mbc7.is_some()
    }

    /// MBC7 tilt in g (x > 0 = right side down, y > 0 = top side down), clamped to ±2 g and held
    /// until the next call; the game reads it at its next latch. Ignored on other cartridges.
    pub fn set_tilt(&mut self, x: f32, y: f32) {
        if let Some(m) = &mut self.mbc7 { m.set_tilt(x, y); }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    /// A blank ROM with a valid header of the given cartridge type and RAM size code.
    fn cart(cart_type: u8, ram_size: u8) -> Cartridge {
        let mut rom = vec![0u8; 0x8000 * 4];
        rom[0x147] = cart_type;
        rom[0x148] = 0x02; // 128 KB
        rom[0x149] = ram_size;
        let sum = (0x134..=0x14C).fold(0u8, |c, a| c.wrapping_sub(rom[a]).wrapping_sub(1));
        rom[0x14D] = sum;
        Cartridge::from_rom(rom).expect("valid header")
    }

    #[test]
    fn bad_rom_size_byte_is_sized_from_the_file() {
        for size in [0x09, 0x3F, 0x7F, 0xBF, 0xFF] {
            let mut rom = vec![0u8; 0x8000];
            rom[0x147] = 0x01; // MBC1
            rom[0x148] = size;
            rom[0x14D] = (0x134..=0x14C).fold(0u8, |c, a| c.wrapping_sub(rom[a]).wrapping_sub(1));
            let mut c = Cartridge::from_rom(rom).expect("loads");
            assert_eq!(c.rom_bank_count, 2, "{size:#04x}");
            c.write_rom(0x6000, 0x01); // mode 1: bank 0 area follows the upper bits
            assert_eq!(c.read_rom(0x0147), 0x01);
        }
    }

    #[test]
    fn a_header_smaller_than_the_file_still_reaches_every_bank() {
        let mut rom = vec![0u8; 0x4000 * 8];
        rom[0x147] = 0x01; // MBC1
        rom[0x148] = 0x00; // says 32 KB, the file is 128 KB
        rom[0x14D] = (0x134..=0x14C).fold(0u8, |c, a| c.wrapping_sub(rom[a]).wrapping_sub(1));
        rom[5 * 0x4000] = 0x55;
        let mut c = Cartridge::from_rom(rom).expect("loads");
        c.write_rom(0x2000, 5);
        assert_eq!(c.read_rom(0x4000), 0x55, "bank 5, not bank 1");
    }

    #[test]
    fn copier_header_is_dropped() {
        let mut rom = vec![0u8; 0x8000 * 4];
        rom[0x134] = b'T';
        rom[0x148] = 0x02;
        rom[0x14D] = (0x134..=0x14C).fold(0u8, |c, a| c.wrapping_sub(rom[a]).wrapping_sub(1));
        rom[0x4000] = 0x42;
        let mut dump = vec![0u8; 0x200];
        dump.extend_from_slice(&rom);
        let c = Cartridge::from_rom(dump).expect("header found past the 512-byte copier header");
        assert_eq!(c.read_rom(0x134), b'T');
        assert_eq!(c.read_rom(0x4000), 0x42, "banks line up");
    }

    #[test]
    fn huc1_banks_rom_and_ram_and_ir_reads_no_light() {
        let mut rom = vec![0u8; 0x8000 * 4];
        rom[0x147] = 0xFF;
        rom[0x148] = 0x02;
        rom[0x149] = 0x03;
        rom[0x14D] = (0x134..=0x14C).fold(0u8, |c, a| c.wrapping_sub(rom[a]).wrapping_sub(1));
        rom[5 * 0x4000] = 0x55;
        let mut c = Cartridge::from_rom(rom).expect("HuC1 loads");
        assert!(c.has_battery());
        c.write_rom(0x2000, 5);
        assert_eq!(c.read_rom(0x4000), 0x55);
        c.write_rom(0x2000, 0);
        assert_eq!(c.read_rom(0x4147), 0xFF, "bank 0 is mapped as is, not bumped to 1");
        c.write_rom(0x2000, 5);

        c.write_rom(0x0000, 0x0A);
        c.write_rom(0x4000, 2);
        c.write_ram(0, 0x11);
        assert_eq!(c.read_ram(0), 0x11);
        c.write_rom(0x4000, 0);
        assert_eq!(c.read_ram(0), 0x00, "bank 0 is another bank");
        c.write_rom(0x4000, 2);

        c.write_rom(0x0000, 0x0E);
        assert_eq!(c.read_ram(0), 0xC0, "IR: no light");
        c.write_ram(0, 0x99);
        c.write_rom(0x0000, 0x0A);
        assert_eq!(c.read_ram(0), 0x11, "an IR write does not reach RAM");

        c.write_rom(0x0000, 0x0E);
        let state = c.export_state();
        let mut fresh = cart(0xFF, 0x03);
        fresh.import_state(&state);
        assert_eq!(fresh.read_ram(0), 0xC0, "IR mode survives");
        assert_eq!(fresh.export_state(), state, "ROM bank 5 and RAM bank 2 survive");
        assert_eq!(state[..3], [5, 0, 2]);
    }

    /// One HuC3 RTC command: a write to A000 in mode 0xB (left selected).
    fn huc3_cmd(c: &mut Cartridge, cmd: u8) {
        c.write_rom(0x0000, 0x0B);
        c.write_ram(0, cmd);
    }

    /// Sets the HuC3 clock the way a game does: nibbles into memory 0x00-0x05, then commit (0x61).
    fn huc3_set_clock(c: &mut Cartridge, minutes: u16, days: u16) {
        huc3_cmd(c, 0x40);
        huc3_cmd(c, 0x50);
        for v in [minutes, days] {
            for i in 0..3 { huc3_cmd(c, 0x30 | ((v >> (4 * i)) & 0xF) as u8); }
        }
        huc3_cmd(c, 0x61);
    }

    /// Reads the HuC3 clock back: load the time (0x60), then six 0x1 reads, each seen in mode 0xC.
    fn huc3_clock(c: &mut Cartridge) -> (u16, u16) {
        huc3_cmd(c, 0x60);
        huc3_cmd(c, 0x40);
        huc3_cmd(c, 0x50);
        let mut n = [0u16; 6];
        for v in n.iter_mut() {
            huc3_cmd(c, 0x10);
            c.write_rom(0x0000, 0x0C);
            let r = c.read_ram(0);
            assert_eq!(r & 0xF0, 0x90, "0x80 | read opcode 1");
            *v = (r & 0x0F) as u16;
        }
        (n[0] | n[1] << 4 | n[2] << 8, n[3] | n[4] << 4 | n[5] << 8)
    }

    #[test]
    fn huc3_clock_is_set_and_read_through_commands() {
        let mut c = cart(0xFE, 0x03);
        assert!(c.has_battery());
        c.write_rom(0x0000, 0x0A);
        c.write_rom(0x4000, 3);
        c.write_ram(0x10, 0x42);
        assert_eq!(c.read_ram(0x10), 0x42);
        c.write_rom(0x0000, 0x00);
        c.write_ram(0x10, 0x99);
        assert_eq!(c.read_ram(0x10), 0x42, "mode 0 is read-only RAM");

        huc3_set_clock(&mut c, 615, 3);
        assert_eq!(huc3_clock(&mut c), (615, 3), "day 3, 10:15");

        c.write_rom(0x0000, 0x0D);
        assert_eq!(c.read_ram(0), 0x01, "semaphore: ready");
        c.write_rom(0x0000, 0x0E);
        assert_eq!(c.read_ram(0), 0xC0, "IR: no light");
        c.write_rom(0x0000, 0x07);
        assert_eq!(c.read_ram(0), 0xFF);
    }

    #[test]
    fn huc3_sav_footer_round_trips_and_advances() {
        let ram_len = 32 * 1024;
        let word = |s: &[u8], i: usize| u32::from_le_bytes(s[ram_len + 4 * i..ram_len + 4 * i + 4].try_into().unwrap());
        let mut c = cart(0xFE, 0x03);
        huc3_set_clock(&mut c, 615, 3);
        // Alarm at day 0x0102, 08:00, enabled: nibbles at 0x58-0x5A, 0x5B-0x5E, 0x5F.
        huc3_cmd(&mut c, 0x48);
        huc3_cmd(&mut c, 0x55);
        for n in [0x0, 0xE, 0x1, 0x2, 0x0, 0x1, 0x0, 0x1] { huc3_cmd(&mut c, 0x30 | n); }
        let mut sav = c.export_sram();
        assert_eq!(sav.len(), ram_len + 28);
        assert_eq!([word(&sav, 0), word(&sav, 1), word(&sav, 2), word(&sav, 3), word(&sav, 4)], [615, 3, 480, 0x0102, 1]);

        let at = sav.len() - 8;
        let saved_at = u64::from_le_bytes(sav[at..].try_into().unwrap());
        sav[at..].copy_from_slice(&(saved_at - 2 * 86400).to_le_bytes());
        let mut fresh = cart(0xFE, 0x03);
        fresh.import_sram(&sav);
        assert_eq!(huc3_clock(&mut fresh), (615, 5), "two days passed since the save");
        let again = fresh.export_sram();
        assert_eq!([word(&again, 2), word(&again, 3), word(&again, 4)], [480, 0x0102, 1], "alarm kept");

        let mut blank = cart(0xFE, 0x03);
        blank.import_sram(&vec![7; ram_len]);
        assert_eq!(blank.ram_byte(0), Some(7));
        assert_eq!(huc3_clock(&mut blank), (0, 0), "no footer: the clock starts at 0");
    }

    /// Erase then latch the accelerometer; returns (X, Y) as the game reads them.
    fn mbc7_latch(c: &mut Cartridge) -> (u16, u16) {
        c.write_ram(0x000, 0x55);
        c.write_ram(0x010, 0xAA);
        let word = |c: &Cartridge, lo: u16| u16::from_le_bytes([c.read_ram(lo), c.read_ram(lo + 0x10)]);
        (word(c, 0x020), word(c, 0x040))
    }

    #[test]
    fn mbc7_latches_tilt_behind_both_enables() {
        let mut c = cart(0x22, 0x00);
        assert_eq!(c.export_sram().len(), 256, "93LC56: 128 words");
        assert!(c.has_battery());

        c.write_rom(0x0000, 0x0A);
        assert_eq!(c.read_ram(0x020), 0xFF, "enable 1 alone keeps the registers hidden");
        c.write_rom(0x4000, 0x40);
        assert_eq!(c.read_ram(0x020), 0x00, "power-on X is 0x8000");
        assert_eq!(c.read_ram(0x030), 0x80);
        assert_eq!((c.read_ram(0x060), c.read_ram(0x070), c.read_ram(0x090)), (0x00, 0xFF, 0xFF));
        assert_eq!(c.read_ram(0x1020), 0xFF, "B000-BFFF reads 0xFF");

        c.set_tilt(0.0, 0.0);
        assert_eq!(mbc7_latch(&mut c), (0x81D0, 0x81D0));
        // Right side down lowers X; top side down raises Y (Pan Docs).
        c.set_tilt(1.0, -1.0);
        assert_eq!(mbc7_latch(&mut c), (0x8160, 0x8160));
        c.set_tilt(-1.0, 1.0);
        assert_eq!(mbc7_latch(&mut c), (0x8240, 0x8240));
        // 0xAA without a fresh 0x55 does not re-latch.
        c.set_tilt(0.0, 0.0);
        c.write_ram(0x010, 0xAA);
        assert_eq!(c.read_ram(0x020), 0x40);

        c.write_rom(0x4000, 0x00);
        assert_eq!(c.read_ram(0x020), 0xFF, "enable 2 off hides the registers again");

        c.write_rom(0x2000, 0x03);
        c.rom[3 * 0x4000] = 0x77;
        assert_eq!(c.read_rom(0x4000), 0x77);
    }

    /// Clocks bits into the MBC7 EEPROM the way games do: DI set, CLK up, CLK down, CS held high.
    fn clock_in(c: &mut Cartridge, bits: &[u8]) {
        for &b in bits {
            let di = b << 1;
            for v in [0x80 | di, 0xC0 | di, 0x80 | di] { c.write_ram(0x080, v); }
        }
    }

    /// Start bit, 2-bit opcode, 8 address bits (the top one unused), MSB first.
    fn eeprom_cmd(op: u8, addr: u8) -> Vec<u8> {
        let mut v = vec![1, op >> 1 & 1, op & 1];
        v.extend((0..8).rev().map(|i| addr >> i & 1));
        v
    }

    fn word_bits(w: u16) -> Vec<u8> {
        (0..16).rev().map(|i| (w >> i & 1) as u8).collect()
    }

    fn eeprom_end(c: &mut Cartridge) {
        c.write_ram(0x080, 0x00);
        c.write_ram(0x080, 0x80);
    }

    /// Clocks 16 bits out on DO.
    fn clock_out(c: &mut Cartridge) -> u16 {
        (0..16).fold(0, |w, _| {
            c.write_ram(0x080, 0x80);
            c.write_ram(0x080, 0xC0);
            w << 1 | (c.read_ram(0x080) & 1) as u16
        })
    }

    fn mbc7_enabled() -> Cartridge {
        let mut c = cart(0x22, 0x00);
        c.write_rom(0x0000, 0x0A);
        c.write_rom(0x4000, 0x40);
        c
    }

    #[test]
    fn set_tilt_reaches_the_cartridge() {
        let mut other = cart(0x1B, 0x03);
        assert!(!other.has_tilt());
        other.set_tilt(1.0, 1.0); // ignored, no panic
        let mut c = mbc7_enabled();
        assert!(c.has_tilt());
        c.set_tilt(5.0, f32::NAN); // clamped to 2 g; not a number reads level
        assert_eq!(mbc7_latch(&mut c), (0x81D0 - 0xE0, 0x81D0));
    }

    #[test]
    fn mbc7_eeprom_writes_after_ewen_and_reads_back() {
        let mut c = mbc7_enabled();
        let write = [eeprom_cmd(0b01, 5), word_bits(0x1234)].concat();
        clock_in(&mut c, &write);
        eeprom_end(&mut c);
        assert_eq!(c.export_sram()[10..12], [0, 0], "power-on is write-disabled");

        clock_in(&mut c, &eeprom_cmd(0b00, 0xC0)); // EWEN
        eeprom_end(&mut c);
        clock_in(&mut c, &write);
        eeprom_end(&mut c);
        assert_eq!(c.read_ram(0x080) & 1, 1, "DO reads ready after the write");
        assert_eq!(c.export_sram()[10..12], [0x34, 0x12]);

        clock_in(&mut c, &eeprom_cmd(0b10, 5)); // READ
        assert_eq!(c.read_ram(0x080) & 1, 0, "dummy 0 before the data");
        assert_eq!(clock_out(&mut c), 0x1234);
        eeprom_end(&mut c);

        clock_in(&mut c, &eeprom_cmd(0b11, 5)); // ERASE
        eeprom_end(&mut c);
        assert_eq!(c.export_sram()[10..12], [0xFF, 0xFF]);
        clock_in(&mut c, &[eeprom_cmd(0b00, 0x40), word_bits(0xBEEF)].concat()); // WRAL
        eeprom_end(&mut c);
        assert!(c.export_sram().chunks(2).all(|w| w == [0xEF, 0xBE]));
        clock_in(&mut c, &eeprom_cmd(0b00, 0x00)); // EWDS
        eeprom_end(&mut c);
        clock_in(&mut c, &eeprom_cmd(0b00, 0x80)); // ERAL, refused
        eeprom_end(&mut c);
        assert_eq!(c.export_sram()[0..2], [0xEF, 0xBE]);
    }

    #[test]
    fn rumble_bit_drives_the_motor_not_the_ram_bank() {
        let mut c = cart(0x1E, 0x03);
        assert!(c.has_rumble());
        c.write_rom(0x0000, 0x0A);
        c.write_rom(0x4000, 0x01);
        c.write_ram(0, 0x11);
        c.write_rom(0x4000, 0x09); // bank 1 + motor
        assert_eq!(c.read_ram(0), 0x11, "bit 3 does not change the bank");
        for _ in 0..30 { c.tick(); }
        c.write_rom(0x4000, 0x01);
        for _ in 0..10 { c.tick(); }
        assert!((c.take_rumble() - 0.75).abs() < 1e-6, "on 30 of 40 cycles");
        assert_eq!(c.take_rumble(), 0.0, "off, and the meter restarted");
        // Plain MBC5: bit 3 is a bank bit and there is no motor.
        let mut plain = cart(0x1B, 0x04);
        plain.write_rom(0x4000, 0x08);
        plain.tick();
        assert!(!plain.has_rumble());
        assert_eq!(plain.take_rumble(), 0.0);
    }

    #[test]
    fn camera_maps_registers_on_bank_bit_4_and_writes_the_picture() {
        let mut c = cart(0xFC, 0x04);
        assert!(c.camera.is_some());
        c.write_rom(0x0000, 0x0A);
        c.write_rom(0x4000, 0x00);
        c.write_ram(0x0100, 0x5A);
        assert_eq!(c.read_ram(0x0100), 0x5A);
        c.write_rom(0x4000, 0x10);
        c.write_ram(0x0001, 0x80); // N = 1
        c.write_ram(0x0083, 0x00); // $A003 through the mirror at +$80
        c.write_ram(0x0000, 0x03); // start
        assert_eq!(c.read_ram(0x0000), 0x03);
        c.write_rom(0x4000, 0x00);
        assert_eq!(c.read_ram(0x0100), 0x00, "RAM reads 0 mid-capture");
        for _ in 0..32446 { c.tick(); }
        assert_ne!(c.read_ram(0x0100), 0x5A, "picture written over bank 0 at $0100");
        c.write_rom(0x4000, 0x10);
        assert_eq!(c.read_ram(0x0000) & 1, 0, "not busy any more");
        // Bank 15 is reachable and distinct from bank 0.
        c.write_rom(0x4000, 0x0F);
        c.write_ram(0, 0x77);
        c.write_rom(0x4000, 0x00);
        assert_ne!(c.read_ram(0), 0x77);
    }

    /// Latches the MBC3 clock and reads $08-$0C.
    fn read_clock(c: &mut Cartridge) -> [u8; 5] {
        c.write_rom(0x0000, 0x0A);
        c.write_rom(0x6000, 0x00);
        c.write_rom(0x6000, 0x01);
        core::array::from_fn(|i| { c.write_rom(0x4000, 0x08 + i as u8); c.read_ram(0) })
    }

    #[test]
    fn rtc_reads_the_standard_sav_footer_44_and_48_bytes() {
        let now = (now_ms() / 1000.0) as u64;
        for long in [false, true] {
            let mut c = cart(0x10, 0x03);
            let mut sav = vec![0u8; 0x8000];
            for v in [30u32, 45, 13, 5, 0, 1, 2, 3, 4, 0] { sav.extend_from_slice(&v.to_le_bytes()); }
            if long { sav.extend_from_slice(&now.to_le_bytes()) } else { sav.extend_from_slice(&(now as u32).to_le_bytes()) }
            c.import_sram(&sav);
            let r = read_clock(&mut c);
            assert_eq!((r[1], r[2], r[3], r[4]), (45, 13, 5, 0), "running, day 5 13:45");
            assert!(r[0] >= 30 && r[0] < 33);
            // A halted clock stays put.
            sav[0x8000 + 16] = 0x40;
            c.import_sram(&sav);
            assert_eq!(read_clock(&mut c), [30, 45, 13, 5, 0x40]);
        }
    }

    /// The footer is found from the end: a RAM part larger or smaller than the header's 8 KB
    /// (here 32 KB and 2 KB) is not read as the legacy layout, nor copied into RAM as data.
    #[test]
    fn rtc_footer_is_found_after_a_ram_part_of_another_size() {
        for (ram, long) in [(0x8000, true), (0x8000, false), (0x800, true), (0x800, false)] {
            let mut c = cart(0x10, 0x02);
            let mut sav = vec![0xAAu8; ram];
            for v in [30u32, 45, 13, 5, 0x40, 1, 2, 3, 4, 0x40] { sav.extend_from_slice(&v.to_le_bytes()); }
            if long { sav.extend_from_slice(&1_700_000_000u64.to_le_bytes()) } else { sav.extend_from_slice(&1_700_000_000u32.to_le_bytes()) }
            c.import_sram(&sav);
            assert_eq!(read_clock(&mut c), [30, 45, 13, 5, 0x40], "RAM {ram:#x}, long {long}");
            assert_eq!(c.ram[ram.min(0x2000) - 1], 0xAA);
            if ram < 0x2000 { assert_eq!(c.ram[ram], 0, "the footer is not RAM"); }
        }
        // A RAM-only file (no footer) whose last bytes happen to be zero is not read as a clock.
        let mut c = cart(0x10, 0x03);
        let before = c.rtc.as_ref().unwrap().base_timestamp;
        c.import_sram(&[0u8; 0x8000]);
        assert_eq!(c.rtc.as_ref().unwrap().base_timestamp, before);
    }

    #[test]
    fn rtc_sav_export_is_standard_and_round_trips() {
        let mut c = cart(0x10, 0x03);
        c.write_rom(0x0000, 0x0A);
        for (reg, v) in [(0x0C, 0x40), (0x08, 7), (0x09, 8), (0x0A, 9), (0x0B, 10), (0x0C, 0x41)] {
            c.write_rom(0x4000, reg);
            c.write_ram(0, v);
        }
        let sav = c.export_sram();
        assert_eq!(sav.len(), 0x8000 + 48);
        let f = &sav[0x8000..];
        assert_eq!(&f[..20], &[7, 0, 0, 0, 8, 0, 0, 0, 9, 0, 0, 0, 10, 0, 0, 0, 0x41, 0, 0, 0]);
        let mut d = cart(0x10, 0x03);
        d.import_sram(&sav);
        assert_eq!(read_clock(&mut d), [7, 8, 9, 10, 0x41]);
    }

    #[test]
    fn rtc_day_carry_is_set_and_cleared_by_dh_writes_only() {
        let mut c = cart(0x10, 0x03);
        c.write_rom(0x0000, 0x0A);
        let mut set = |reg: u8, v: u8| { c.write_rom(0x4000, reg); c.write_ram(0, v); };
        set(0x0C, 0x40); // halt
        set(0x0C, 0xC1); // carry, day 256
        set(0x0B, 0x05); // day low: the carry stays
        set(0x08, 0x10);
        assert_eq!(read_clock(&mut c), [0x10, 0, 0, 0x05, 0xC1]);
        c.write_rom(0x4000, 0x0C);
        c.write_ram(0, 0x41); // carry cleared
        assert_eq!(read_clock(&mut c), [0x10, 0, 0, 0x05, 0x41]);
    }

    #[test]
    fn a_clock_cart_without_ram_still_keeps_its_clock() {
        let mut c = cart(0x0F, 0x00);
        assert!(c.has_battery(), "the clock is the save");
        c.write_rom(0x0000, 0x0A);
        for (reg, v) in [(0x0C, 0x40), (0x09, 30)] { c.write_rom(0x4000, reg); c.write_ram(0, v); }
        let sav = c.export_sram();
        assert_eq!(sav.len(), 48);
        let mut d = cart(0x0F, 0x00);
        d.import_sram(&sav);
        assert_eq!(read_clock(&mut d), [0, 30, 0, 0, 0x40]);
        assert!(!cart(0x11, 0x00).has_battery());
    }

    #[test]
    fn rtc_still_reads_the_legacy_cartouche_footer() {
        let mut c = cart(0x10, 0x03);
        let mut sav = vec![0u8; 0x8000];
        sav.extend_from_slice(&1.7e12f64.to_le_bytes());
        sav.push(1); // halted
        sav.extend_from_slice(&(3.0 * 86400.0 + 62.0f64).to_le_bytes());
        sav.extend_from_slice(&[0; 5]);
        sav.extend_from_slice(&[0; 26]);
        c.import_sram(&sav);
        assert_eq!(read_clock(&mut c), [2, 1, 0, 3, 0x40]);
    }

    #[test]
    fn mbc2_ram_enable_looks_at_the_low_nibble_only() {
        let mut c = cart(0x06, 0x00);
        c.write_rom(0x0000, 0x1A);
        c.write_ram(0, 0x05);
        assert_eq!(c.read_ram(0), 0xF5, "$1A enables");
        c.write_rom(0x0000, 0x0B);
        assert_eq!(c.read_ram(0), 0xFF, "$0B disables");
    }

    #[test]
    fn mbc30_has_eight_distinct_ram_banks() {
        let mut c = cart(0x10, 0x05);
        c.write_rom(0x0000, 0x0A);
        c.write_rom(0x4000, 0x00);
        c.write_ram(0, 0x11);
        c.write_rom(0x4000, 0x05);
        c.write_ram(0, 0x55);
        c.write_rom(0x4000, 0x00);
        assert_eq!(c.read_ram(0), 0x11);
        c.write_rom(0x4000, 0x05);
        assert_eq!(c.read_ram(0), 0x55);
    }
}
