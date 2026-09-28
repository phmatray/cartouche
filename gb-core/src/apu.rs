// =============================================================================
// Game Boy APU (Audio Processing Unit)
// =============================================================================
//
// 4 channels: CH1 (square+sweep), CH2 (square), CH3 (wave), CH4 (noise)
// Clocked at 2 MHz (`step` takes 2 MHz ticks: two per M-cycle, one in double speed). The frame
// sequencer is the DIV-APU event: the falling edge of DIV bit 4 (bit 5 in double speed), which the
// bus reports through `div_event`, as on hardware (so a DIV write clocks it too).
// Output mixed to stereo at 44100 Hz

const CPU_CLOCK: u32 = 4_194_304;
const SAMPLE_RATE: u32 = 44_100;
const CYCLES_PER_SAMPLE: f64 = CPU_CLOCK as f64 / SAMPLE_RATE as f64;
pub const AUDIO_BUFFER_SIZE: usize = 4096;
/// The output capacitor's charge kept per sample: 0.999958 per T-cycle, as on a DMG (SameBoy),
/// over the ~95 T-cycles of a 44.1 kHz sample. A high-pass around 28 Hz.
const HIGHPASS_CHARGE: f32 = 0.996;

/// Extra T-cycles before CH3 fetches its first sample after a trigger.
const WAVE_TRIGGER_DELAY: i32 = 6;
/// DMG: wave RAM is only reachable while CH3 plays when the CPU access lands on the
/// cycle CH3 fetches a byte; this is how many T-cycles ago that fetch must have been.
const WAVE_ACCESS_WINDOW: u32 = 0;
/// DMG: retriggering CH3 this many T-cycles before its next fetch corrupts wave RAM.
const WAVE_CORRUPT_TIMER: i32 = 2;

const DUTY_TABLE: [[u8; 8]; 4] = [
    [0, 0, 0, 0, 0, 0, 0, 1],
    [1, 0, 0, 0, 0, 0, 0, 1],
    [1, 0, 0, 0, 0, 1, 1, 1],
    [0, 1, 1, 1, 1, 1, 1, 0],
];

// -----------------------------------------------------------------------------
// Length counter (shared by all channels)
// -----------------------------------------------------------------------------

pub struct Length {
    counter: u16,
    enabled: bool,
    max: u16,
}

impl Length {
    fn new(max: u16) -> Self {
        Self { counter: 0, enabled: false, max }
    }

    fn load(&mut self, value: u8) {
        self.counter = self.max - value as u16;
    }

    fn clock(&mut self, channel_enabled: &mut bool) {
        if self.enabled && self.counter > 0 {
            self.counter -= 1;
            if self.counter == 0 {
                *channel_enabled = false;
            }
        }
    }

    /// NRx4 write. `first_half`: the next frame-sequencer step won't clock length, in
    /// which case enabling length (and a trigger reload) clocks it once more.
    fn write_nrx4(&mut self, value: u8, first_half: bool, channel_enabled: &mut bool) {
        let was_enabled = self.enabled;
        self.enabled = value & 0x40 != 0;
        let trigger = value & 0x80 != 0;
        if first_half && !was_enabled && self.enabled && self.counter != 0 {
            self.counter -= 1;
            if self.counter == 0 && !trigger {
                *channel_enabled = false;
            }
        }
        if trigger && self.counter == 0 {
            self.counter = self.max;
            if self.enabled && first_half {
                self.counter -= 1;
            }
        }
    }

    fn read_bit(&self) -> u8 {
        if self.enabled { 0x40 } else { 0 }
    }
}

// -----------------------------------------------------------------------------
// Envelope clock (CH1, CH2, CH4)
// -----------------------------------------------------------------------------

/// The envelope's clock line. The secondary DIV-APU edge raises it when the envelope's countdown
/// is due, the next DIV-APU event steps the volume and drops it. Reaching 15 going up (0 going
/// down) locks the envelope until the next trigger.
#[derive(Clone, Copy, Default)]
pub struct EnvelopeClock {
    clock: bool,
    locked: bool,
    should_lock: bool,
}

impl EnvelopeClock {
    fn set(&mut self, value: bool, increase: bool, volume: u8) {
        if self.clock == value {
            return;
        }
        self.clock = value;
        if value {
            self.should_lock = (volume == 15 && increase) || (volume == 0 && !increase);
        } else {
            self.locked |= self.should_lock;
        }
    }

    fn bits(&self) -> u8 {
        self.clock as u8 | (self.locked as u8) << 1 | (self.should_lock as u8) << 2
    }

    fn from_bits(b: u8) -> Self {
        Self { clock: b & 1 != 0, locked: b & 2 != 0, should_lock: b & 4 != 0 }
    }
}

/// An NRx2 write while the channel plays ("zombie mode", as measured on a CGB-E; SameBoy's
/// `_nrx2_glitch`): the volume can step, invert or both, depending on the old and new values.
fn nrx2_glitch_step(volume: &mut u8, value: u8, old: u8, countdown: &mut u8, lock: &mut EnvelopeClock) {
    if lock.clock {
        *countdown = value & 7;
    }
    let mut tick = value & 7 != 0 && old & 7 == 0 && !lock.locked;
    if value & 0xF == 8 && old & 0xF == 8 && !lock.locked {
        tick = true;
    }
    if (value ^ old) & 8 != 0 {
        if value & 8 != 0 {
            *volume = if old & 7 == 0 && !lock.locked { *volume ^ 0xF } else { 0xE_u8.wrapping_sub(*volume) & 0xF };
            tick = false;
        } else {
            *volume = 0x10_u8.wrapping_sub(*volume) & 0xF;
        }
    }
    if tick {
        *volume = if value & 8 != 0 { volume.wrapping_add(1) } else { volume.wrapping_sub(1) } & 0xF;
    } else if value & 7 == 0 && lock.clock {
        lock.set(false, false, 0);
    }
}

/// CGB-E applies the new value directly; the DMG (like CGB-C and older) goes through $FF first.
fn nrx2_glitch(cgb: bool, volume: &mut u8, value: u8, old: u8, countdown: &mut u8, lock: &mut EnvelopeClock) {
    if cgb {
        nrx2_glitch_step(volume, value, old, countdown, lock);
    } else {
        nrx2_glitch_step(volume, 0xFF, old, countdown, lock);
        nrx2_glitch_step(volume, value, 0xFF, countdown, lock);
    }
}

// -----------------------------------------------------------------------------
// SquareChannel (used by CH1 and CH2)
// -----------------------------------------------------------------------------

/// A square channel on the 2 MHz APU clock. Its timer counts `(frequency ^ $7FF) * 2 + 1` ticks
/// per duty step, a trigger starts it after a delay (shorter when it already plays), the duty
/// position survives restarts, and `sample` latches what the DAC (and PCM12) sees.
pub struct SquareChannel {
    pub enabled: bool,
    pub dac_enabled: bool,
    duty: u8,
    length: Length,
    /// NRx2 as written: initial volume, direction, period.
    nrx2: u8,
    volume: u8,
    volume_countdown: u8,
    envelope: EnvelopeClock,
    pub frequency: u16,
    countdown: u16,
    /// The start delay the current countdown carries from a trigger, in ticks.
    delay: u16,
    duty_position: u8,
    /// Until the first duty step after starting, the output holds 0.
    suppressed: bool,
    /// The last tick reloaded the countdown: an NRx3/NRx4 write lands on the new period.
    just_reloaded: bool,
    /// A duty step happened since the last trigger.
    did_tick: bool,
    /// The digital output (0-15): what PCM12 reads and the DAC converts.
    sample: u8,
}

impl SquareChannel {
    pub fn new() -> Self {
        Self {
            enabled: false,
            dac_enabled: false,
            duty: 0,
            length: Length::new(64),
            nrx2: 0,
            volume: 0,
            volume_countdown: 0,
            envelope: EnvelopeClock::default(),
            frequency: 0,
            // Power-on: as far from a reload as it gets.
            countdown: 0xFFFF,
            delay: 0,
            duty_position: 0,
            suppressed: false,
            just_reloaded: false,
            did_tick: false,
            sample: 0,
        }
    }

    fn period(&self) -> u16 {
        (self.frequency ^ 0x7FF) * 2
    }

