/// Serial port (SB $FF01, SC $FF02).
///
/// A transfer shifts 8 bits: SC bit 7 starts it, bit 0 picks the clock (1 = internal, this
/// console is the master; 0 = external, it waits for the partner's clock). An internal-clock
/// transfer takes 8 periods of 512 CPU cycles (16 with the CGB fast clock, SC bit 1), whose edges
/// come from the DIV counter: it ends on the 8th edge after the write, not 8 periods after it
/// (Mooneye boot_sclk_align). When it ends SB
/// holds the byte shifted in (0xFF with no partner), SC bit 7 clears and the serial interrupt
/// fires. Two consoles are connected by `gameboy::run_linked_frame`.
///
/// Remote link (`set_remote`): the partner runs on another machine and bytes cross a network.
/// The console that clocks a transfer stalls at its start (`stalled`) until the partner's byte
/// arrives (`remote_reply`), then completes it on the usual schedule, so what the game sees does
/// not depend on the latency. The partner's clock (`remote_clock`) is held until this console arms
/// an external-clock transfer, at most `HOLD_CYCLES`, and answered with SB (`take_reply`).
pub struct Serial {
    pub(crate) data: u8,
    pub(crate) control: u8,
    output: Vec<u8>,
    /// CPU cycles until the running transfer completes (0 = idle).
    pub(crate) remaining: u32,
    /// Byte that SB takes when the running transfer completes.
    pub(crate) incoming: u8,
    /// Set when an internal-clock transfer starts; the link cable consumes it.
    started: bool,
    /// A Game Boy Printer on the port (solo play only: a link partner replaces it).
    pub printer: Option<crate::printer::Printer>,
    remote: bool,
    /// Remote link: our internal-clock transfer waits for the partner's byte.
    awaiting: bool,
    /// Remote link: the byte and duration of that transfer, until `take_request` hands them out.
    request: Option<(u8, u32)>,
    /// Remote link: the partner's byte and transfer duration, waiting for us to listen, and for how long.
    held: Option<(u8, u32)>,
    held_for: u32,
    /// Remote link: the byte to send back to the partner that clocked us (0xFF: we weren't listening).
    reply: Option<u8>,
}

/// How long (CPU cycles, one frame) a partner's clock waits for this console to listen before the
/// partner shifts in 0xFF, as from an unplugged cable.
// ponytail: fixed one-frame window; hardware has none (a slave not listening misses the byte) but the
// two consoles no longer share a clock. Make it tunable if a game polls the link faster than that.
pub const HOLD_CYCLES: u32 = 70224;

impl Serial {
    pub fn new() -> Self {
        Self {
            data: 0,
            control: 0,
            output: Vec::new(),
            remaining: 0,
            incoming: 0xFF,
            started: false,
            printer: None,
            remote: false,
            awaiting: false,
            request: None,
            held: None,
            held_for: 0,
            reply: None,
        }
    }

    pub fn read(&self, addr: u16) -> u8 {
        match addr {
            0xFF01 => self.data,
            0xFF02 => self.control,
            _ => 0xFF,
        }
    }

    /// `div`: the 16-bit DIV counter, which the internal clock is divided from.
    pub fn write(&mut self, addr: u16, value: u8, div: u16) {
        match addr {
            0xFF01 => self.data = value,
            0xFF02 => {
                self.control = value;
                if value & 0x81 == 0x81 {
                    // Blargg's test ROMs print through the serial port.
                    self.output.push(self.data);
                    let period = if value & 0x02 != 0 { 16 } else { 512 };
                    self.remaining = 8 * period - (div as u32 + 4) % period;
                    // A remote partner replaces the printer: its byte arrives through remote_reply.
                    self.incoming = if self.remote { 0xFF } else { self.printer.as_mut().map_or(0xFF, |p| p.exchange(self.data)) };
                    self.started = true;
                    if self.remote {
                        // Both consoles clocking at once: the partner's held clock gets nothing.
                        if self.held.take().is_some() {
                            self.reply = Some(0xFF);
                        }
                        self.awaiting = true;
                        self.request = Some((self.data, self.remaining));
                    }
                } else if value & 0x80 == 0 {
                    self.remaining = 0;
                    self.awaiting = false;
                    self.request = None;
                } else if let Some((byte, cycles)) = self.held.take() {
                    // Listening now: the partner's held clock goes through.
                    self.accept(byte, cycles);
                }
            }
            _ => {}
        }
    }

