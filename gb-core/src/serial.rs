/// Serial port (SB $FF01, SC $FF02).
///
/// A transfer shifts 8 bits: SC bit 7 starts it, bit 0 picks the clock (1 = internal, this
/// console is the master; 0 = external, it waits for the partner's clock). An internal-clock
/// transfer takes 8 x 512 CPU cycles (8 x 16 with the CGB fast clock, SC bit 1); when it ends SB
/// holds the byte shifted in (0xFF with no partner), SC bit 7 clears and the serial interrupt
/// fires. Two consoles are connected by `gameboy::run_linked_frame`.
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
}

impl Serial {
    pub fn new() -> Self {
        Self {
            data: 0,
            control: 0,
            output: Vec::new(),
            remaining: 0,
            incoming: 0xFF,
            started: false,
        }
    }

    pub fn read(&self, addr: u16) -> u8 {
        match addr {
            0xFF01 => self.data,
            0xFF02 => self.control,
            _ => 0xFF,
        }
    }

    pub fn write(&mut self, addr: u16, value: u8) {
        match addr {
            0xFF01 => self.data = value,
            0xFF02 => {
                self.control = value;
                if value & 0x81 == 0x81 {
                    // Blargg's test ROMs print through the serial port.
                    self.output.push(self.data);
                    self.remaining = if value & 0x02 != 0 { 8 * 16 } else { 8 * 512 };
                    self.incoming = 0xFF;
                    self.started = true;
                } else if value & 0x80 == 0 {
                    self.remaining = 0;
                }
            }
            _ => {}
        }
    }

    /// Tick serial by CPU cycles. Returns true if the serial interrupt should fire.
    pub fn tick(&mut self, cycles: u32) -> bool {
        if self.remaining == 0 {
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

    pub fn serial_output(&self) -> &[u8] {
        &self.output
    }

    pub fn clear_serial_output(&mut self) {
        self.output.clear();
    }
}