    /// `ticks` 2 MHz ticks.
    pub fn step(&mut self, ticks: u32) {
        if !self.enabled {
            return;
        }
        let mut left = ticks as u16;
        self.delay = self.delay.saturating_sub(left);
        while left > self.countdown {
            left -= self.countdown + 1;
            self.countdown = self.period() + 1;
            self.duty_position = (self.duty_position + 1) & 7;
            self.suppressed = false;
            self.did_tick = true;
            self.update_sample();
        }
        self.just_reloaded = left == 0;
        self.countdown -= left;
    }

    fn update_sample(&mut self) {
        if !self.suppressed {
            self.sample = if DUTY_TABLE[self.duty as usize][self.duty_position as usize] != 0 { self.volume } else { 0 };
        }
    }

    fn silence(&mut self) {
        self.enabled = false;
        self.sample = 0;
    }

    /// The digital output (0-15) while the channel plays.
    fn digital(&self) -> u8 {
        self.sample
    }

    pub fn output(&self) -> f32 {
        if !self.enabled || !self.dac_enabled {
            return 0.0;
        }
        self.sample as f32 / 7.5 - 1.0
    }

    pub fn clock_length(&mut self) {
        self.length.clock(&mut self.enabled);
        if !self.enabled {
            self.sample = 0;
        }
    }

    /// Every 8th DIV-APU event: an envelope whose clock is low counts down.
    fn count_envelope(&mut self) {
        if !self.envelope.clock {
            self.volume_countdown = self.volume_countdown.wrapping_sub(1) & 7;
        }
    }

    /// A DIV-APU event with the envelope's clock high: the volume steps, unless locked.
    fn tick_envelope(&mut self) {
        if !self.envelope.clock {
            return;
        }
        self.envelope.set(false, false, 0);
        if self.envelope.locked || self.nrx2 & 7 == 0 {
            return;
        }
        self.volume = if self.nrx2 & 8 != 0 { self.volume.wrapping_add(1) } else { self.volume.wrapping_sub(1) };
        if self.enabled {
            self.update_sample();
        }
    }

    /// The secondary DIV-APU edge (DIV's APU bit rising): a due envelope reloads its countdown
    /// and raises its clock.
    fn arm_envelope(&mut self) {
        if self.enabled && self.volume_countdown == 0 {
            self.volume_countdown = self.nrx2 & 7;
            self.envelope.set(self.volume_countdown != 0, self.nrx2 & 8 != 0, self.volume);
        }
    }

    // -- Register access --

    pub fn write_nrx1(&mut self, value: u8) {
        self.duty = (value >> 6) & 0x03;
        self.length.load(value & 0x3F);
    }

    fn write_nrx2(&mut self, value: u8, cgb: bool) {
        self.dac_enabled = value & 0xF8 != 0;
        if !self.dac_enabled {
            self.silence();
        } else if self.enabled {
            nrx2_glitch(cgb, &mut self.volume, value, self.nrx2, &mut self.volume_countdown, &mut self.envelope);
            self.update_sample();
        }
        self.nrx2 = value;
    }

    pub fn write_nrx3(&mut self, value: u8) {
        self.frequency = (self.frequency & 0x700) | value as u16;
        if self.just_reloaded {
            self.countdown = self.period() + 1;
        }
    }

    /// `lf_div`: the 1 MHz phase of the 2 MHz clock. `first_half`: the next DIV-APU event won't
    /// clock length.
    fn write_nrx4(&mut self, value: u8, first_half: bool, lf_div: u16, cgb: bool) {
        // The frequency's high bits leaving 7 just as the countdown reloads: the duty step that
        // reload made is taken back (CGB-D/E; elsewhere only on an odd countdown).
        if value & 0x80 == 0 && self.enabled && self.frequency >> 8 == 7 && value & 7 != 7
            && (cgb || self.countdown & 1 != 0)
            && self.did_tick && self.countdown >> 1 == self.frequency ^ 0x7FF
        {
            self.duty_position = self.duty_position.wrapping_sub(1) & 7;
            self.suppressed = false;
        }
        let old_frequency = self.frequency;
        self.frequency = (self.frequency & 0x00FF) | (((value & 0x07) as u16) << 8);
        if self.just_reloaded {
            self.countdown = self.period() + 1;
        }
        if value & 0x80 != 0 {
            self.envelope = EnvelopeClock::default();
            self.did_tick = false;
            // CGB-D/E: starting with NRx4 bit 2 clear while the countdown's bit 10 (in 1 MHz
            // steps) is clear advances the duty position once.
            let steps = |countdown: u16, delay: u16| ((countdown as i32 - delay as i32) / 2) & 0x400 == 0;
            let mut force_unsuppressed = false;
            if !self.enabled {
                if cgb && value & 4 == 0 && steps(self.countdown, self.delay) {
                    self.duty_position = (self.duty_position + 1) & 7;
                    force_unsuppressed = true;
                }
                self.delay = 6 - lf_div;
            } else {
                let mut extra = 0;
                if cgb {
                    if !self.just_reloaded && value & 4 == 0 && steps(self.countdown.wrapping_sub(1), self.delay) {
                        self.duty_position = (self.duty_position + 1) & 7;
                        self.suppressed = false;
                    } else if self.frequency == 0x7FF && old_frequency != 0x7FF && self.suppressed {
                        extra = 2;
                    }
                }
                // Already playing: the sound restarts 2 ticks sooner.
                self.delay = 4 - lf_div + extra;
            }
            self.countdown = self.period() + self.delay;
            self.volume = self.nrx2 >> 4;
            if self.enabled {
                self.update_sample();
            }
            self.volume_countdown = self.nrx2 & 7;
            if self.dac_enabled && !self.enabled {
                self.enabled = true;
                self.sample = 0;
                self.suppressed = !force_unsuppressed;
            }
        }
        self.length.write_nrx4(value, first_half, &mut self.enabled);
        if !self.enabled {
            self.sample = 0;
        }
    }

    pub fn read_nrx1(&self) -> u8 {
        (self.duty << 6) | 0x3F // lower 6 bits write-only
    }

    pub fn read_nrx2(&self) -> u8 {
        self.nrx2
    }

    pub fn read_nrx4(&self) -> u8 {
        self.length.read_bit() | 0xBF // other bits write-only
    }
}

// -----------------------------------------------------------------------------
// Sweep (CH1 only)
// -----------------------------------------------------------------------------

/// CH1's frequency sweep. Every 4th DIV-APU event counts `countdown` (in 128 Hz steps). When it
/// wraps, the frequency takes the last addend, and the next one is computed `NR10 & 7` 1 MHz ticks
/// later, where the overflow check can silence the channel. A restart holds the shadow frequency
/// for a few ticks. Times are SameBoy's `Core/apu.c` (CGB-E and DMG-B).
pub struct Sweep {
    /// NR10 as written.
    nr10: u8,
    countdown: u8,
    /// 1 MHz ticks until the pending calculation completes (0: none).
    calculate_countdown: u8,
    /// 1 MHz ticks before `calculate_countdown` starts counting.
    reload_timer: u8,
    addend: u16,
    shadow: u16,
    /// The calculation was started with shift 0 (it then runs even with NR10's shift cleared).
    unshifted: bool,
    /// A shift-0 calculation completes as soon as its reload timer runs out.
    instant_done: bool,
    /// 2 MHz ticks after a restart during which the shadow frequency and addend keep their value.
    restart_hold: u8,
    /// The addend of the last completed calculation (an NR10 write checks it).
    completed_addend: u16,
}

impl Sweep {
    pub fn new() -> Self {
        Self {
            nr10: 0,
            countdown: 0,
            calculate_countdown: 0,
            reload_timer: 0,
            addend: 0,
            shadow: 0,
            unshifted: false,
            instant_done: false,
            restart_hold: 0,
            completed_addend: 0,
        }
    }

    fn shift(&self) -> u8 {
        self.nr10 & 7
    }

    fn negate(&self) -> bool {
        self.nr10 & 8 != 0
    }

    /// The overflow check, frequency + addend (APU bug: made with the addend already applied).
    fn calculation_done(&mut self, ch1: &mut SquareChannel) {
        if self.restart_hold == 0 {
            self.shadow = ch1.frequency;
        }
        if self.negate() {
            self.addend ^= 0x7FF;
        }
        if self.shadow + self.addend > 0x7FF && !self.negate() {
            ch1.silence();
        }
        self.completed_addend = self.addend;
    }

