//! Opt-in debugger: PC breakpoints checked once per instruction by `GameBoy::run_frame`, which
//! returns early mid-frame on a hit. Absent (`GameBoy::debugger == None`) it costs one branch.

use std::collections::BTreeSet;

/// Why the machine stopped.
#[derive(Clone, Copy, PartialEq, Eq, Debug)]
pub enum Break {
    Breakpoint(u16),
    Frame,
    /// A watched address was accessed by the instruction at `pc` (the machine stops after it).
    Watch { addr: u16, value: u8, write: bool, pc: u16 },
    /// Run to scanline: LY reached this line.
    Scanline(u8),
}

impl Break {
    pub fn describe(&self) -> String {
        match self {
            Break::Breakpoint(pc) => format!("breakpoint ${pc:04X}"),
            Break::Frame => "frame".to_string(),
            Break::Watch { addr, value, write, pc } => {
                let kind = if *write { "write" } else { "read" };
                format!("{kind} ${addr:04X} = ${value:02X} at ${pc:04X}")
            }
            Break::Scanline(ly) => format!("scanline {ly}"),
        }
    }
}

/// Watch kinds, as bits: an access watchpoint is both.
pub const WATCH_READ: u8 = 1;
pub const WATCH_WRITE: u8 = 2;

/// Watched addresses, recorded by the bus's CPU accessors (`MemoryBus::cycle_*`), so DMA, HDMA
/// and the debugger's own reads never fire. Only the first access of an instruction is kept.
#[derive(Default)]
pub struct WatchSet {
    pub entries: Vec<(u16, u8)>,
    pub hit: Option<(u16, u8, bool)>,
}

impl WatchSet {
    #[inline]
    pub fn record(&mut self, addr: u16, value: u8, write: bool) {
        let bit = if write { WATCH_WRITE } else { WATCH_READ };
        if self.hit.is_none() && self.entries.iter().any(|&(a, k)| a == addr && k & bit != 0) {
            self.hit = Some((addr, value, write));
        }
    }

    pub fn add(&mut self, addr: u16, kind: u8) {
        match self.entries.iter_mut().find(|(a, _)| *a == addr) {
            Some((_, k)) => *k |= kind,
            None => self.entries.push((addr, kind)),
        }
    }

    pub fn remove(&mut self, addr: u16, kind: u8) {
        for (a, k) in &mut self.entries {
            if *a == addr {
                *k &= !kind;
            }
        }
        self.entries.retain(|&(_, k)| k != 0);
    }
}

#[derive(Default)]
pub struct Debugger {
    pub breakpoints: BTreeSet<u16>,
    pub hit: Option<Break>,
    /// The PC the machine stopped at: the next check there lets its instruction run once.
    pub resume_pc: Option<u16>,
    /// One-shot stop for step over: the address after the `CALL`/`RST` (no `hit` when it fires).
    pub temp_stop: Option<u16>,
    /// One-shot stop for run to scanline: after the instruction that brings LY to this line.
    pub stop_ly: Option<u8>,
}

impl Debugger {
    /// Called before each instruction at `pc`; `true` stops the machine there.
    pub fn should_stop(&mut self, pc: u16) -> bool {
        if self.resume_pc.take() == Some(pc) {
            return false;
        }
        if self.temp_stop == Some(pc) {
            self.temp_stop = None;
            self.resume_pc = Some(pc);
            return true;
        }
        if !self.breakpoints.contains(&pc) {
            return false;
        }
        self.hit = Some(Break::Breakpoint(pc));
        self.resume_pc = Some(pc);
        true
    }
}
