//! S-DSP: the SNES sound generator that the SPC700 drives through `$F2`/`$F3` (Super Game Boy sound).
//!
//! Clean-room from public documentation (fullsnes, Anomie's S-DSP doc). 128 registers, eight voices
//! playing BRR samples from audio RAM, and one 32 kHz stereo sample per `sample` call. The DSP never
//! owns audio RAM: the caller passes the SPC700's `aram` in.

use crate::spc700::DspBus;

// Global registers ($x0-$x9 of each $x0 row are voice x's).
const FLG: usize = 0x6C;
const ENDX: usize = 0x7C;

pub struct Sdsp {
    regs: [u8; 128],
}

impl Default for Sdsp {
    fn default() -> Self {
        Self::new()
    }
}

impl Sdsp {
    pub fn new() -> Self {
        let mut regs = [0; 128];
        regs[FLG] = 0xE0; // power-up: soft reset, mute, echo writes disabled
        Sdsp { regs }
    }

    /// `$80-$FF` mirror `$00-$7F`.
    pub fn read_reg(&mut self, reg: u8) -> u8 {
        self.regs[reg as usize & 0x7F]
    }

    /// Writes to `$80-$FF` are ignored; any write to ENDX clears it.
    pub fn write_reg(&mut self, reg: u8, value: u8) {
        match reg as usize {
            ENDX => self.regs[ENDX] = 0,
            r @ 0..=0x7F => self.regs[r] = value,
            _ => {}
        }
    }
}

impl DspBus for Sdsp {
    fn read(&mut self, reg: u8) -> u8 {
        self.read_reg(reg)
    }
    fn write(&mut self, reg: u8, value: u8) {
        self.write_reg(reg, value)
    }
}

/// One BRR sample from its 4-bit `nibble`, with `p1` the previous decoded sample and `p2` the one
/// before. Decoded samples are 15-bit values stored doubled, so bit 15 wraps as on hardware.
fn brr_sample(header: u8, nibble: u8, p1: i16, p2: i16) -> i16 {
    let shift = header >> 4;
    let n = ((nibble << 4) as i8 >> 4) as i32;
    let mut s = if shift <= 12 {
        (n << shift) >> 1
    } else if n < 0 {
        -2048
    } else {
        0
    };
    let (p1, p2) = (p1 as i32, p2 as i32 >> 1);
    s += match header >> 2 & 3 {
        0 => 0,
        1 => (p1 >> 1) + (-p1 >> 5),                        // p1 × 15/16
        2 => p1 - p2 + (p2 >> 4) + ((p1 * -3) >> 6),        // p1 × 61/32 - p2 × 15/16
        _ => p1 - p2 + ((p1 * -13) >> 7) + ((p2 * 3) >> 4), // p1 × 115/64 - p2 × 13/16
    };
    (s.clamp(-0x8000, 0x7FFF) * 2) as i16
}

/// Decodes one 9-byte BRR block (header: shift, filter, loop, end). `prev` holds the two samples
/// before the block, oldest first, and is left holding the block's last two.
pub fn decode_brr_block(block: &[u8; 9], prev: &mut [i16; 2]) -> [i16; 16] {
    let mut out = [0; 16];
    for (i, o) in out.iter_mut().enumerate() {
        let byte = block[1 + i / 2];
        let nibble = if i % 2 == 0 { byte >> 4 } else { byte & 0x0F };
        *o = brr_sample(block[0], nibble, prev[1], prev[0]);
        *prev = [prev[1], *o];
    }
    out
}