    /// The sweep step: the frequency takes the last addend, and the next calculation starts.
    /// `div_write`: this DIV-APU event came from a DIV write (the reload lands a tick sooner).
    fn step(&mut self, ch1: &mut SquareChannel, lf_div: u16, double_speed: bool, div_write: bool) {
        if self.nr10 & 0x70 == 0 || self.countdown != 7 {
            return;
        }
        if self.shift() != 0 {
            ch1.frequency = (self.addend + self.shadow + self.negate() as u16) & 0x7FF;
        }
        if self.restart_hold == 0 {
            self.addend = ch1.frequency >> self.shift();
        }
        self.calculate_countdown = self.shift();
        self.reload_timer = if !double_speed && div_write { 1 } else { 1 + lf_div as u8 };
        self.unshifted = self.shift() == 0;
        self.countdown = ((self.nr10 >> 4) & 7) ^ 7;
        if self.calculate_countdown == 0 {
            self.instant_done = true;
        }
    }

    /// Every 4th DIV-APU event.
    fn div_event(&mut self, ch1: &mut SquareChannel, lf_div: u16, double_speed: bool, div_write: bool) {
        self.countdown = (self.countdown + 1) & 7;
        self.step(ch1, lf_div, double_speed, div_write);
    }

    /// `ticks` 2 MHz ticks, after `lf_div` flipped for them.
    fn tick(&mut self, ch1: &mut SquareChannel, ticks: u32, lf_div: u16) {
        let mut sweep_ticks = (ticks / 2) as u8 + (ticks & 1 != 0 && lf_div == 0) as u8;
        if self.reload_timer > sweep_ticks {
            self.reload_timer -= sweep_ticks;
            sweep_ticks = 0;
        } else {
            if self.reload_timer != 0 && self.calculate_countdown == 0 && self.instant_done {
                self.calculation_done(ch1);
            }
            self.instant_done = false;
            sweep_ticks -= self.reload_timer;
            self.reload_timer = 0;
        }
        // The calculation pauses while NR10's shift is 0 (unless it started that way).
        if self.calculate_countdown != 0 && (self.shift() != 0 || self.unshifted) {
            if self.calculate_countdown > sweep_ticks {
                self.calculate_countdown -= sweep_ticks;
            } else {
                self.calculate_countdown = 0;
                self.calculation_done(ch1);
            }
        }
        self.restart_hold = self.restart_hold.saturating_sub(ticks as u8);
    }

    /// NR10 write. `cgb`: CGB-E, else DMG-B.
    fn write_nr10(&mut self, value: u8, ch1: &mut SquareChannel, lf_div: u16, cgb: bool, double_speed: bool) {
        if self.calculate_countdown != 0 || self.reload_timer != 0 {
            self.write_glitch(value, ch1, lf_div, cgb, double_speed);
        }
        // The DMG (like CGB-C and older) checks as if the old value negated.
        let old_negate = !cgb || self.negate();
        self.nr10 = value;
        if self.shadow + self.completed_addend + old_negate as u16 > 0x7FF && value & 8 == 0 {
            ch1.silence();
        }
        self.step(ch1, lf_div, double_speed, false);
    }

    /// NR10 written while a calculation is pending.
    fn write_glitch(&mut self, value: u8, ch1: &mut SquareChannel, lf_div: u16, cgb: bool, double_speed: bool) {
        if cgb {
            if self.reload_timer == 2 {
                // The countdown just reloaded: it reloads again.
                self.calculate_countdown = value & 7;
                if self.calculate_countdown == 0 {
                    self.reload_timer = 0;
                }
            }
            if value & 7 != 0 && self.shift() == 0 && lf_div == 0 && self.calculate_countdown > 1 {
                self.calculate_countdown -= 1;
                if self.calculate_countdown == 0 {
                    self.calculation_done(ch1);
                }
            }
        } else if (self.reload_timer == 0 || self.reload_timer == 1 && lf_div != 0) && self.calculate_countdown != 0 {
            let zombie_step = if self.shift() == 0 {
                lf_div != 0 && !double_speed || lf_div == 0 && double_speed
            } else {
                double_speed && self.calculate_countdown == 1
            };
            if zombie_step {
                self.calculate_countdown -= 1;
                if self.calculate_countdown <= 1 {
                    self.calculate_countdown = 0;
                    self.calculation_done(ch1);
                }
            }
        }
    }

    /// CH1 triggered; `was_active`: it already played.
    fn trigger(&mut self, ch1: &SquareChannel, was_active: bool, lf_div: u16, cgb: bool) {
        self.instant_done = false;
        self.shadow = 0;
        self.completed_addend = 0;
        if self.shift() != 0 {
            // APU bug: with a shift, the overflow check also runs after a restart.
            self.calculate_countdown = self.shift();
            self.reload_timer = 2 + !was_active as u8;
            self.unshifted = false;
            self.addend = ch1.frequency >> self.shift();
        } else {
            self.addend = 0;
        }
        self.restart_hold = (2 - lf_div + if cgb { 2 } else { 0 }) as u8;
        self.countdown = ((self.nr10 >> 4) & 7) ^ 7;
    }

    fn read_nr10(&self) -> u8 {
        self.nr10 | 0x80
    }
}

// -----------------------------------------------------------------------------
// WaveChannel (CH3)
// -----------------------------------------------------------------------------

pub struct WaveChannel {
    pub enabled: bool,
    pub dac_enabled: bool,
    length: Length,
    volume_shift: u8, // 0=mute, 1=100%, 2=50%, 3=25%
    frequency: u16,
    frequency_timer: i32,
    wave_ram: [u8; 16], // 32 4-bit samples packed
    sample_index: u8,
    /// Byte last fetched from wave RAM (what the DAC is playing).
    sample_byte: u8,
    /// T-cycles since the last wave RAM fetch.
    since_fetch: u32,
}

impl WaveChannel {
    pub fn new() -> Self {
        Self {
            enabled: false,
            dac_enabled: false,
            length: Length::new(256),
            volume_shift: 0,
            frequency: 0,
            frequency_timer: 0,
            wave_ram: [0; 16],
            sample_index: 0,
            sample_byte: 0,
            since_fetch: u32::MAX,
        }
    }

    fn period(&self) -> i32 {
        (2048 - self.frequency as i32) * 2
    }

    pub fn step(&mut self, cycles: u32) {
        // Per T-cycle: wave RAM access while playing depends on the exact fetch cycle.
        for _ in 0..cycles {
            self.since_fetch = self.since_fetch.saturating_add(1);
            if !self.enabled {
                continue;
            }
            self.frequency_timer -= 1;
            if self.frequency_timer <= 0 {
                self.frequency_timer = self.period();
                self.sample_index = (self.sample_index + 1) & 31;
                self.sample_byte = self.wave_ram[(self.sample_index / 2) as usize];
                self.since_fetch = 0;
            }
        }
    }

    /// The digital output (0-15) while the channel plays.
    fn digital(&self) -> u8 {
        let sample = if self.sample_index & 1 == 0 {
            self.sample_byte >> 4
        } else {
            self.sample_byte & 0x0F
        };
        match self.volume_shift {
            1 => sample,
            2 => sample >> 1,
            3 => sample >> 2,
            _ => 0,
        }
    }

    pub fn output(&self) -> f32 {
        if !self.enabled || !self.dac_enabled {
            return 0.0;
        }
        self.digital() as f32 / 7.5 - 1.0
    }

    pub fn clock_length(&mut self) {
        self.length.clock(&mut self.enabled);
    }

    fn trigger(&mut self, cgb: bool) {
        // DMG: retriggering right before a fetch corrupts the first bytes of wave RAM.
        if !cgb && self.enabled && self.frequency_timer == WAVE_CORRUPT_TIMER {
            let pos = ((self.sample_index + 1) & 31) as usize / 2;
            if pos < 4 {
                self.wave_ram[0] = self.wave_ram[pos];
            } else {
                let start = pos & !3;
                self.wave_ram.copy_within(start..start + 4, 0);
            }
        }
        self.enabled = self.dac_enabled;
        self.frequency_timer = self.period() + WAVE_TRIGGER_DELAY;
        self.sample_index = 0;
    }

    // -- Register access (NR30-NR34) --

    pub fn write_nr30(&mut self, value: u8) {
        self.dac_enabled = value & 0x80 != 0;
        if !self.dac_enabled {
            self.enabled = false;
        }
    }

    pub fn write_nr31(&mut self, value: u8) {
        self.length.load(value);
    }

    pub fn write_nr32(&mut self, value: u8) {
        self.volume_shift = (value >> 5) & 0x03;
    }

    pub fn write_nr33(&mut self, value: u8) {
        self.frequency = (self.frequency & 0x700) | value as u16;
    }

