//! S-DSP: the SNES sound generator that the SPC700 drives through `$F2`/`$F3` (Super Game Boy sound).
//!
//! Clean-room from public documentation (fullsnes, Anomie's S-DSP doc). 128 registers, eight voices
//! playing BRR samples from audio RAM, and one 32 kHz stereo sample per `sample` call. The DSP never
//! owns audio RAM: the caller passes the SPC700's `aram` in.

use crate::spc700::DspBus;
use std::sync::OnceLock;

// Global registers ($x0-$x9 of each $x0 row are voice x's).
const MVOLL: usize = 0x0C;
const MVOLR: usize = 0x1C;
const KON: usize = 0x4C;
const KOF: usize = 0x5C;
const FLG: usize = 0x6C;
const ENDX: usize = 0x7C;
const PMON: usize = 0x2D;
const NON: usize = 0x3D;
const DIR: usize = 0x5D;

// Voice registers, at voice × $10.
const VOLL: usize = 0;
const PITCHL: usize = 2;
const PITCHH: usize = 3;
const SRCN: usize = 4;
const ADSR1: usize = 5;
const ADSR2: usize = 6;
const GAIN: usize = 7;
const ENVX: usize = 8;
const OUTX: usize = 9;

// Envelope modes.
const RELEASE: u8 = 0;
const ATTACK: u8 = 1;
const DECAY: u8 = 2;
const SUSTAIN: u8 = 3;

/// The envelope/noise rate table: samples between steps for rates 0-31 (0 never steps), and the
/// counter offset of each rate. The global counter counts down through 2048 × 5 × 3 values.
const RATE_PERIOD: [u16; 32] = [
    0, 2048, 1536, 1280, 1024, 768, 640, 512, 384, 320, 256, 192, 160, 128, 96, 80, 64, 48, 40, 32,
    24, 20, 16, 12, 10, 8, 6, 5, 4, 3, 2, 1,
];
const COUNTER_RANGE: u16 = 2048 * 5 * 3;

fn rate_offset(rate: u8) -> u16 {
    match rate {
        1..=29 => [0, 1040, 536][(rate as usize - 1) % 3],
        _ => 0,
    }
}

/// The interpolation kernel: 512 entries, `g[k]` weighting a source sample `(511.5 - k) / 256`
/// samples from the output point, peak `$519`, zero two samples out.
// ponytail: generated from a Gaussian fit (σ² = 0.4) of the documented table's shape, not the chip's
// exact entries; weights sum to 2040-2046 of 2048. Swap in the exact curve if a test ever needs it.
fn gauss() -> &'static [i32; 512] {
    static TABLE: OnceLock<[i32; 512]> = OnceLock::new();
    TABLE.get_or_init(|| {
        let k = |d: f64| (-d * d / 0.8).exp() - (-4.0f64 / 0.8).exp();
        let peak = 1305.0 / k(0.5 / 256.0);
        std::array::from_fn(|i| (peak * k((511.5 - i as f64) / 256.0)).round() as i32)
    })
}

#[derive(Clone, Copy, Default)]
struct Voice {
    /// The last 12 decoded samples, a ring written 4 at a time at `buf_pos`.
    buf: [i16; 12],
    buf_pos: u8,
    /// 4.12 fixed point: the source position within the ring, from its oldest sample.
    interp_pos: u16,
    brr_addr: u16,
    /// Next byte pair within the 9-byte block: 1, 3, 5 or 7.
    brr_offset: u8,
    /// Samples left in the 5-sample key-on start.
    kon_delay: u8,
    mode: u8,
    env: i32,
    /// The envelope before clamping and before the rate counter lets it through.
    hidden_env: i32,
}

