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
        let mut days = total_secs / 86400;

        match reg {
            0x08 => secs = (value % 60) as u64,
            0x09 => mins = (value % 60) as u64,
            0x0A => hours = (value % 24) as u64,
            0x0B => days = (days & 0x100) | value as u64,
            0x0C => {
                days = (days & 0xFF) | (((value & 0x01) as u64) << 8);
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

        let new_total = secs + mins * 60 + hours * 3600 + days * 86400;
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
}

pub struct Cartridge {
    rom: Vec<u8>,
    ram: Vec<u8>,
    mbc: MbcType,
    rom_bank_count: usize,
    rtc: Option<Rtc>,
    rumble: bool,
}

impl Cartridge {
    pub fn from_rom(data: Vec<u8>) -> Result<Self, CartridgeError> {
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
            _ => return Err(CartridgeError::UnsupportedType { cart_type }),
        };

        let rom_bank_count = 2usize << (rom_size as usize);

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
                        // A8=0: RAM enable (value 0x0A enables, anything else disables)
                        *ram_enabled = value == 0x0A;
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
                    if value <= 0x03 {
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
                }
                _ => {}
            },
        }
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

    pub fn has_battery(&self) -> bool {
        !self.ram.is_empty()
    }

    pub fn export_sram(&self) -> Vec<u8> {
        let mut data = self.ram.clone();
        // Append RTC state if present (48 bytes)
        if let Some(ref rtc) = self.rtc {
            data.extend_from_slice(&rtc.base_timestamp.to_le_bytes()); // 8 bytes
            data.push(rtc.halted as u8);                                // 1 byte
            data.extend_from_slice(&rtc.halted_elapsed.to_le_bytes()); // 8 bytes
            data.extend_from_slice(&rtc.latched);                       // 5 bytes
            // Pad to 48 bytes for future expansion
            data.extend_from_slice(&[0u8; 26]);
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
            if data.len() >= ram_len + 17 {
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
        }
    }
}