    pub fn write_nr34(&mut self, value: u8, first_half: bool, cgb: bool) {
        self.frequency = (self.frequency & 0x00FF) | (((value & 0x07) as u16) << 8);
        self.length.write_nrx4(value, first_half, &mut self.enabled);
        if value & 0x80 != 0 {
            self.trigger(cgb);
        }
    }

    pub fn read_nr30(&self) -> u8 {
        (if self.dac_enabled { 0x80 } else { 0 }) | 0x7F
    }

    pub fn read_nr32(&self) -> u8 {
        (self.volume_shift << 5) | 0x9F
    }

    pub fn read_nr34(&self) -> u8 {
        self.length.read_bit() | 0xBF
    }

    /// While playing, wave RAM accesses hit the byte CH3 is on (CGB), or only succeed
    /// on the fetch cycle (DMG). Returns None when the access is blocked.
    fn wave_ram_index(&self, offset: u16, cgb: bool) -> Option<usize> {
        if !self.enabled {
            Some(offset as usize & 0x0F)
        } else if cgb || self.since_fetch == WAVE_ACCESS_WINDOW {
            Some((self.sample_index / 2) as usize)
        } else {
            None
        }
    }

    pub fn read_wave_ram(&self, offset: u16, cgb: bool) -> u8 {
        self.wave_ram_index(offset, cgb).map_or(0xFF, |i| self.wave_ram[i])
    }

    pub fn write_wave_ram(&mut self, offset: u16, value: u8, cgb: bool) {
        if let Some(i) = self.wave_ram_index(offset, cgb) {
            self.wave_ram[i] = value;
        }
    }
}

// -----------------------------------------------------------------------------
// NoiseChannel (CH4)
// -----------------------------------------------------------------------------

pub struct NoiseChannel {
    pub enabled: bool,
    pub dac_enabled: bool,
    length: Length,
    volume: u8,
    volume_init: u8,
    envelope_direction: bool,
    envelope_period: u8,
    envelope_timer: u8,
    clock_shift: u8,
    width_mode: bool,
    divisor_code: u8,
    frequency_timer: i32,
    lfsr: u16,
}

impl NoiseChannel {
    pub fn new() -> Self {
        Self {
            enabled: false,
            dac_enabled: false,
            length: Length::new(64),
            volume: 0,
            volume_init: 0,
            envelope_direction: false,
            envelope_period: 0,
            envelope_timer: 0,
            clock_shift: 0,
            width_mode: false,
            divisor_code: 0,
            frequency_timer: 0,
            lfsr: 0x7FFF,
        }
    }

    fn divisor(&self) -> i32 {
        let base = if self.divisor_code == 0 {
            8
        } else {
            self.divisor_code as i32 * 16
        };
        base << self.clock_shift
    }

    pub fn step(&mut self, cycles: u32) {
        if !self.enabled { return; }
        self.frequency_timer -= cycles as i32;
        while self.frequency_timer <= 0 {
            self.frequency_timer += self.divisor().max(1);
            // Clock the LFSR
            let xor_bit = (self.lfsr & 0x01) ^ ((self.lfsr >> 1) & 0x01);
            self.lfsr >>= 1;
            self.lfsr |= xor_bit << 14;
            if self.width_mode {
                self.lfsr = (self.lfsr & !(1 << 6)) | (xor_bit << 6);
            }
        }
    }

    /// The digital output (0-15) while the channel plays.
    fn digital(&self) -> u8 {
        if self.lfsr & 0x01 == 0 { self.volume } else { 0 }
    }

    pub fn output(&self) -> f32 {
        if !self.enabled || !self.dac_enabled {
            return 0.0;
        }
        self.digital() as f32 / 7.5 - 1.0
    }

    pub fn clock_length(&mut self) {
        self.length.clock(&mut self.enabled);
    }

    pub fn clock_envelope(&mut self) {
        if self.envelope_period == 0 {
            return;
        }
        if self.envelope_timer > 0 {
            self.envelope_timer -= 1;
        }
        if self.envelope_timer == 0 {
            self.envelope_timer = self.envelope_period;
            if self.envelope_direction && self.volume < 15 {
                self.volume += 1;
            } else if !self.envelope_direction && self.volume > 0 {
                self.volume -= 1;
            }
        }
    }

    fn trigger(&mut self) {
        self.enabled = self.dac_enabled;
        self.frequency_timer = self.divisor();
        self.lfsr = 0x7FFF;
        self.volume = self.volume_init;
        self.envelope_timer = self.envelope_period;
    }

    // -- Register access (NR41-NR44) --

    pub fn write_nr41(&mut self, value: u8) {
        self.length.load(value & 0x3F);
    }

    pub fn write_nr42(&mut self, value: u8) {
        self.volume_init = (value >> 4) & 0x0F;
        self.envelope_direction = value & 0x08 != 0;
        self.envelope_period = value & 0x07;
        self.dac_enabled = value & 0xF8 != 0;
        if !self.dac_enabled {
            self.enabled = false;
        }
    }

    pub fn write_nr43(&mut self, value: u8) {
        self.clock_shift = (value >> 4) & 0x0F;
        self.width_mode = value & 0x08 != 0;
        self.divisor_code = value & 0x07;
    }

    pub fn write_nr44(&mut self, value: u8, first_half: bool) {
        self.length.write_nrx4(value, first_half, &mut self.enabled);
        if value & 0x80 != 0 {
            self.trigger();
        }
    }

    pub fn read_nr41(&self) -> u8 {
        0xFF // write-only
    }

    pub fn read_nr42(&self) -> u8 {
        (self.volume_init << 4)
            | if self.envelope_direction { 0x08 } else { 0 }
            | self.envelope_period
    }

    pub fn read_nr43(&self) -> u8 {
        (self.clock_shift << 4)
            | if self.width_mode { 0x08 } else { 0 }
            | self.divisor_code
    }

    pub fn read_nr44(&self) -> u8 {
        self.length.read_bit() | 0xBF
    }
}

/// A channel's nibble in PCM12/PCM34: its output while it plays, else 0.
fn pcm(playing: bool, sample: u8) -> u8 {
    if playing { sample } else { 0 }
}

// -----------------------------------------------------------------------------
// Apu (main mixer + register dispatch)
// -----------------------------------------------------------------------------

pub struct Apu {
    enabled: bool,
    /// CGB APU quirks (wave RAM access, length counters on power-off). Synced by the bus.
    pub cgb_mode: bool,
    pub ch1: SquareChannel,
    pub ch1_sweep: Sweep,
    pub ch2: SquareChannel,
    pub ch3: WaveChannel,
    pub ch4: NoiseChannel,
    nr50: u8,
    nr51: u8, // panning
    /// NR10-NR51 as last written (a save state's layout-independent part).
    regs: [u8; 0x16],
    /// DIV-APU events counted since power-on: length on odd values, sweep every 4th, envelope every 8th.
    div_divider: u8,
    /// Powering on while the DIV-APU bit is set skips the first event (and starts the count at 1):
    /// 0 no skip, 1 the next event is skipped, 2 it was (the one after doesn't count up).
    skip_div_event: u8,
    /// The 1 MHz phase of the 2 MHz clock (squares and noise run at 1 MHz): 1 from power-on,
    /// flipping on every odd tick, so only in double speed.
    lf_div: u16,
    /// In double speed a CGB-D/E steps the envelopes one M-cycle after the DIV-APU event:
    /// 2 set by the event, 1 on the next M-cycle's ticks, which step them.
    pending_envelope: u8,
    /// The CPU runs in double speed (synced by the bus).
    pub double_speed: bool,
    sample_counter: f64,
    sample_buffer: Vec<f32>,
    pub channel_muted: [bool; 4],
    /// Output capacitor charge (left, right): the DC the high-pass removes. Not in save states:
    /// after a start or a load it charges to the first sample (`charged`), so the output starts
    /// at 0 without a click and a loaded state plays the same sound on every machine.
    capacitor: [f32; 2],
    charged: bool,
    /// Sound from outside the Game Boy (the Super Game Boy's SNES side), added to every sample.
    external: [f32; 2],
}