pub struct Sdsp {
    regs: [u8; 128],
    voices: [Voice; 8],
    counter: u16,
    noise: i32,
    /// KON/KOF are read on every other sample, starting with the first.
    every_other: bool,
    new_kon: u8,
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
        Sdsp {
            regs,
            voices: [Voice {
                brr_offset: 1,
                ..Voice::default()
            }; 8],
            counter: 0,
            noise: 0x4000,
            every_other: false,
            new_kon: 0,
        }
    }

    /// `$80-$FF` mirror `$00-$7F`.
    pub fn read_reg(&mut self, reg: u8) -> u8 {
        self.regs[reg as usize & 0x7F]
    }

    /// Writes to `$80-$FF` are ignored; any write to ENDX clears it.
    pub fn write_reg(&mut self, reg: u8, value: u8) {
        match reg as usize {
            ENDX => self.regs[ENDX] = 0,
            r @ 0..=0x7F => {
                if r == KON {
                    self.new_kon = value;
                }
                self.regs[r] = value
            }
            _ => {}
        }
    }

    /// Runs the DSP for one 32 kHz sample and returns it as (left, right).
    pub fn sample(&mut self, aram: &mut [u8; 0x10000]) -> (i16, i16) {
        self.counter = self.counter.checked_sub(1).unwrap_or(COUNTER_RANGE - 1);
        if self.fires(self.regs[FLG] & 0x1F) {
            let feedback = (self.noise << 13) ^ (self.noise << 14);
            self.noise = (feedback & 0x4000) ^ (self.noise >> 1);
        }
        self.every_other = !self.every_other;
        let (kon, koff) = match self.every_other {
            true => (std::mem::take(&mut self.new_kon), self.regs[KOF]),
            false => (0, 0),
        };

        let mut main = [0; 2];
        let mut out = 0;
        for i in 0..8 {
            out = self.run_voice(i, aram, kon, koff, out);
            for (ch, m) in main.iter_mut().enumerate() {
                let amp = (out * self.regs[i * 0x10 + VOLL + ch] as i8 as i32) >> 7;
                *m = (*m + amp).clamp(-0x8000, 0x7FFF);
            }
        }

        if self.regs[FLG] & 0x40 != 0 {
            return (0, 0);
        }
        let mix = |ch: usize, vol: usize| {
            let o = ((main[ch] * self.regs[vol] as i8 as i32) >> 7) as i16 as i32;
            o.clamp(-0x8000, 0x7FFF) as i16
        };
        (mix(0, MVOLL), mix(1, MVOLR))
    }

    /// Whether the envelope/noise step of `rate` happens this sample.
    fn fires(&self, rate: u8) -> bool {
        let period = RATE_PERIOD[rate as usize];
        period != 0 && (self.counter + rate_offset(rate)) % period == 0
    }

    /// Steps voice `i` and returns its output after the envelope, before its volumes. `prev_out`
    /// is the previous voice's output, for pitch modulation.
    fn run_voice(
        &mut self,
        i: usize,
        aram: &[u8; 0x10000],
        kon: u8,
        koff: u8,
        prev_out: i32,
    ) -> i32 {
        let (base, bit) = (i * 0x10, 1u8 << i);
        let mut v = self.voices[i];
        let r = |o: usize| self.regs[base + o];

        let mut pitch = (u16::from_le_bytes([r(PITCHL), r(PITCHH)]) & 0x3FFF) as i32;
        if self.regs[PMON] & bit & 0xFE != 0 {
            pitch += ((prev_out >> 5) * pitch) >> 10;
        }
        // The directory entry: start address while keying on, loop address otherwise.
        let entry = self.regs[DIR] as usize * 0x100 + r(SRCN) as usize * 4;
        let entry = (entry + if v.kon_delay == 0 { 2 } else { 0 }) & 0xFFFF;
        let next_addr = u16::from_le_bytes([aram[entry], aram[(entry + 1) & 0xFFFF]]);
        let mut header = aram[v.brr_addr as usize];

        if v.kon_delay > 0 {
            if v.kon_delay == 5 {
                v.brr_addr = next_addr;
                v.brr_offset = 1;
                v.buf_pos = 0;
                header = 0;
            }
            v.env = 0;
            v.hidden_env = 0;
            // Silent start: decode the first 12 samples on the middle three samples.
            v.kon_delay -= 1;
            v.interp_pos = if v.kon_delay & 3 != 0 { 0x4000 } else { 0 };
            pitch = 0;
        }

        let mut s = interpolate(&v);
        if self.regs[NON] & bit != 0 {
            s = (self.noise * 2) as i16 as i32;
        }
        let out = ((s * v.env) >> 11) & !1;
        self.regs[base + ENVX] = (v.env >> 4) as u8;
        self.regs[base + OUTX] = (out >> 8) as u8;

        // Soft reset, or a block that ends without looping: immediate silence.
        if self.regs[FLG] & 0x80 != 0 || header & 3 == 1 {
            v.mode = RELEASE;
            v.env = 0;
        }
        if koff & bit != 0 {
            v.mode = RELEASE;
        }
        if kon & bit != 0 {
            v.kon_delay = 5;
            v.mode = ATTACK;
        }
        if v.kon_delay == 0 {
            self.run_envelope(&mut v, base);
        }

        if v.interp_pos >= 0x4000 {
            decode4(&mut v, aram, header);
            v.brr_offset += 2;
            if v.brr_offset >= 9 {
                v.brr_addr = v.brr_addr.wrapping_add(9);
                if header & 1 != 0 {
                    v.brr_addr = next_addr;
                    self.regs[ENDX] |= bit;
                }
                v.brr_offset = 1;
            }
        }
        if v.kon_delay == 5 {
            self.regs[ENDX] &= !bit;
        }
        v.interp_pos = ((v.interp_pos & 0x3FFF) as i32 + pitch).min(0x7FFF) as u16;
        self.voices[i] = v;
        out
    }

    fn run_envelope(&self, v: &mut Voice, base: usize) {
        let mut env = v.env;
        if v.mode == RELEASE {
            v.env = (env - 8).max(0);
            return;
        }
        let (adsr1, adsr2, gain) = (
            self.regs[base + ADSR1],
            self.regs[base + ADSR2],
            self.regs[base + GAIN],
        );
        let (data, rate);
        if adsr1 & 0x80 != 0 {
            data = adsr2;
            if v.mode == ATTACK {
                rate = (adsr1 & 0x0F) * 2 + 1;
                env += if rate < 31 { 0x20 } else { 0x400 };
            } else {
                env -= 1;
                env -= env >> 8;
                rate = if v.mode == DECAY {
                    (adsr1 >> 3 & 0x0E) + 0x10
                } else {
                    adsr2 & 0x1F
                };
            }
        } else {
            data = gain;
            if gain & 0x80 == 0 {
                env = gain as i32 * 0x10; // direct
                rate = 31;
            } else {
                rate = gain & 0x1F;
                match gain >> 5 {
                    4 => env -= 0x20, // linear decrease
                    5 => {
                        env -= 1; // exponential decrease
                        env -= env >> 8;
                    }
                    // Linear increase; the bent line slows to +8 from $600.
                    mode => {
                        env += if mode == 7 && v.hidden_env as u32 >= 0x600 {
                            8
                        } else {
                            0x20
                        }
                    }
                }
            }
        }
        if env >> 8 == (data >> 5) as i32 && v.mode == DECAY {
            v.mode = SUSTAIN;
        }
        v.hidden_env = env;
        if !(0..=0x7FF).contains(&env) {
            env = env.clamp(0, 0x7FF);
            if v.mode == ATTACK {
                v.mode = DECAY;
            }
        }
        if self.fires(rate) {
            v.env = env;
        }
    }
}

