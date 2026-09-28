//! Super Game Boy built-in sound effects (the `SOUND` command's effect A and B tables), as
//! clean-room approximations for games that ask for them without uploading a sound program.
//!
//! Licensing: every recipe below was written for Cartouche from the effect's public name and
//! recommended pitch in Pan Docs' "SGB Sound Effect A/B Tables" only, and the waveforms are
//! generated in code (square, saw, pseudo-random noise). No recordings, no samples, nothing read
//! from or derived from the SGB BIOS or its sound driver. They are not the original sounds.

use crate::sdsp::Sdsp;

/// The two effect tables of the `SOUND` command: A (decrescendo, one-shot) and B (sustained, loops
/// until stopped).
#[derive(Clone, Copy, PartialEq, Eq, Debug)]
pub enum Table { A, B }

/// The generated waveforms, one BRR sample each.
#[derive(Clone, Copy, PartialEq, Eq, Debug)]
pub enum Wave { Square, Saw, Noise }

/// One effect: a pitch sweep on one waveform. Pitches are S-DSP pitch values at the recommended
/// pitch attribute (`$1000` plays a sample at 32 kHz; the square and saw repeat every 16 samples,
/// so `$1000` is a 2 kHz tone). `ms` is the length of an A effect (its volume falls to 0 over it)
/// or the period a B effect's sweep repeats with. `steps` > 1 plays the sweep as that many notes.
#[derive(Clone, Copy, PartialEq, Eq, Debug)]
pub struct Recipe {
    pub wave: Wave,
    /// Pan Docs' recommended pitch attribute (0-3): the one the pitches below are written for.
    pub rec: u8,
    pub from: u16,
    pub to: u16,
    pub ms: u16,
    pub steps: u8,
}

use Wave::{Noise as N, Saw as W, Square as S};

const fn r(wave: Wave, rec: u8, from: u16, to: u16, ms: u16, steps: u8) -> Recipe {
    Recipe { wave, rec, from, to, ms, steps }
}