impl Apu {
    pub fn new() -> Self {
        Self {
            enabled: false,
            cgb_mode: false,
            ch1: SquareChannel::new(),
            ch1_sweep: Sweep::new(),
            ch2: SquareChannel::new(),
            ch3: WaveChannel::new(),
            ch4: NoiseChannel::new(),
            nr50: 0,
            nr51: 0,
            regs: [0; 0x16],
            div_divider: 0,
            skip_div_event: 0,
            lf_div: 1,
            pending_envelope: 0,
            double_speed: false,
            sample_counter: 0.0,
            sample_buffer: Vec::with_capacity(AUDIO_BUFFER_SIZE),
            channel_muted: [false; 4],
            capacitor: [0.0; 2],
            charged: false,
            external: [0.0; 2],
        }
    }

    pub fn set_channel_muted(&mut self, channel: u8, muted: bool) {
        if (channel as usize) < 4 {
            self.channel_muted[channel as usize] = muted;
        }
    }

    /// Runs `ticks` 2 MHz APU ticks (two per M-cycle, one per double-speed M-cycle).
    pub fn step(&mut self, ticks: u32) {
        let cycles = ticks * 2; // in 4 MHz T-cycles of wall-clock time
        if !self.enabled {
            return self.silence(cycles);
        }

        if self.pending_envelope == 1 {
            self.tick_envelopes();
        }
        self.pending_envelope >>= 1;
        self.lf_div ^= (ticks & 1) as u16;
        self.ch1_sweep.tick(&mut self.ch1, ticks, self.lf_div);

        // Tick channels
        self.ch1.step(ticks);
        self.ch2.step(ticks);
        self.ch3.step(cycles);
        self.ch4.step(cycles);

        // Accumulate samples
        self.sample_counter += cycles as f64;
        while self.sample_counter >= CYCLES_PER_SAMPLE {
            self.sample_counter -= CYCLES_PER_SAMPLE;
            self.generate_sample();
        }
    }

    /// Time passes with no sound (APU off, or the CPU in stop mode): silent samples keep the
    /// host's audio buffer in sync.
    pub fn silence(&mut self, cycles: u32) {
        self.sample_counter += cycles as f64;
        while self.sample_counter >= CYCLES_PER_SAMPLE {
            self.sample_counter -= CYCLES_PER_SAMPLE;
            self.push_sample(0.0, 0.0);
        }
    }

    /// The DIV-APU event: the falling edge of DIV bit 4 (bit 5 in double speed), from the timer's
    /// counting or a DIV write.
    pub fn div_event(&mut self, div_write: bool) {
        if !self.enabled {
            return;
        }
        match self.skip_div_event {
            1 => {
                self.skip_div_event = 2;
                return;
            }
            2 => self.skip_div_event = 0,
            _ => self.div_divider = self.div_divider.wrapping_add(1),
        }
        if self.div_divider & 7 == 7 {
            self.ch1.count_envelope();
            self.ch2.count_envelope();
            self.ch4.clock_envelope();
        }
        if self.double_speed && self.cgb_mode {
            self.pending_envelope = 2;
        } else {
            self.tick_envelopes();
        }
        if self.div_divider & 1 == 1 {
            self.clock_length_all();
        }
        if self.div_divider & 3 == 3 {
            self.ch1_sweep.div_event(&mut self.ch1, self.lf_div, self.double_speed, div_write);
        }
    }

    fn tick_envelopes(&mut self) {
        self.ch1.tick_envelope();
        self.ch2.tick_envelope();
    }

    /// DIV's APU bit rising (the secondary DIV-APU edge): due envelopes raise their clock.
    pub fn div_secondary_event(&mut self) {
        if self.enabled {
            self.ch1.arm_envelope();
            self.ch2.arm_envelope();
        }
    }

    /// Powered on with the DIV-APU bit set: the first event is skipped.
    pub fn skip_first_div_event(&mut self) {
        self.skip_div_event = 1;
        self.div_divider = 1;
    }

    pub fn is_on(&self) -> bool {
        self.enabled
    }

    /// True when the next DIV-APU event doesn't clock length counters.
    fn length_first_half(&self) -> bool {
        self.div_divider & 1 == 1
    }

    fn clock_length_all(&mut self) {
        self.ch1.clock_length();
        self.ch2.clock_length();
        self.ch3.clock_length();
        self.ch4.clock_length();
    }

    fn generate_sample(&mut self) {
        if self.sample_buffer.len() >= AUDIO_BUFFER_SIZE {
            return;
        }

        let ch1_out = if self.channel_muted[0] { 0.0 } else { self.ch1.output() };
        let ch2_out = if self.channel_muted[1] { 0.0 } else { self.ch2.output() };
        let ch3_out = if self.channel_muted[2] { 0.0 } else { self.ch3.output() };
        let ch4_out = if self.channel_muted[3] { 0.0 } else { self.ch4.output() };

        let mut left = 0.0f32;
        let mut right = 0.0f32;

        // NR51 panning: bits 7-4 = left, bits 3-0 = right
        if self.nr51 & 0x10 != 0 { left += ch1_out; }
        if self.nr51 & 0x20 != 0 { left += ch2_out; }
        if self.nr51 & 0x40 != 0 { left += ch3_out; }
        if self.nr51 & 0x80 != 0 { left += ch4_out; }

        if self.nr51 & 0x01 != 0 { right += ch1_out; }
        if self.nr51 & 0x02 != 0 { right += ch2_out; }
        if self.nr51 & 0x04 != 0 { right += ch3_out; }
        if self.nr51 & 0x08 != 0 { right += ch4_out; }

        // Apply master volume (NR50 bits 6-4 / 2-0, 0-7 mapped to 1-8; Vin not emulated)
        left *= (((self.nr50 >> 4) & 0x07) as f32 + 1.0) / 8.0;
        right *= ((self.nr50 & 0x07) as f32 + 1.0) / 8.0;

        // Normalize (4 channels)
        left /= 4.0;
        right /= 4.0;

        self.push_sample(left, right);
    }

    /// Through the output capacitor, as on the console: the DACs' DC (an enabled channel at volume 0
    /// sits at -1) is removed, so silence is 0 whether channels are on, off, muted or the APU is
    /// powered down, and switching between them doesn't jump the baseline.
    fn push_sample(&mut self, left: f32, right: f32) {
        if self.sample_buffer.len() >= AUDIO_BUFFER_SIZE {
            return;
        }
        let (left, right) = (left + self.external[0], right + self.external[1]);
        if !self.charged {
            self.capacitor = [left, right];
            self.charged = true;
        }
        for (x, cap) in [left, right].into_iter().zip(&mut self.capacitor) {
            let out = x - *cap;
            *cap = x - out * HIGHPASS_CHARGE;
            self.sample_buffer.push(out);
        }
    }

    /// The level of an outside sound source from now on (`SnesAudio::run`), mixed before the
    /// output capacitor like the Game Boy's own channels. Heard even with the APU powered off.
    pub fn mix_external(&mut self, left: f32, right: f32) {
        self.external = [left, right];
    }

    // -- Buffer access --

    pub fn drain_samples(&self) -> usize {
        self.sample_buffer.len()
    }

    pub fn clear_samples(&mut self) {
        self.sample_buffer.clear();
    }

    pub fn buffer_ptr(&self) -> *const f32 {
        self.sample_buffer.as_ptr()
    }

    pub fn buffer_len(&self) -> usize {
        self.sample_buffer.len()
    }

    // -- Register dispatch --

    /// Registers read back normally while powered off (they are all cleared then).
    pub fn read_register(&self, addr: u16) -> u8 {
        match addr {
            // CH1 — Square with sweep
            0xFF10 => self.ch1_sweep.read_nr10(),
            0xFF11 => self.ch1.read_nrx1(),
            0xFF12 => self.ch1.read_nrx2(),
            0xFF14 => self.ch1.read_nrx4(),

            // CH2 — Square
            0xFF16 => self.ch2.read_nrx1(),
            0xFF17 => self.ch2.read_nrx2(),
            0xFF19 => self.ch2.read_nrx4(),

            // CH3 — Wave
            0xFF1A => self.ch3.read_nr30(),
            0xFF1C => self.ch3.read_nr32(),
            0xFF1E => self.ch3.read_nr34(),

            // CH4 — Noise
            0xFF20 => self.ch4.read_nr41(),
            0xFF21 => self.ch4.read_nr42(),
            0xFF22 => self.ch4.read_nr43(),
            0xFF23 => self.ch4.read_nr44(),

            // Control
            0xFF24 => self.nr50,
            0xFF25 => self.nr51,
            0xFF26 => {
                let mut val = 0x70u8; // bits 4-6 always 1
                if self.enabled { val |= 0x80; }
                if self.ch1.enabled { val |= 0x01; }
                if self.ch2.enabled { val |= 0x02; }
                if self.ch3.enabled { val |= 0x04; }
                if self.ch4.enabled { val |= 0x08; }
                val
            }

            // Wave RAM
            0xFF30..=0xFF3F => self.ch3.read_wave_ram(addr - 0xFF30, self.cgb_mode),

            // PCM12/PCM34 (CGB hardware): each playing channel's digital output, two per byte.
            0xFF76 | 0xFF77 if !self.cgb_mode => 0xFF,
            0xFF76 => pcm(self.ch2.enabled, self.ch2.digital()) << 4 | pcm(self.ch1.enabled, self.ch1.digital()),
            0xFF77 => pcm(self.ch4.enabled, self.ch4.digital()) << 4 | pcm(self.ch3.enabled, self.ch3.digital()),

            // Write-only (NRx3, NR31, NR41...) and unused registers
            _ => 0xFF,
        }
    }