/// Four-tap Gaussian interpolation over the ring at the voice's position.
fn interpolate(v: &Voice) -> i32 {
    let g = gauss();
    let off = (v.interp_pos >> 4 & 0xFF) as usize;
    let idx = v.buf_pos as usize + (v.interp_pos >> 12) as usize;
    let s = |j: usize| v.buf[(idx + j) % 12] as i32;
    let out =
        (g[255 - off] * s(0) >> 11) + (g[511 - off] * s(1) >> 11) + (g[256 + off] * s(2) >> 11);
    let out = out as i16 as i32 + (g[off] * s(3) >> 11);
    out.clamp(-0x8000, 0x7FFF) & !1
}

/// Decodes the next 4 samples of the voice's current block into its ring.
fn decode4(v: &mut Voice, aram: &[u8; 0x10000], header: u8) {
    for i in 0..4u16 {
        let byte = aram[v.brr_addr.wrapping_add(v.brr_offset as u16 + i / 2) as usize];
        let nibble = if i % 2 == 0 { byte >> 4 } else { byte & 0x0F };
        let p = v.buf_pos as usize;
        v.buf[p] = brr_sample(header, nibble, v.buf[(p + 11) % 12], v.buf[(p + 10) % 12]);
        v.buf_pos = ((p + 1) % 12) as u8;
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
