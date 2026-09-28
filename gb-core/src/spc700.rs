//! SPC700: the SNES audio CPU that runs Super Game Boy sound programs (uploaded with `SOU_TRN`).
//!
//! Clean-room from public documentation (fullsnes, Anomie's SPC700 doc). 64 KB of audio RAM, the
//! `$F0-$FF` registers and three timers. There is no IPL ROM: `$FFC0-$FFFF` always reads RAM, and
//! programs are placed in `aram` directly. The S-DSP sits behind [`DspBus`] (`$F2`/`$F3`); it reads
//! its samples from the public `aram`.

/// The S-DSP's 128 registers as the SPC700 sees them through `$F2`/`$F3`.
pub trait DspBus {
    fn read(&mut self, reg: u8) -> u8;
    fn write(&mut self, reg: u8, value: u8);
}

/// Cycles of the 1.024 MHz SPC700 clock per timer tick: 8 kHz for timers 0-1, 64 kHz for timer 2.
const TIMER_PERIOD: [u32; 3] = [128, 128, 16];

#[derive(Clone, Copy, Default)]
struct Timer {
    /// `$FA-$FC`; 0 means 256.
    target: u8,
    /// The internal 8-bit counter compared with `target`.
    stage: u8,
    /// The 4-bit counter read (and cleared) at `$FD-$FF`.
    out: u8,
    /// SPC700 cycles towards the next tick.
    div: u32,
}

pub struct Spc700 {
    pub a: u8,
    pub x: u8,
    pub y: u8,
    pub sp: u8,
    pub pc: u16,
    pub psw: u8,
    pub aram: Box<[u8; 0x10000]>,
    /// Written by the other side (the SGB), read by the SPC700 at `$F4-$F7`.
    pub ports_in: [u8; 4],
    /// Written by the SPC700 at `$F4-$F7`, read by the other side.
    pub ports_out: [u8; 4],
    /// Set by `SLEEP`/`STOP`: the core stops executing until reset.
    pub halted: bool,
    dsp_addr: u8,
    control: u8,
    timers: [Timer; 3],
}

impl Default for Spc700 {
    fn default() -> Self {
        Self::new()
    }
}

impl Spc700 {
    pub fn new() -> Self {
        Spc700 {
            a: 0,
            x: 0,
            y: 0,
            sp: 0xEF,
            pc: 0,
            psw: 0,
            aram: vec![0; 0x10000].into_boxed_slice().try_into().unwrap(),
            ports_in: [0; 4],
            ports_out: [0; 4],
            halted: false,
            dsp_addr: 0,
            control: 0,
            timers: [Timer::default(); 3],
        }
    }

    pub fn read(&mut self, addr: u16, dsp: &mut impl DspBus) -> u8 {
        match addr {
            0xF2 => self.dsp_addr,
            0xF3 => dsp.read(self.dsp_addr & 0x7F),
            0xF4..=0xF7 => self.ports_in[addr as usize - 0xF4],
            0xFD..=0xFF => std::mem::take(&mut self.timers[addr as usize - 0xFD].out),
            // Write-only registers.
            0xF0 | 0xF1 | 0xFA..=0xFC => 0,
            _ => self.aram[addr as usize],
        }
    }

    /// Register writes also land in the RAM underneath, as on hardware.
    pub fn write(&mut self, addr: u16, value: u8, dsp: &mut impl DspBus) {
        match addr {
            // $F0 (test register) is accepted and ignored: its speed/halt bits are unsafe on hardware.
            0xF1 => {
                for (i, t) in self.timers.iter_mut().enumerate() {
                    // Enabling a stopped timer restarts both of its counters.
                    if value & !self.control & (1 << i) != 0 {
                        t.stage = 0;
                        t.out = 0;
                    }
                }
                if value & 0x10 != 0 {
                    self.ports_in[0] = 0;
                    self.ports_in[1] = 0;
                }
                if value & 0x20 != 0 {
                    self.ports_in[2] = 0;
                    self.ports_in[3] = 0;
                }
                self.control = value; // bit 7 (IPL ROM enable) has nothing to map
            }
            0xF2 => self.dsp_addr = value,
            0xF3 if self.dsp_addr < 0x80 => dsp.write(self.dsp_addr, value),
            0xF4..=0xF7 => self.ports_out[addr as usize - 0xF4] = value,
            0xFA..=0xFC => self.timers[addr as usize - 0xFA].target = value,
            _ => {}
        }
        self.aram[addr as usize] = value;
    }

    pub fn tick_timers(&mut self, cycles: u32) {
        for (i, t) in self.timers.iter_mut().enumerate() {
            t.div += cycles;
            while t.div >= TIMER_PERIOD[i] {
                t.div -= TIMER_PERIOD[i];
                if self.control & (1 << i) != 0 {
                    t.stage = t.stage.wrapping_add(1);
                    if t.stage == t.target {
                        t.stage = 0;
                        t.out = (t.out + 1) & 0x0F;
                    }
                }
            }
        }
    }
}