    pub fn write_register(&mut self, addr: u16, value: u8) {
        if !self.enabled {
            match addr {
                0xFF26 if value & 0x80 != 0 => {
                    // Power on: the DIV-APU count restarts (the bus calls `skip_first_div_event`
                    // when DIV's APU bit is set).
                    self.enabled = true;
                    self.div_divider = 0;
                    self.skip_div_event = 0;
                    self.lf_div = 1;
                    self.ch1.countdown = 0xFFFF;
                    self.ch2.countdown = 0xFFFF;
                }
                0xFF30..=0xFF3F => self.ch3.write_wave_ram(addr - 0xFF30, value, self.cgb_mode),
                // DMG only: length counters stay writable while powered off.
                0xFF11 if !self.cgb_mode => self.ch1.length.load(value & 0x3F),
                0xFF16 if !self.cgb_mode => self.ch2.length.load(value & 0x3F),
                0xFF1B if !self.cgb_mode => self.ch3.write_nr31(value),
                0xFF20 if !self.cgb_mode => self.ch4.write_nr41(value),
                _ => {} // other writes are ignored while off
            }
            return;
        }

        if let 0xFF10..=0xFF25 = addr {
            self.regs[(addr - 0xFF10) as usize] = value;
        }
        let first_half = self.length_first_half();
        match addr {
            // CH1 — Square with sweep
            0xFF10 => self.ch1_sweep.write_nr10(value, &mut self.ch1, self.lf_div, self.cgb_mode, self.double_speed),
            0xFF11 => self.ch1.write_nrx1(value),
            0xFF12 => self.ch1.write_nrx2(value, self.cgb_mode),
            0xFF13 => self.ch1.write_nrx3(value),
            0xFF14 => {
                let was_active = self.ch1.enabled;
                self.ch1.write_nrx4(value, first_half, self.lf_div, self.cgb_mode);
                if value & 0x80 != 0 {
                    self.ch1_sweep.trigger(&self.ch1, was_active, self.lf_div, self.cgb_mode);
                }
            }

            // CH2 — Square
            0xFF16 => self.ch2.write_nrx1(value),
            0xFF17 => self.ch2.write_nrx2(value, self.cgb_mode),
            0xFF18 => self.ch2.write_nrx3(value),
            0xFF19 => self.ch2.write_nrx4(value, first_half, self.lf_div, self.cgb_mode),

            // CH3 — Wave
            0xFF1A => self.ch3.write_nr30(value),
            0xFF1B => self.ch3.write_nr31(value),
            0xFF1C => self.ch3.write_nr32(value),
            0xFF1D => self.ch3.write_nr33(value),
            0xFF1E => self.ch3.write_nr34(value, first_half, self.cgb_mode),

            // CH4 — Noise
            0xFF20 => self.ch4.write_nr41(value),
            0xFF21 => self.ch4.write_nr42(value),
            0xFF22 => self.ch4.write_nr43(value),
            0xFF23 => self.ch4.write_nr44(value, first_half),

            // Control
            0xFF24 => self.nr50 = value,
            0xFF25 => self.nr51 = value,
            0xFF26 if value & 0x80 == 0 => self.power_off(),

            // Wave RAM
            0xFF30..=0xFF3F => self.ch3.write_wave_ram(addr - 0xFF30, value, self.cgb_mode),

            _ => {}
        }
    }

    /// Clears every register except wave RAM (and, on DMG, the length counters).
    fn power_off(&mut self) {
        let wave_ram = self.ch3.wave_ram;
        let old = std::mem::replace(self, Apu::new());
        self.cgb_mode = old.cgb_mode;
        self.channel_muted = old.channel_muted;
        self.capacitor = old.capacitor;
        self.charged = old.charged;
        self.sample_counter = old.sample_counter;
        self.sample_buffer = old.sample_buffer;
        self.ch3.wave_ram = wave_ram;
        if !self.cgb_mode {
            self.ch1.length.counter = old.ch1.length.counter;
            self.ch2.length.counter = old.ch2.length.counter;
            self.ch3.length.counter = old.ch3.length.counter;
            self.ch4.length.counter = old.ch4.length.counter;
        }
    }
}

// -----------------------------------------------------------------------------
// Save-state serialization
// -----------------------------------------------------------------------------

/// A plain value stored little-endian in a save state.
trait Field {
    fn put(&self, out: &mut Vec<u8>);
    fn take(&mut self, data: &[u8], pos: &mut usize) -> Option<()>;
}

macro_rules! le_field {
    ($($t:ty),*) => {$(
        impl Field for $t {
            fn put(&self, out: &mut Vec<u8>) { out.extend_from_slice(&self.to_le_bytes()); }
            fn take(&mut self, data: &[u8], pos: &mut usize) -> Option<()> {
                const N: usize = std::mem::size_of::<$t>();
                *self = <$t>::from_le_bytes(data.get(*pos..*pos + N)?.try_into().ok()?);
                *pos += N;
                Some(())
            }
        }
    )*};
}
le_field!(u8, u16, u32, i32, f64);

impl Field for bool {
    fn put(&self, out: &mut Vec<u8>) { out.push(*self as u8); }
    fn take(&mut self, data: &[u8], pos: &mut usize) -> Option<()> {
        *self = *data.get(*pos)? != 0;
        *pos += 1;
        Some(())
    }
}

impl Field for [u8; 16] {
    fn put(&self, out: &mut Vec<u8>) { out.extend_from_slice(self); }
    fn take(&mut self, data: &[u8], pos: &mut usize) -> Option<()> {
        self.copy_from_slice(data.get(*pos..*pos + 16)?);
        *pos += 16;
        Some(())
    }
}

impl Field for EnvelopeClock {
    fn put(&self, out: &mut Vec<u8>) { out.push(self.bits()); }
    fn take(&mut self, data: &[u8], pos: &mut usize) -> Option<()> {
        *self = Self::from_bits(*data.get(*pos)?);
        *pos += 1;
        Some(())
    }
}

/// Every piece of APU state that affects emulation (not the sample buffer or channel mutes),
/// listed once for both export_state and import_state so the two cannot drift apart.
macro_rules! apu_fields {
    ($m:ident, $a:expr) => {
        $m!(
            $a.enabled, $a.nr50, $a.nr51, $a.div_divider, $a.skip_div_event, $a.lf_div,
            $a.pending_envelope, $a.sample_counter,
            $a.ch1_sweep.nr10, $a.ch1_sweep.countdown, $a.ch1_sweep.calculate_countdown,
            $a.ch1_sweep.reload_timer, $a.ch1_sweep.addend, $a.ch1_sweep.shadow, $a.ch1_sweep.unshifted,
            $a.ch1_sweep.instant_done, $a.ch1_sweep.restart_hold, $a.ch1_sweep.completed_addend,
            $a.ch1.enabled, $a.ch1.dac_enabled, $a.ch1.duty, $a.ch1.length.counter,
            $a.ch1.length.enabled, $a.ch1.nrx2, $a.ch1.volume, $a.ch1.volume_countdown,
            $a.ch1.envelope, $a.ch1.frequency, $a.ch1.countdown, $a.ch1.delay,
            $a.ch1.duty_position, $a.ch1.suppressed, $a.ch1.just_reloaded, $a.ch1.did_tick,
            $a.ch1.sample,
            $a.ch2.enabled, $a.ch2.dac_enabled, $a.ch2.duty, $a.ch2.length.counter,
            $a.ch2.length.enabled, $a.ch2.nrx2, $a.ch2.volume, $a.ch2.volume_countdown,
            $a.ch2.envelope, $a.ch2.frequency, $a.ch2.countdown, $a.ch2.delay,
            $a.ch2.duty_position, $a.ch2.suppressed, $a.ch2.just_reloaded, $a.ch2.did_tick,
            $a.ch2.sample,
            $a.ch3.enabled, $a.ch3.dac_enabled, $a.ch3.length.counter, $a.ch3.length.enabled,
            $a.ch3.volume_shift, $a.ch3.frequency, $a.ch3.frequency_timer, $a.ch3.wave_ram,
            $a.ch3.sample_index, $a.ch3.sample_byte, $a.ch3.since_fetch,
            $a.ch4.enabled, $a.ch4.dac_enabled, $a.ch4.length.counter, $a.ch4.length.enabled,
            $a.ch4.volume, $a.ch4.volume_init, $a.ch4.envelope_direction, $a.ch4.envelope_period,
            $a.ch4.envelope_timer, $a.ch4.clock_shift, $a.ch4.width_mode, $a.ch4.divisor_code,
            $a.ch4.frequency_timer, $a.ch4.lfsr
        )
    };
}

