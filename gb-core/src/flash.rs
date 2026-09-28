//! MBC6's 1 MiB flash chip (Macronix MX29F008), driven by the standard unlock-cycle commands
//! (Pan Docs "MBC6"): `AA` to 5555, `55` to 2AAA, then the command. Addresses are flash offsets.
//! ponytail: no hidden 256-byte region and no sector 0 protect command; the Flash Write Enable
//! bit alone guards sector 0. Busy operations finish at once (status reads as done).

pub const FLASH_LEN: usize = 0x10_0000;
const SECTOR: usize = 0x2_0000;

/// What a read returns: the array, the JEDEC ID, or the status of the last program/erase.
const READ: u8 = 0;
const ID: u8 = 1;
const PROGRAM: u8 = 2;
const STATUS: u8 = 3;

pub struct Flash {
    pub data: Vec<u8>,
    mode: u8,
    /// Unlock cycles seen (0-2) and the first command byte of a two-part one (0x80 erase, 0x60).
    unlock: u8,
    pending: u8,
}

impl Flash {
    pub fn new() -> Self {
        Flash { data: vec![0xFF; FLASH_LEN], mode: READ, unlock: 0, pending: 0 }
    }

    pub fn read(&self, addr: usize) -> u8 {
        match self.mode {
            READ => self.data[addr % FLASH_LEN],
            ID => [0xC2, 0x81][addr & 1],
            _ => 0x80, // done
        }
    }

    /// A write while the flash is enabled; `write_enabled` is the MBC6's Flash Write Enable bit,
    /// without which sector 0 cannot be programmed or erased.
    pub fn write(&mut self, addr: usize, v: u8, write_enabled: bool) {
        let addr = addr % FLASH_LEN;
        let writable = |a: usize| write_enabled || a >= SECTOR;
        if v == 0xF0 {
            (self.mode, self.unlock, self.pending) = (READ, 0, 0);
            return;
        }
        if self.mode == PROGRAM {
            // Programming can only clear bits; only an erase sets them back.
            if writable(addr) { self.data[addr] &= v; }
            return;
        }
        let cmd_addr = addr & 0x7FFF;
        match (self.unlock, cmd_addr, v) {
            (0, 0x5555, 0xAA) => self.unlock = 1,
            (1, 0x2AAA, 0x55) => self.unlock = 2,
            // Sector erase: its last byte goes to any address inside the sector.
            (2, _, 0x30) if self.pending == 0x80 => {
                let start = addr / SECTOR * SECTOR;
                if writable(start) { self.data[start..start + SECTOR].fill(0xFF); }
                (self.mode, self.unlock, self.pending) = (STATUS, 0, 0);
            }
            (2, 0x5555, _) => {
                self.unlock = 0;
                match (self.pending, v) {
                    (0, 0x80 | 0x60) => self.pending = v,
                    (0, 0x90) => self.mode = ID,
                    (0, 0xA0) => self.mode = PROGRAM,
                    (0x80, 0x10) => {
                        let from = if write_enabled { 0 } else { SECTOR };
                        self.data[from..].fill(0xFF);
                        (self.mode, self.pending) = (STATUS, 0);
                    }
                    _ => self.pending = 0,
                }
            }
            _ => (self.unlock, self.pending) = (0, 0),
        }
    }

    /// Command state for save states: mode, unlock step, pending command.
    pub fn export_state(&self) -> [u8; 3] {
        [self.mode, self.unlock, self.pending]
    }

    pub fn import_state(&mut self, d: &[u8]) {
        let [mode, unlock, pending] = d.first_chunk::<3>().copied().unwrap_or([READ, 0, 0]);
        (self.mode, self.unlock, self.pending) = (mode.min(STATUS), unlock.min(2), pending);
    }
}
