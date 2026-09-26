use thiserror::Error;

#[derive(Error, Debug)]
pub enum CpuError {
    #[error("Invalid opcode 0x{opcode:02X} at PC=0x{pc:04X}")]
    InvalidOpcode { opcode: u8, pc: u16 },

    #[error("Invalid CB-prefixed opcode 0xCB{opcode:02X} at PC=0x{pc:04X}")]
    InvalidCbOpcode { opcode: u8, pc: u16 },

    #[error("CPU halted with no pending interrupts (deadlock) at PC=0x{pc:04X}")]
    HaltDeadlock { pc: u16 },
}

#[derive(Error, Debug)]
pub enum MemoryError {
    #[error("Write to read-only address 0x{address:04X} (value=0x{value:02X})")]
    ReadOnlyWrite { address: u16, value: u8 },

    #[error("Access to unmapped address 0x{address:04X}")]
    UnmappedAccess { address: u16 },
}

#[derive(Error, Debug)]
pub enum CartridgeError {
    #[error("ROM too small: expected at least {expected} bytes, got {actual}")]
    RomTooSmall { expected: usize, actual: usize },

    #[error("Unsupported cartridge type: 0x{cart_type:02X}")]
    UnsupportedType { cart_type: u8 },

    #[error("Invalid header checksum: expected 0x{expected:02X}, got 0x{actual:02X}")]
    InvalidChecksum { expected: u8, actual: u8 },

    #[error("ROM bank {bank} out of range (max {max_banks})")]
    BankOutOfRange { bank: usize, max_banks: usize },
}

#[derive(Error, Debug)]
pub enum PpuError {
    #[error("Invalid PPU mode transition: {from} -> {to} at scanline {scanline}")]
    InvalidModeTransition { from: u8, to: u8, scanline: u8 },
}

#[derive(Error, Debug)]
pub enum EmulatorError {
    #[error("CPU error: {0}")]
    Cpu(#[from] CpuError),

    #[error("Memory error: {0}")]
    Memory(#[from] MemoryError),

    #[error("Cartridge error: {0}")]
    Cartridge(#[from] CartridgeError),

    #[error("PPU error: {0}")]
    Ppu(#[from] PpuError),
}