    /// Tick serial by CPU cycles. Returns true if the serial interrupt should fire.
    pub fn tick(&mut self, cycles: u32) -> bool {
        if let Some(p) = &mut self.printer { p.tick(1); }
        if self.held.is_some() {
            self.held_for += cycles;
            if self.held_for >= HOLD_CYCLES {
                self.held = None;
                self.reply = Some(0xFF);
            }
        }
        if self.remaining == 0 || self.awaiting {
            return false;
        }
        self.remaining = self.remaining.saturating_sub(cycles);
        if self.remaining > 0 {
            return false;
        }
        self.data = self.incoming;
        self.control &= 0x7F;
        true
    }

    /// True once after an internal-clock transfer started (used by the link cable).
    pub fn take_started(&mut self) -> bool {
        std::mem::take(&mut self.started)
    }

    /// Waiting for the partner's clock: external-clock transfer requested (SC = $80).
    pub fn armed_external(&self) -> bool {
        self.control & 0x81 == 0x80
    }

    /// The partner (master) clocks a byte in: completes in `cycles` CPU cycles.
    pub fn clock_in(&mut self, byte: u8, cycles: u32) {
        self.incoming = byte;
        self.remaining = cycles.max(1);
    }

    /// CPU cycles left in the running transfer.
    pub fn remaining(&self) -> u32 {
        self.remaining
    }

    /// True while an internal-clock transfer is in progress.
    pub fn needs_transfer(&self) -> bool {
        self.remaining > 0 && self.control & 0x01 != 0
    }

    /// The byte currently being sent over the serial link.
    pub fn get_byte(&self) -> u8 {
        self.data
    }

    /// Byte shifted in from a link-cable partner during the running transfer.
    pub fn receive_byte(&mut self, byte: u8) {
        self.incoming = byte;
    }

    /// Remote link on or off. Off releases a stalled transfer (it shifts in 0xFF) and drops a held clock.
    pub fn set_remote(&mut self, on: bool) {
        self.remote = on;
        if !on {
            self.awaiting = false;
            self.request = None;
            self.held = None;
            self.reply = None;
        }
    }

    /// True while our internal-clock transfer waits for the partner's byte (the CPU must not run).
    pub fn stalled(&self) -> bool {
        self.awaiting
    }

    /// Once per transfer: the byte we clock out and the transfer's duration, for the partner.
    pub fn take_request(&mut self) -> Option<(u8, u32)> {
        self.request.take()
    }

    /// The partner's byte for our stalled transfer: it completes on its usual schedule from here.
    pub fn remote_reply(&mut self, byte: u8) {
        if self.awaiting {
            self.incoming = byte;
            self.awaiting = false;
            self.request = None;
        }
    }

    /// The partner clocks `byte` in over `cycles`: answered now when we are listening, refused
    /// when we are clocking too, held otherwise (see `HOLD_CYCLES`). The answer is in `take_reply`.
    pub fn remote_clock(&mut self, byte: u8, cycles: u32) {
        if self.awaiting || (self.control & 0x81 == 0x81 && self.remaining > 0) {
            self.reply = Some(0xFF);
        } else if self.armed_external() && self.remaining == 0 {
            self.accept(byte, cycles);
        } else {
            if self.held.is_some() {
                self.reply = Some(0xFF);
            }
            self.held = Some((byte, cycles));
            self.held_for = 0;
        }
    }

    /// The byte to send back to the partner that clocked us, once.
    pub fn take_reply(&mut self) -> Option<u8> {
        self.reply.take()
    }

    fn accept(&mut self, byte: u8, cycles: u32) {
        self.reply = Some(self.data);
        self.clock_in(byte, cycles);
    }

    pub fn serial_output(&self) -> &[u8] {
        &self.output
    }

    pub fn clear_serial_output(&mut self) {
        self.output.clear();
    }
}
