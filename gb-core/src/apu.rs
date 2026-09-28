// =============================================================================
// Game Boy APU (Audio Processing Unit)
// =============================================================================
//
// 4 channels: CH1 (square+sweep), CH2 (square), CH3 (wave), CH4 (noise)
// Frame sequencer clocked at 512 Hz (every 8192 T-cycles)
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
// SquareChannel (used by CH1 and CH2)
// -----------------------------------------------------------------------------

pub struct SquareChannel {
    pub enabled: bool,
    pub dac_enabled: bool,
    duty: u8,
    length: Length,
    volume: u8,
    volume_init: u8,
    envelope_direction: bool, // true = increase
    envelope_period: u8,
    envelope_timer: u8,
    pub frequency: u16,
    frequency_timer: i32,
    duty_position: u8,
}

impl SquareChannel {
    pub fn new() -> Self {
        Self {
            enabled: false,
            dac_enabled: false,
            duty: 0,
            length: Length::new(64),
            volume: 0,
            volume_init: 0,
            envelope_direction: false,
            envelope_period: 0,
            envelope_timer: 0,
            frequency: 0,
            frequency_timer: 0,
            duty_position: 0,
        }
    }

    pub fn step(&mut self, cycles: u32) {
        if !self.enabled { return; }
        self.frequency_timer -= cycles as i32;
        while self.frequency_timer <= 0 {
            self.frequency_timer += ((2048 - self.frequency as i32) * 4).max(1);
            self.duty_position = (self.duty_position + 1) & 7;
        }
    }

    pub fn output(&self) -> f32 {
        if !self.enabled || !self.dac_enabled {
            return 0.0;
        }
        let sample = if DUTY_TABLE[self.duty as usize][self.duty_position as usize] != 0 {
            self.volume
        } else {
            0
        };
        sample as f32 / 7.5 - 1.0
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
        self.frequency_timer = (2048 - self.frequency as i32) * 4;
        self.volume = self.volume_init;
        self.envelope_timer = self.envelope_period;
    }

    // -- Register access --

    pub fn write_nrx1(&mut self, value: u8) {
        self.duty = (value >> 6) & 0x03;
        self.length.load(value & 0x3F);
    }

    pub fn write_nrx2(&mut self, value: u8) {
        self.volume_init = (value >> 4) & 0x0F;
        self.envelope_direction = value & 0x08 != 0;
        self.envelope_period = value & 0x07;
        self.dac_enabled = value & 0xF8 != 0;
        if !self.dac_enabled {
            self.enabled = false;
        }
    }

    pub fn write_nrx3(&mut self, value: u8) {
        self.frequency = (self.frequency & 0x700) | value as u16;
    }

    pub fn write_nrx4(&mut self, value: u8, first_half: bool) {
        self.frequency = (self.frequency & 0x00FF) | (((value & 0x07) as u16) << 8);
        self.length.write_nrx4(value, first_half, &mut self.enabled);
        if value & 0x80 != 0 {
            self.trigger();
        }
    }

    pub fn read_nrx1(&self) -> u8 {
        (self.duty << 6) | 0x3F // lower 6 bits write-only
    }

    pub fn read_nrx2(&self) -> u8 {
        (self.volume_init << 4)
            | if self.envelope_direction { 0x08 } else { 0 }
            | self.envelope_period
    }

    pub fn read_nrx4(&self) -> u8 {
        self.length.read_bit() | 0xBF // other bits write-only
    }
}

// -----------------------------------------------------------------------------
// SweepUnit (CH1 only)
// -----------------------------------------------------------------------------

pub struct SweepUnit {
    enabled: bool,
    frequency_shadow: u16,
    period: u8,
    direction: bool, // true = decrease
    pub shift: u8,
    timer: u8,
    /// A calculation in negate mode happened since the last trigger.
    negate_used: bool,
}

impl SweepUnit {
    pub fn new() -> Self {
        Self {
            enabled: false,
            frequency_shadow: 0,
            period: 0,
            direction: false,
            shift: 0,
            timer: 0,
            negate_used: false,
        }
    }

    /// Returns false when the write must disable the channel: leaving negate mode
    /// after a negate calculation has been made.
    pub fn write_nr10(&mut self, value: u8) -> bool {
        self.period = (value >> 4) & 0x07;
        self.direction = value & 0x08 != 0;
        self.shift = value & 0x07;
        !(self.negate_used && !self.direction)
    }

    pub fn read_nr10(&self) -> u8 {
        0x80 // bit 7 unused, reads 1
            | (self.period << 4)
            | if self.direction { 0x08 } else { 0 }
            | self.shift
    }

