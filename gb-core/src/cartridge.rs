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
}

pub struct Cartridge {
    rom: Vec<u8>,
    ram: Vec<u8>,
    mbc: MbcType,
    rom_bank_count: usize,
    rtc: Option<Rtc>,
    rumble: bool,
    /// Rumble motor (RAM bank register bit 3 on rumble carts), and M-cycles it ran / elapsed since
    /// the host last asked (`take_rumble`).
    motor: bool,
    motor_on: u32,
    motor_total: u32,
    pub camera: Option<Box<crate::camera::Camera>>,
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
            _ => return Err(CartridgeError::UnsupportedType { cart_type }),
        };

        // $00-$08: 32 KB << n. Anything else (a damaged or hand-made header) is sized from the file,
        // never 0 banks: `2 << n` wraps to 0 for some of them.
        let rom_bank_count = if rom_size <= 8 { 2usize << rom_size } else { (data.len() / 0x4000).next_power_of_two().max(2) };

        // MBC2 has built-in 512x4-bit RAM; ignore the ram_size header byte for it
        let ram_bytes = match cart_type {
            0x05..=0x06 => 512,
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
            rumble: matches!(cart_type, 0x1C..=0x1E),
            motor: false,
            motor_on: 0,
            motor_total: 0,
            camera: (cart_type == 0xFC).then(|| Box::new(crate::camera::Camera::new())),
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

            MbcType::Camera { rom_bank, .. } => match addr {
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
        !self.ram.is_empty() || self.rtc.is_some()
    }

    /// SRAM, plus on MBC3+TIMER the 48-byte clock footer used by VBA-M, BGB, mGBA and SameBoy:
    /// live s/m/h/DL/DH and latched s/m/h/DL/DH as u32 LE, then the unix time (u64 LE) they were taken at.
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
        }
        if let Some(rtc) = &mut self.rtc {
            rtc.selected_register = (s[5] != 0).then_some(s[5]);
            rtc.latch_ready = s[6] != 0;
        }
    }

    pub fn import_sram(&mut self, data: &[u8]) {
        let ram_len = self.ram.len();
        let len = data.len().min(ram_len);
        self.ram[..len].copy_from_slice(&data[..len]);

        // Restore RTC state if present
        if let Some(ref mut rtc) = self.rtc {
            let footer = data.get(ram_len..).unwrap_or(&[]);
            let word = |i: usize| u32::from_le_bytes(footer[i * 4..i * 4 + 4].try_into().unwrap());
            // Standard footer (44 B with a u32 time, 48 B with a u64): ten u32 registers, all < 256.
            // The legacy Cartouche layout starts with an f64 ms timestamp, whose bytes 1-3 are never all 0.
            if (footer.len() == 44 || footer.len() == 48) && (0..10).all(|i| word(i) < 256) {
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
        }
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
