//! Cheat codes, clean-room from the public format descriptions.
//!
//! - Game Genie `ABC-DEF[-GHI]`: every read of a ROM address returns a new byte; with the 9-digit
//!   form only while the byte being read equals the compare value (so the patch follows its bank).
//! - GameShark `TTVVLLHH`: a RAM write re-applied once per frame. Type `01` writes through the bus,
//!   `90`-`97` into Color work-RAM bank X ($D000-$DFFF; X = 0 means bank 1).

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum Cheat {
    Rom { addr: u16, value: u8, compare: Option<u8> },
    Ram { addr: u16, value: u8, bank: Option<u8> },
}

/// Decodes one code. Case-insensitive; spaces and dashes are ignored.
pub fn parse(code: &str) -> Result<Cheat, String> {
    let d: Vec<u8> = code
        .chars()
        .filter(|c| !c.is_whitespace() && *c != '-')
        .map(|c| c.to_digit(16).map(|v| v as u8))
        .collect::<Option<_>>()
        .ok_or("not a hexadecimal code")?;
    match d.len() {
        6 | 9 => {
            let addr = ((d[5] as u16 ^ 0xF) << 12) | (d[2] as u16) << 8 | (d[3] as u16) << 4 | d[4] as u16;
            if addr >= 0x8000 {
                return Err("Game Genie address must be in ROM (below $8000)".into());
            }
            let compare = (d.len() == 9).then(|| ((d[6] << 4) | d[8]).rotate_right(2) ^ 0xBA);
            Ok(Cheat::Rom { addr, value: d[0] << 4 | d[1], compare })
        }
        8 => {
            let byte = |i: usize| d[i] << 4 | d[i + 1];
            let (kind, value) = (byte(0), byte(2));
            let addr = u16::from_le_bytes([byte(4), byte(6)]);
            let bank = match kind {
                0x01 => None,
                0x90..=0x97 => Some((kind & 7).max(1)),
                _ => return Err(format!("unsupported GameShark type {kind:02X}")),
            };
            let ok = match bank {
                None => matches!(addr, 0xA000..=0xDFFF | 0xFF80..=0xFFFE),
                Some(_) => (0xD000..=0xDFFF).contains(&addr),
            };
            if !ok {
                return Err(format!("GameShark address ${addr:04X} is not RAM"));
            }
            Ok(Cheat::Ram { addr, value, bank })
        }
        _ => Err("a code has 6 or 9 digits (Game Genie) or 8 (GameShark)".into()),
    }
}

/// The active codes. Not part of save states: they are configuration.
#[derive(Default)]
pub struct Cheats {
    rom: Vec<Cheat>,
    pub(crate) ram: Vec<Cheat>,
}

impl Cheats {
    /// Replaces the active set.
    pub fn set(&mut self, list: Vec<Cheat>) {
        (self.rom, self.ram) = list.into_iter().partition(|c| matches!(c, Cheat::Rom { .. }));
    }

    pub fn is_empty(&self) -> bool {
        self.rom.is_empty() && self.ram.is_empty()
    }

    #[inline]
    pub fn rom_is_empty(&self) -> bool {
        self.rom.is_empty()
    }

    /// The byte a ROM read returns: the first matching patch in list order, else `byte`.
    pub fn patch_rom(&self, addr: u16, byte: u8) -> u8 {
        for c in &self.rom {
            if let Cheat::Rom { addr: a, value, compare } = *c {
                if a == addr && compare.is_none_or(|v| v == byte) {
                    return value;
                }
            }
        }
        byte
    }
}