    pub fn trigger(&mut self, frequency: u16) {
        self.frequency_shadow = frequency;
        self.timer = if self.period != 0 { self.period } else { 8 };
        self.enabled = self.period != 0 || self.shift != 0;
        self.negate_used = false;
    }

    pub fn calculate(&mut self) -> (u16, bool) {
        let delta = self.frequency_shadow >> self.shift;
        let new_freq = if self.direction {
            self.negate_used = true;
            self.frequency_shadow.wrapping_sub(delta)
        } else {
            self.frequency_shadow.wrapping_add(delta)
        };
        (new_freq, new_freq > 2047)
    }

    pub fn clock(&mut self, channel_enabled: &mut bool, frequency: &mut u16) {
        if self.timer > 0 {
            self.timer -= 1;
        }
        if self.timer == 0 {
            self.timer = if self.period != 0 { self.period } else { 8 };
            if self.enabled && self.period != 0 {
                let (new_freq, overflow) = self.calculate();
                if overflow {
                    *channel_enabled = false;
                } else if self.shift != 0 {
                    self.frequency_shadow = new_freq;
                    *frequency = new_freq;
                    // Do overflow check again with new frequency
                    let (_, overflow2) = self.calculate();
                    if overflow2 {
                        *channel_enabled = false;
                    }
                }
            }
        }
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

    pub fn output(&self) -> f32 {
        if !self.enabled || !self.dac_enabled {
            return 0.0;
        }
        let sample = if self.sample_index & 1 == 0 {
            self.sample_byte >> 4
        } else {
            self.sample_byte & 0x0F
        };
        let shifted = match self.volume_shift {
            1 => sample,
            2 => sample >> 1,
            3 => sample >> 2,
            _ => 0,
        };
        shifted as f32 / 7.5 - 1.0
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

    pub fn output(&self) -> f32 {
        if !self.enabled || !self.dac_enabled {
            return 0.0;
        }
        let sample = if self.lfsr & 0x01 == 0 {
            self.volume
        } else {
            0
        };
        sample as f32 / 7.5 - 1.0
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

// -----------------------------------------------------------------------------
// Apu (main mixer + register dispatch)
// -----------------------------------------------------------------------------

pub struct Apu {
    enabled: bool,
    /// CGB APU quirks (wave RAM access, length counters on power-off). Synced by the bus.
    pub cgb_mode: bool,
    pub ch1: SquareChannel,
    pub ch1_sweep: SweepUnit,
    pub ch2: SquareChannel,
    pub ch3: WaveChannel,
    pub ch4: NoiseChannel,
    nr50: u8,
    nr51: u8, // panning
    frame_sequencer_counter: u32,
    frame_sequencer_step: u8,
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
            ch1_sweep: SweepUnit::new(),
            ch2: SquareChannel::new(),
            ch3: WaveChannel::new(),
            ch4: NoiseChannel::new(),
            nr50: 0,
            nr51: 0,
            frame_sequencer_counter: 0,
            frame_sequencer_step: 0,
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

    pub fn step(&mut self, cycles: u32) {
        if !self.enabled {
            return self.silence(cycles);
        }

        // Tick channels
        self.ch1.step(cycles);
        self.ch2.step(cycles);
        self.ch3.step(cycles);
        self.ch4.step(cycles);

        // Frame sequencer (512 Hz = every 8192 T-cycles)
        self.frame_sequencer_counter += cycles;
        while self.frame_sequencer_counter >= 8192 {
            self.frame_sequencer_counter -= 8192;
            self.clock_frame_sequencer();
        }

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

    fn clock_frame_sequencer(&mut self) {
        match self.frame_sequencer_step {
            0 | 4 => self.clock_length_all(),
            2 | 6 => {
                self.clock_length_all();
                self.ch1_sweep.clock(&mut self.ch1.enabled, &mut self.ch1.frequency);
            }
            7 => {
                self.ch1.clock_envelope();
                self.ch2.clock_envelope();
                self.ch4.clock_envelope();
            }
            _ => {}
        }
        self.frame_sequencer_step = (self.frame_sequencer_step + 1) & 7;
    }

    /// True when the next frame-sequencer step doesn't clock length counters.
    fn length_first_half(&self) -> bool {
        self.frame_sequencer_step & 1 == 1
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

            // Write-only (NRx3, NR31, NR41...) and unused registers
            _ => 0xFF,
        }
    }

    pub fn write_register(&mut self, addr: u16, value: u8) {
        if !self.enabled {
            match addr {
                0xFF26 if value & 0x80 != 0 => {
                    // Power on: the frame sequencer restarts at step 0.
                    self.enabled = true;
                    self.frame_sequencer_step = 0;
                    self.frame_sequencer_counter = 0;
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

        let first_half = self.length_first_half();
        match addr {
            // CH1 — Square with sweep
            0xFF10 => {
                if !self.ch1_sweep.write_nr10(value) {
                    self.ch1.enabled = false;
                }
            }
            0xFF11 => self.ch1.write_nrx1(value),
            0xFF12 => self.ch1.write_nrx2(value),
            0xFF13 => self.ch1.write_nrx3(value),
            0xFF14 => {
                self.ch1.write_nrx4(value, first_half);
                if value & 0x80 != 0 {
                    self.ch1_sweep.trigger(self.ch1.frequency);
                    // Overflow check on trigger if shift != 0
                    if self.ch1_sweep.shift != 0 && self.ch1_sweep.calculate().1 {
                        self.ch1.enabled = false;
                    }
                }
            }

            // CH2 — Square
            0xFF16 => self.ch2.write_nrx1(value),
            0xFF17 => self.ch2.write_nrx2(value),
            0xFF18 => self.ch2.write_nrx3(value),
            0xFF19 => self.ch2.write_nrx4(value, first_half),

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

/// Every piece of APU state that affects emulation (not the sample buffer or channel mutes),
/// listed once for both export_state and import_state so the two cannot drift apart.
macro_rules! apu_fields {
    ($m:ident, $a:expr) => {
        $m!(
            $a.enabled, $a.nr50, $a.nr51, $a.frame_sequencer_counter, $a.frame_sequencer_step,
            $a.sample_counter,
            $a.ch1_sweep.enabled, $a.ch1_sweep.frequency_shadow, $a.ch1_sweep.period,
            $a.ch1_sweep.direction, $a.ch1_sweep.shift, $a.ch1_sweep.timer, $a.ch1_sweep.negate_used,
            $a.ch1.enabled, $a.ch1.dac_enabled, $a.ch1.duty, $a.ch1.length.counter,
            $a.ch1.length.enabled, $a.ch1.volume, $a.ch1.volume_init, $a.ch1.envelope_direction,
            $a.ch1.envelope_period, $a.ch1.envelope_timer, $a.ch1.frequency, $a.ch1.frequency_timer,
            $a.ch1.duty_position,
            $a.ch2.enabled, $a.ch2.dac_enabled, $a.ch2.duty, $a.ch2.length.counter,
            $a.ch2.length.enabled, $a.ch2.volume, $a.ch2.volume_init, $a.ch2.envelope_direction,
            $a.ch2.envelope_period, $a.ch2.envelope_timer, $a.ch2.frequency, $a.ch2.frequency_timer,
            $a.ch2.duty_position,
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

impl Apu {
    pub fn export_state(&self, out: &mut Vec<u8>) {
        macro_rules! put { ($($f:expr),*) => { $( $f.put(out); )* }; }
        apu_fields!(put, self);
    }

    /// Returns false if `data` ends early.
    pub fn import_state(&mut self, data: &[u8], pos: &mut usize) -> bool {
        macro_rules! take { ($($f:expr),*) => { $( if $f.take(data, pos).is_none() { return false; } )* }; }
        apu_fields!(take, self);
        // Table indexes and shifts are clamped: a damaged state must not index out of the tables.
        for ch in [&mut self.ch1, &mut self.ch2] { ch.duty &= 3; ch.duty_position &= 7; }
        self.ch3.sample_index &= 31;
        self.ch3.volume_shift &= 3;
        self.ch4.clock_shift &= 0x0F;
        self.ch4.divisor_code &= 7;
        self.ch1_sweep.shift &= 7;
        self.frame_sequencer_step &= 7;
        self.charged = false;
        self.external = [0.0; 2];
        true
    }
}


#[cfg(test)]
mod tests {
    use super::*;

    /// The last sample (left) after `ms` milliseconds.
    fn settle(apu: &mut Apu, ms: u32) -> f32 {
        apu.clear_samples();
        for _ in 0..ms { apu.step(CPU_CLOCK / 1000); }
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
        apu.step(100);
        assert!(apu.sample_buffer[0] > 0.2, "a DAC switched off still steps (as on the console)");
        assert!(settle(&mut apu, 50).abs() < 0.01, "then the baseline is 0 again");
        apu.write_register(0xFF26, 0x00); // powered off
        assert!(settle(&mut apu, 50).abs() < 0.01);
    }
}