/// Effect A, ids `$01-$30`.
const TABLE_A: [Recipe; 0x30] = [
    r(S, 3, 0x1000, 0x2000, 600, 2),  // 01 Nintendo
    r(S, 3, 0x0C00, 0x0600, 1200, 4), // 02 Game Over
    r(S, 3, 0x1400, 0x0400, 300, 0),  // 03 Drop
    r(S, 3, 0x0C00, 0x1200, 250, 2),  // 04 OK A
    r(S, 3, 0x1000, 0x1800, 250, 2),  // 05 OK B
    r(S, 3, 0x1400, 0x1400, 80, 0),   // 06 Select A
    r(S, 3, 0x1800, 0x1800, 60, 0),   // 07 Select B
    r(S, 2, 0x0E00, 0x1200, 100, 2),  // 08 Select C
    r(W, 2, 0x0300, 0x0300, 400, 0),  // 09 Mistake, buzzer
    r(S, 2, 0x0C00, 0x2400, 300, 4),  // 0A Catch item
    r(W, 2, 0x0900, 0x0B00, 500, 0),  // 0B Gate squeaks once
    r(N, 1, 0x0C00, 0x0400, 400, 0),  // 0C Explosion, small
    r(N, 1, 0x0900, 0x0200, 700, 0),  // 0D Explosion, medium
    r(N, 1, 0x0700, 0x0100, 1200, 0), // 0E Explosion, large
    r(W, 3, 0x0800, 0x0300, 200, 0),  // 0F Attacked A
    r(N, 3, 0x1000, 0x0600, 250, 0),  // 10 Attacked B
    r(N, 0, 0x0800, 0x0400, 120, 0),  // 11 Hit (punch) A
    r(N, 0, 0x0600, 0x0300, 150, 0),  // 12 Hit (punch) B
    r(N, 3, 0x0400, 0x0C00, 600, 0),  // 13 Breath in air
    r(N, 3, 0x0600, 0x1200, 500, 0),  // 14 Rocket projectile A
    r(W, 3, 0x0400, 0x1000, 500, 0),  // 15 Rocket projectile B
    r(S, 2, 0x0600, 0x1400, 150, 0),  // 16 Escaping bubble
    r(S, 3, 0x0800, 0x1400, 200, 0),  // 17 Jump
    r(S, 3, 0x0A00, 0x1C00, 120, 0),  // 18 Fast jump
    r(N, 0, 0x0200, 0x1000, 1500, 0), // 19 Jet (rocket) takeoff
    r(N, 0, 0x1000, 0x0200, 1500, 0), // 1A Jet (rocket) landing
    r(N, 2, 0x2000, 0x1000, 300, 0),  // 1B Cup breaking
    r(N, 1, 0x3000, 0x1800, 500, 0),  // 1C Glass breaking
    r(S, 2, 0x0C00, 0x1800, 600, 4),  // 1D Level up
    r(N, 1, 0x0800, 0x0800, 300, 0),  // 1E Insert air
    r(N, 1, 0x0600, 0x1800, 150, 0),  // 1F Sword swing
    r(N, 2, 0x1800, 0x0800, 800, 0),  // 20 Water falling
    r(N, 1, 0x0500, 0x0700, 600, 0),  // 21 Fire
    r(N, 1, 0x0400, 0x0100, 1500, 0), // 22 Wall collapsing
    r(S, 1, 0x1200, 0x0C00, 150, 2),  // 23 Cancel
    r(N, 1, 0x0A00, 0x0A00, 80, 0),   // 24 Walking
    r(W, 1, 0x1400, 0x0A00, 150, 0),  // 25 Blocking strike
    r(S, 3, 0x0800, 0x1800, 800, 0),  // 26 Picture floats on and off
    r(W, 0, 0x0600, 0x0C00, 1000, 0), // 27 Fade in
    r(W, 0, 0x0C00, 0x0600, 1000, 0), // 28 Fade out
    r(S, 1, 0x0800, 0x1000, 250, 0),  // 29 Window being opened
    r(S, 0, 0x1000, 0x0800, 250, 0),  // 2A Window being closed
    r(W, 3, 0x2000, 0x0400, 800, 0),  // 2B Big laser
    r(N, 0, 0x0300, 0x0200, 1200, 0), // 2C Stone gate closes/opens
    r(S, 3, 0x0800, 0x2800, 700, 8),  // 2D Teleportation
    r(N, 0, 0x2000, 0x0400, 900, 0),  // 2E Lightning
    r(N, 0, 0x0200, 0x0100, 1500, 0), // 2F Earthquake
    r(W, 2, 0x1800, 0x0600, 300, 0),  // 30 Small laser
];

/// Effect B, ids `$01-$19`.
const TABLE_B: [Recipe; 0x19] = [
    r(N, 2, 0x1800, 0x1400, 200, 0),  // 01 Applause, small group
    r(N, 2, 0x1600, 0x1200, 200, 0),  // 02 Applause, medium group
    r(N, 2, 0x1400, 0x1000, 200, 0),  // 03 Applause, large group
    r(N, 1, 0x0400, 0x0800, 2000, 0), // 04 Wind
    r(N, 1, 0x2000, 0x2000, 1000, 0), // 05 Rain
    r(N, 1, 0x0600, 0x0A00, 1500, 0), // 06 Storm
    r(N, 2, 0x0200, 0x0A00, 3000, 0), // 07 Storm with wind and thunder
    r(N, 0, 0x2000, 0x0400, 800, 0),  // 08 Lightning
    r(N, 0, 0x0200, 0x0100, 1000, 0), // 09 Earthquake
    r(N, 0, 0x0400, 0x0200, 1000, 0), // 0A Avalanche
    r(N, 0, 0x0400, 0x0C00, 3000, 0), // 0B Wave
    r(N, 3, 0x1000, 0x1400, 1000, 0), // 0C River
    r(N, 2, 0x0C00, 0x0C00, 1000, 0), // 0D Waterfall
    r(N, 3, 0x1000, 0x0600, 150, 0),  // 0E Small character running
    r(W, 3, 0x0300, 0x0400, 250, 2),  // 0F Horse running
    r(S, 1, 0x1000, 0x1400, 500, 2),  // 10 Warning sound
    r(W, 0, 0x0200, 0x0400, 3000, 0), // 11 Approaching car
    r(N, 1, 0x0800, 0x0900, 1000, 0), // 12 Jet flying
    r(S, 2, 0x0C00, 0x1000, 300, 0),  // 13 UFO flying
    r(W, 0, 0x0800, 0x0C00, 100, 0),  // 14 Electromagnetic waves
    r(S, 3, 0x1000, 0x1800, 100, 4),  // 15 Score up
    r(N, 2, 0x0500, 0x0700, 600, 0),  // 16 Fire
    r(N, 3, 0x2000, 0x1000, 100, 0),  // 17 Camera shutter
    r(N, 0, 0x1800, 0x1800, 200, 0),  // 18 Write
    r(S, 0, 0x0800, 0x1000, 1000, 4), // 19 Show up title
];