/// The layout of the fields after the registers in a v8+ APU block. Bump it when `apu_fields`
/// changes: a block of another layout is restored from its registers instead.
/// 1: #206 (DIV-clocked frame sequencer). 2: #207 (2 MHz square channels). 3: #209 (CH1 sweep).
const STATE_LAYOUT: u8 = 3;
/// NR10-NR51 as last written, then NR52 as read (power and channel flags), then wave RAM.
const STATE_REGS_LEN: usize = 0x16 + 1 + 16;

/// Reads little-endian values in order; `None` once the data runs out.
struct Cursor<'a> {
    data: &'a [u8],
    pos: usize,
}

impl Cursor<'_> {
    fn bytes(&mut self, n: usize) -> Option<&[u8]> {
        let b = self.data.get(self.pos..self.pos + n)?;
        self.pos += n;
        Some(b)
    }
    fn u8(&mut self) -> Option<u8> { Some(self.bytes(1)?[0]) }
    fn u16(&mut self) -> Option<u16> { Some(u16::from_le_bytes(self.bytes(2)?.try_into().ok()?)) }
}

impl Apu {
    /// v8+: u16 LE length, the layout byte, the registers (`STATE_REGS_LEN`), then `apu_fields`.
    pub fn export_state(&self, out: &mut Vec<u8>) {
        let mut block = vec![STATE_LAYOUT];
        block.extend_from_slice(&self.regs);
        block.push(self.read_register(0xFF26));
        block.extend_from_slice(&self.ch3.wave_ram);
        {
            let out = &mut block;
            macro_rules! put { ($($f:expr),*) => { $( $f.put(out); )* }; }
            apu_fields!(put, self);
        }
        out.extend_from_slice(&(block.len() as u16).to_le_bytes());
        out.extend_from_slice(&block);
    }

    /// Reads a `version` save state's APU block at `*pos`. Returns false if `data` ends early.
    pub fn import_state(&mut self, data: &[u8], pos: &mut usize, version: u32) -> bool {
        if version < 8 {
            return self.import_legacy_state(data, pos);
        }
        let Some(&[lo, hi]) = data.get(*pos..*pos + 2) else { return false };
        let len = u16::from_le_bytes([lo, hi]) as usize;
        let Some(block) = data.get(*pos + 2..*pos + 2 + len) else { return false };
        *pos += 2 + len;
        let Some(regs) = block.get(1..1 + STATE_REGS_LEN) else { return false };
        let mut p = 1 + STATE_REGS_LEN;
        let parsed = block[0] == STATE_LAYOUT && {
            let data = block;
            let pos = &mut p;
            (|| {
                macro_rules! take { ($($f:expr),*) => { $( $f.take(data, pos)?; )* }; }
                apu_fields!(take, self);
                Some(())
            })()
            .is_some()
        };
        if parsed {
            self.regs.copy_from_slice(&regs[..0x16]);
            self.after_import();
        } else {
            self.restore_from_registers(regs);
        }
        true
    }

    /// v3-v7 states: the fields of the T-cycle model before v8, turned into registers (plus the
    /// length counters, volumes and the frame sequencer's step, the DIV-APU count now).
    fn import_legacy_state(&mut self, data: &[u8], pos: &mut usize) -> bool {
        let mut c = Cursor { data, pos: *pos };
        let Some((regs, lengths, volumes, step)) = (|| {
            let mut regs = [0u8; STATE_REGS_LEN];
            let power = c.u8()?;
            let (nr50, nr51) = (c.u8()?, c.u8()?);
            c.bytes(4)?; // the 8192-cycle counter: DIV clocks the sequencer now
            let step = c.u8()?;
            c.bytes(8)?; // sample_counter
            let (_, _, period, negate, shift) = (c.u8()?, c.u16()?, c.u8()?, c.u8()?, c.u8()?);
            c.bytes(2)?; // sweep timer, negate used
            regs[0x00] = 0x80 | (period & 7) << 4 | (negate & 1) << 3 | (shift & 7);
            let mut flags = 0;
            let mut lengths = [0u16; 4];
            let mut volumes = [0u8; 3];
            for (i, base) in [(0, 0x01), (1, 0x06)] {
                let (on, _dac, duty, length, len_on) = (c.u8()?, c.u8()?, c.u8()?, c.u16()?, c.u8()?);
                let (volume, init, up, env_period) = (c.u8()?, c.u8()?, c.u8()?, c.u8()?);
                c.u8()?; // envelope timer
                let frequency = c.u16()?;
                c.bytes(5)?; // frequency timer, duty position
                regs[base] = (duty & 3) << 6;
                regs[base + 1] = (init & 0xF) << 4 | (up & 1) << 3 | (env_period & 7);
                regs[base + 2] = frequency as u8;
                regs[base + 3] = (len_on & 1) << 6 | (frequency >> 8) as u8 & 7;
                flags |= (on & 1) << i;
                lengths[i] = length;
                volumes[i] = volume & 0xF;
            }
            let (on, dac, length, len_on, shift, frequency) = (c.u8()?, c.u8()?, c.u16()?, c.u8()?, c.u8()?, c.u16()?);
            c.bytes(4)?; // frequency timer
            regs[0x17..0x27].copy_from_slice(c.bytes(16)?);
            c.bytes(6)?; // sample index and byte, cycles since the fetch
            regs[0x0A] = (dac & 1) << 7;
            regs[0x0C] = (shift & 3) << 5;
            regs[0x0D] = frequency as u8;
            regs[0x0E] = (len_on & 1) << 6 | (frequency >> 8) as u8 & 7;
            flags |= (on & 1) << 2;
            lengths[2] = length;
            let (on, _dac, length, len_on, volume, init, up, env_period) =
                (c.u8()?, c.u8()?, c.u16()?, c.u8()?, c.u8()?, c.u8()?, c.u8()?, c.u8()?);
            c.u8()?; // envelope timer
            let (clock_shift, width, divisor) = (c.u8()?, c.u8()?, c.u8()?);
            c.bytes(6)?; // frequency timer, LFSR
            regs[0x11] = (init & 0xF) << 4 | (up & 1) << 3 | (env_period & 7);
            regs[0x12] = (clock_shift & 0xF) << 4 | (width & 1) << 3 | (divisor & 7);
            regs[0x13] = (len_on & 1) << 6;
            flags |= (on & 1) << 3;
            lengths[3] = length;
            volumes[2] = volume & 0xF;
            regs[0x14] = nr50;
            regs[0x15] = nr51;
            regs[0x16] = (power & 1) << 7 | flags;
            Some((regs, lengths, volumes, step))
        })() else {
            return false;
        };
        *pos = c.pos;
        self.restore_from_registers(&regs);
        self.ch1.length.counter = lengths[0].min(64);
        self.ch2.length.counter = lengths[1].min(64);
        self.ch3.length.counter = lengths[2].min(256);
        self.ch4.length.counter = lengths[3].min(64);
        self.ch1.volume = volumes[0];
        self.ch2.volume = volumes[1];
        self.ch4.volume = volumes[2];
        self.div_divider = step & 7;
        true
    }

