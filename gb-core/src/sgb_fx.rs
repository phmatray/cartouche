//! Super Game Boy built-in sound effects (the `SOUND` command's effect A and B tables), as
//! clean-room approximations for games that ask for them without uploading a sound program.
//!
//! Licensing: every recipe below was written for Cartouche from the effect's public name and
//! recommended pitch in Pan Docs' "SGB Sound Effect A/B Tables" only, and the waveforms are
//! generated in code (square, saw, pseudo-random noise). No recordings, no samples, nothing read
//! from or derived from the SGB BIOS or its sound driver. They are not the original sounds.

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
        Wave::Square => (0..16).map(|i| if i < 8 { 7 } else { 8 }).collect(),
        Wave::Saw => (0..16).map(|i| (i as u8 + 8) & 0xF).collect(),
        Wave::Noise => {
            let mut x: u16 = 0xACE1;
            (0..128 * 16).map(|_| {
                x ^= x << 7;
                x ^= x >> 9;
                x ^= x << 8;
                (x >> 12) as u8
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