/// The recipe of effect `id` of `table`; `None` for `$00` (no change), `$80` (stop) and ids past
/// the table.
pub fn recipe(table: Table, id: u8) -> Option<Recipe> {
    let t: &[Recipe] = match table { Table::A => &TABLE_A, Table::B => &TABLE_B };
    t.get((id as usize).wrapping_sub(1)).copied()
}

/// A generated BRR sample that loops over its whole length: one 16-sample period for the square and
/// the saw, 128 blocks of pseudo-random nibbles for the noise. Shift 12, filter 0.
pub fn waveform_brr(kind: Wave) -> Vec<u8> {
    let nibbles: Vec<u8> = match kind {
        Wave::Square => (0..16).map(|i| if i < 8 { 7 } else { 9 }).collect(), // +7 / -7
        Wave::Saw => (1..16).chain([8]).map(|i| (i as u8 + 8) & 0xF).collect(), // -7..=7, then 0: no DC
        Wave::Noise => {
            let mut x: u16 = 0xACE1;
            (0..128 * 16).map(|_| {
                x ^= x << 7;
                x ^= x >> 9;
                x ^= x << 8;
                // -7..=7: no DC, which the output capacitor would let out as a thump at the stop.
                ((x % 15) as i8 - 7) as u8 & 0xF
            }).collect()
        }
    };
    let blocks = nibbles.len() / 16;
    let mut out = Vec::with_capacity(blocks * 9);
    for (b, n) in nibbles.chunks(16).enumerate() {
        out.push(if b + 1 == blocks { 0xC3 } else { 0xC0 }); // the last block ends and loops
        out.extend(n.chunks(2).map(|p| p[0] << 4 | p[1]));
    }
    out
}

/// Where the player keeps its waveforms in audio RAM (Pan Docs' sampling data area): the sample
/// directory at `$E000` (entry = `Wave` as u8), the waveforms from `$E100`. Written only once the
/// player owns the DSP, i.e. while no uploaded program runs.
const DIR_PAGE: u8 = 0xE0;
const WAVES: u16 = 0xE100;
/// Effect A plays on voice 7, B on voice 5: the upper channel of each effect's channels in Pan
/// Docs (A 6-7, B 0/1/4/5), which is where a one-channel effect goes.
// ponytail: one voice per effect, the tables' channel counts not modelled; a second voice per
// effect (a detuned or lower copy) if an approximation ever sounds too thin.
const VOICE_A: usize = 7;
const VOICE_B: usize = 5;
/// Pitch factors (×1024) for the pitch attribute minus the recommended one, -3..=3: half an octave
/// a step.
const PITCH_STEP: [u32; 7] = [362, 512, 724, 1024, 1448, 2048, 2896];
/// Voice volume for the volume attribute (0 high .. 2 low, 3 mute).
const VOLUME: [u8; 4] = [0x7F, 0x50, 0x28, 0];