    /// A block of another layout: power, registers, running channels and wave RAM come back;
    /// the channels' timers restart.
    fn restore_from_registers(&mut self, regs: &[u8]) {
        let (cgb, muted) = (self.cgb_mode, self.channel_muted);
        self.power_off();
        self.enabled = false;
        self.ch3.wave_ram.copy_from_slice(&regs[0x17..0x27]);
        let nr52 = regs[0x16];
        if nr52 & 0x80 != 0 {
            self.write_register(0xFF26, 0x80);
            for (i, &v) in regs[..0x16].iter().enumerate() {
                let addr = 0xFF10 + i as u16;
                // No trigger, and length enable as is (without the enable glitch).
                let v = if matches!(addr, 0xFF14 | 0xFF19 | 0xFF1E | 0xFF23) { v & 0x07 } else { v };
                self.write_register(addr, v);
            }
            self.ch1.length.enabled = regs[0x04] & 0x40 != 0;
            self.ch2.length.enabled = regs[0x09] & 0x40 != 0;
            self.ch3.length.enabled = regs[0x0E] & 0x40 != 0;
            self.ch4.length.enabled = regs[0x13] & 0x40 != 0;
            for (i, ch) in [&mut self.ch1, &mut self.ch2].into_iter().enumerate() {
                ch.enabled = nr52 & (1 << i) != 0 && ch.dac_enabled;
                ch.volume = ch.nrx2 >> 4;
                ch.countdown = ch.period() + 1;
            }
            self.ch3.enabled = nr52 & 4 != 0 && self.ch3.dac_enabled;
            self.ch4.enabled = nr52 & 8 != 0 && self.ch4.dac_enabled;
        }
        self.regs.copy_from_slice(&regs[..0x16]);
        self.cgb_mode = cgb;
        self.channel_muted = muted;
        self.after_import();
    }

    /// Table indexes and shifts are clamped: a damaged state must not index out of the tables.
    fn after_import(&mut self) {
        for ch in [&mut self.ch1, &mut self.ch2] {
            ch.duty &= 3;
            ch.duty_position &= 7;
            ch.volume &= 0xF;
            ch.volume_countdown &= 7;
            ch.sample &= 0xF;
            ch.frequency &= 0x7FF;
            ch.length.counter = ch.length.counter.min(64);
        }
        self.ch3.sample_index &= 31;
        self.ch3.volume_shift &= 3;
        self.ch4.clock_shift &= 0x0F;
        self.ch4.divisor_code &= 7;
        self.ch1_sweep.countdown &= 7;
        self.ch1_sweep.addend &= 0x7FF;
        self.ch1_sweep.shadow &= 0x7FF;
        self.skip_div_event = self.skip_div_event.min(2);
        self.lf_div &= 1;
        self.pending_envelope = self.pending_envelope.min(2);
        self.charged = false;
        self.external = [0.0; 2];
    }
}


#[cfg(test)]
mod tests {
    use super::*;

    /// The last sample (left) after `ms` milliseconds.
    fn settle(apu: &mut Apu, ms: u32) -> f32 {
        apu.clear_samples();
        for _ in 0..ms { apu.step(CPU_CLOCK / 2000); } // 2 MHz ticks
        let last = apu.sample_buffer[apu.sample_buffer.len() - 2];
        apu.clear_samples();
        last
    }

    #[test]
    fn silence_sits_at_zero_whatever_the_dacs_do() {
        let mut apu = Apu::new();
        for (reg, v) in [(0xFF26, 0x80), (0xFF24, 0x77), (0xFF25, 0xFF), (0xFF17, 0x08), (0xFF19, 0x80)] {
            apu.write_register(reg, v);
        }
        // Channel 2 on at volume 0: its DAC holds -1, a DC level and no tone.
        assert_eq!(settle(&mut apu, 50), 0.0, "the capacitor charges at start: no click");
        apu.set_channel_muted(1, true);
        apu.step(50);
        assert!(apu.sample_buffer[0] > 0.2, "a DAC switched off still steps (as on the console)");
        assert!(settle(&mut apu, 50).abs() < 0.01, "then the baseline is 0 again");
        apu.write_register(0xFF26, 0x00); // powered off
        assert!(settle(&mut apu, 50).abs() < 0.01);
    }

    /// A playing APU, saved: a block of another layout still restores power, registers and the
    /// channels that were on.
    #[test]
    fn a_block_of_another_layout_restores_from_its_registers() {
        let mut apu = Apu::new();
        for (reg, v) in [(0xFF26, 0x80), (0xFF24, 0x77), (0xFF25, 0xF3), (0xFF11, 0x80), (0xFF12, 0xF3),
                         (0xFF13, 0x42), (0xFF14, 0x87), (0xFF1A, 0x80), (0xFF1C, 0x40), (0xFF1E, 0x80)] {
            apu.write_register(reg, v);
        }
        apu.ch3.wave_ram[5] = 0xA5;
        apu.div_event(false);
        let mut state = Vec::new();
        apu.export_state(&mut state);

        let mut same = Apu::new();
        assert!(same.import_state(&state, &mut 0, 8));
        assert_eq!(same.div_divider, 1);

        state[2] = STATE_LAYOUT + 1;
        let mut other = Apu::new();
        let mut pos = 0;
        assert!(other.import_state(&state, &mut pos, 8));
        assert_eq!(pos, state.len());
        for reg in 0xFF10..=0xFF26 {
            assert_eq!(other.read_register(reg), apu.read_register(reg), "{reg:#06x}");
        }
        assert_eq!(other.ch1.frequency, 0x742);
        assert_eq!(other.ch3.wave_ram[5], 0xA5);
    }

    /// PCM12 reads channel 1's digital output in its low nibble and channel 2's in the high one
    /// (PCM34: channels 3 and 4), on CGB hardware only.
    #[test]
    fn pcm12_reads_the_square_channels_digital_output() {
        let mut apu = Apu::new();
        apu.cgb_mode = true;
        assert_eq!(apu.read_register(0xFF76), 0x00, "powered off: silence");
        // CH1 volume 8, CH2 volume 3, both duty 75% at the highest frequencies.
        for (reg, v) in [(0xFF26, 0x80), (0xFF11, 0xC0), (0xFF12, 0x80), (0xFF13, 0xFF), (0xFF14, 0x87),
                         (0xFF16, 0xC0), (0xFF17, 0x30), (0xFF18, 0xFE), (0xFF19, 0x87)] {
            apu.write_register(reg, v);
        }
        let seen: std::collections::BTreeSet<u8> = (0..64).map(|_| { apu.step(1); apu.read_register(0xFF76) }).collect();
        assert!(seen.contains(&0x38), "both high: {seen:02X?}");
        assert!(seen.iter().all(|v| [0x00, 0x08, 0x30, 0x38].contains(v)), "{seen:02X?}");
        assert_eq!(apu.read_register(0xFF77), 0x00, "channels 3 and 4 are off");

        apu.cgb_mode = false;
        assert_eq!(apu.read_register(0xFF76), 0xFF, "no PCM registers on a DMG");
        assert_eq!(apu.read_register(0xFF77), 0xFF);
    }

    /// A v3-v7 APU block (the T-cycle model's 113 bytes): power, registers, the playing channels,
    /// their lengths and volumes, and wave RAM come back.
    #[test]
    fn a_legacy_block_loads_as_registers() {
        let mut old = vec![0u8; 113];
        old[0] = 1; // power
        old[1] = 0x77; // NR50
        old[2] = 0xF3; // NR51
        old[7] = 5; // the frame sequencer's next step
        // CH1 at 24: on, DAC, duty 2, length 10, length on, volume 9, NRx2 $F3, frequency $742.
        old[24..42].copy_from_slice(&[1, 1, 2, 10, 0, 1, 9, 0xF, 0, 3, 0, 0x42, 0x07, 0, 0, 0, 0, 0]);
        old[72 + 3] = 0xA5; // wave RAM byte 3
        let mut apu = Apu::new();
        let mut pos = 0;
        assert!(apu.import_state(&old, &mut pos, 7));
        assert_eq!(pos, 113);
        assert_eq!(apu.read_register(0xFF26), 0xF1, "powered, CH1 playing");
        assert_eq!(apu.read_register(0xFF24), 0x77);
        assert_eq!(apu.read_register(0xFF11), 0xBF);
        assert_eq!(apu.read_register(0xFF12), 0xF3);
        assert_eq!(apu.read_register(0xFF14), 0xFF, "length enabled");
        assert_eq!((apu.ch1.frequency, apu.ch1.volume, apu.ch1.length.counter), (0x742, 9, 10));
        assert_eq!(apu.ch3.wave_ram[3], 0xA5);
        assert_eq!(apu.div_divider, 5);
    }
}
