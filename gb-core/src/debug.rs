//! Opt-in debugger: PC breakpoints checked once per instruction by `GameBoy::run_frame`, which
//! returns early mid-frame on a hit. Absent (`GameBoy::debugger == None`) it costs one branch.

use std::collections::BTreeSet;

/// Why the machine stopped.
#[derive(Clone, Copy, PartialEq, Eq, Debug)]
pub enum Break {
    Breakpoint(u16),
    Frame,
}

impl Break {
    pub fn describe(&self) -> String {
        match self {
            Break::Breakpoint(pc) => format!("breakpoint ${pc:04X}"),
            Break::Frame => "frame".to_string(),
        }
    }
}

#[derive(Default)]
pub struct Debugger {
    pub breakpoints: BTreeSet<u16>,
    pub hit: Option<Break>,
    /// The PC the machine stopped at: the next check there lets its instruction run once.
    pub resume_pc: Option<u16>,
}

impl Debugger {
    /// Called before each instruction at `pc`; `true` stops the machine there.
    pub fn should_stop(&mut self, pc: u16) -> bool {
        if self.resume_pc.take() == Some(pc) || !self.breakpoints.contains(&pc) {
            return false;
        }
        self.hit = Some(Break::Breakpoint(pc));
        self.resume_pc = Some(pc);
        true
    }
}