#[derive(Clone, Copy)]
struct Playing {
    /// The `SOUND` effect id and its 4-bit attribute (pitch in bits 0-1, volume in 2-3).
    id: u8,
    attr: u8,
    r: Recipe,
    voice: usize,
    sustain: bool,
    /// Pitch factor ×1024 and voice volume, from the attributes.
    pitch: u32,
    vol: u8,
    /// Milliseconds played; 0 = not keyed on yet.
    ms: u32,
}

impl Playing {
    /// This millisecond's pitch and volume; `None` once a one-shot effect is over.
    fn at(&self) -> Option<(u16, u8)> {
        let len = self.r.ms.max(1) as u32;
        if !self.sustain && self.ms >= len { return None; }
        let pos = self.ms % len;
        let n = self.r.steps as u32;
        let (num, den) = if n > 1 { (pos * n / len, n - 1) } else { (pos, len) };
        let (from, to) = (self.r.from as i64, self.r.to as i64);
        let p = from + (to - from) * num as i64 / den as i64;
        let pitch = ((p as u64 * self.pitch as u64) >> 10).min(0x3FFF) as u16;
        let vol = if self.sustain { self.vol } else { (self.vol as u32 * (len - self.ms) / len) as u8 };
        Some((pitch, vol))
    }
}

/// Effect `id` of `table` at attribute `attr`, `ms` milliseconds in; `None` if `id` has no recipe.
fn start(table: Table, id: u8, attr: u8, ms: u32) -> Option<Playing> {
    let r = recipe(table, id)?;
    let (pitch, vol) = (PITCH_STEP[(attr & 3) as usize + 3 - r.rec as usize], VOLUME[(attr >> 2 & 3) as usize]);
    let voice = match table { Table::A => VOICE_A, Table::B => VOICE_B };
    Some(Playing { id, attr, r, voice, sustain: table == Table::B, pitch, vol, ms })
}

/// Plays the built-in effects on the S-DSP while no uploaded program owns it: `command` takes the
/// `SOUND` bytes, `tick` (1 kHz of emulated time) writes the DSP's registers.
#[derive(Clone, Default)]
pub struct FxPlayer {
    a: Option<Playing>,
    b: Option<Playing>,
    /// Voices to key off at the next tick.
    off: u8,
    /// The DSP was reset and the waveforms are in audio RAM.
    ready: bool,
}

impl FxPlayer {
    /// Nothing playing and nothing left to stop.
    pub fn idle(&self) -> bool { self.a.is_none() && self.b.is_none() && self.off == 0 }

    /// A single 0 while no effect plays, else 1, then for effect A and B: 0 (none), or 1, the id,
    /// the attribute and the milliseconds played (u32 LE). The DSP is not saved (see `import_state`).
    pub fn export_state(&self, out: &mut Vec<u8>) {
        if self.a.is_none() && self.b.is_none() {
            out.push(0);
            return;
        }
        out.push(1);
        for slot in [&self.a, &self.b] {
            match slot {
                None => out.push(0),
                Some(p) => {
                    out.extend_from_slice(&[1, p.id, p.attr]);
                    out.extend_from_slice(&p.ms.to_le_bytes());
                }
            }
        }
    }

    /// Reads what `export_state` wrote at `*pos`; truncated data is rejected. The effects restart
    /// from a reset DSP at their saved millisecond (a click at the load point, for approximations).
    /// An id without a recipe is dropped; a one-shot effect's position is clamped to its length.
    pub fn import_state(&mut self, data: &[u8], pos: &mut usize) -> bool {
        let mut fx = FxPlayer::default();
        match data.get(*pos) {
            Some(0) => *pos += 1,
            Some(_) => {
                *pos += 1;
                for table in [Table::A, Table::B] {
                    let Some(&present) = data.get(*pos) else { return false };
                    *pos += 1;
                    if present == 0 { continue; }
                    let Some(&[id, attr, m0, m1, m2, m3]) = data.get(*pos..*pos + 6) else { return false };
                    *pos += 6;
                    let ms = u32::from_le_bytes([m0, m1, m2, m3]);
                    let ms = if table == Table::A { recipe(table, id).map_or(0, |r| ms.min(r.ms as u32)) } else { ms };
                    let slot = match table { Table::A => &mut fx.a, Table::B => &mut fx.b };
                    *slot = start(table, id, attr & 0xF, ms);
                }
            }
            None => return false,
        }
        *self = fx;
        true
    }

    /// `SOUND`'s effect A, effect B and attribute bytes: `$00` changes nothing, `$80` stops the
    /// effect, an id of the table (re)starts it at the attributes' pitch and volume.
    pub fn command(&mut self, a: u8, b: u8, attrs: u8) {
        for (table, id, attr) in [(Table::A, a, attrs & 0xF), (Table::B, b, attrs >> 4)] {
            let slot = match table { Table::A => &mut self.a, Table::B => &mut self.b };
            if id == 0x80 {
                if let Some(p) = slot.take() { self.off |= 1 << p.voice; }
            } else if let Some(p) = start(table, id, attr, 0) {
                *slot = Some(p);
            }
        }
    }

    /// One millisecond: keys effects on, moves their pitch and volume, keys finished ones off.
    pub fn tick(&mut self, dsp: &mut Sdsp, aram: &mut [u8; 0x10000]) {
        let fresh = !self.ready;
        if fresh {
            // Whatever a stopped program left in the DSP must not play along.
            self.ready = true;
            *dsp = Sdsp::new();
            let mut at = WAVES as usize;
            for (i, w) in [Wave::Square, Wave::Saw, Wave::Noise].into_iter().enumerate() {
                let entry = DIR_PAGE as usize * 0x100 + i * 4;
                let [lo, hi] = (at as u16).to_le_bytes();
                aram[entry..entry + 4].copy_from_slice(&[lo, hi, lo, hi]);
                let brr = waveform_brr(w);
                aram[at..at + brr.len()].copy_from_slice(&brr);
                at += brr.len();
            }
            // FLG: unmuted, echo writes off; DIR; main volume. Echo stays off (EON, EVOL at 0).
            for (reg, v) in [(0x6C, 0x20), (0x5D, DIR_PAGE), (0x0C, 0x7F), (0x1C, 0x7F)] { dsp.write_reg(reg, v); }
        }
        let mut kon = 0u8;
        for slot in [&mut self.a, &mut self.b] {
            let Some(p) = slot else { continue };
            let base = (p.voice * 0x10) as u8;
            match p.at() {
                Some((pitch, vol)) => {
                    // Keyed on at the start, or again after a load reset the DSP.
                    if p.ms == 0 || fresh {
                        // Source, ADSR off, direct GAIN at full; keyed on below.
                        for (reg, v) in [(4, p.r.wave as u8), (5, 0), (7, 0x7F)] { dsp.write_reg(base + reg, v); }
                        kon |= 1 << p.voice;
                    }
                    for (reg, v) in [(0, vol), (1, vol), (2, pitch as u8), (3, (pitch >> 8) as u8)] { dsp.write_reg(base + reg, v); }
                    p.ms += 1;
                }
                None => {
                    self.off |= 1 << p.voice;
                    *slot = None;
                }
            }
        }
        // Stopped voices: silent at once (volume 0), then released.
        let off = std::mem::take(&mut self.off);
        for v in (0..8).filter(|v| off & 1 << v != 0) {
            dsp.write_reg(v * 0x10, 0);
            dsp.write_reg(v * 0x10 + 1, 0);
        }
        let kof = (dsp.read_reg(0x5C) | off) & !kon;
        dsp.write_reg(0x5C, kof);
        if kon != 0 { dsp.write_reg(0x4C, kon); }
    }
}
