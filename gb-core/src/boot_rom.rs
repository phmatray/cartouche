/// Original minimal DMG boot stub (256 bytes), written for Cartouche.
///
/// Cartouche does not ship, embed or reproduce Nintendo's boot ROM (its code,
/// its logo animation, or the 48-byte logo bitmap). By default the emulator
/// never runs this stub at all: `Emulator::load_rom` calls
/// `GameBoy::skip_boot_rom()`, which sets the documented post-boot register
/// and I/O state directly (the approach used by most open-source emulators).
///
/// The stub only exists so that a `GameBoy` created without skipping still
/// reaches the cartridge entry point instead of executing garbage:
///
///   $0000: LD SP, $FFFE
///   $0003: JP $00FC
///   $00FC: LD A, $01
///   $00FE: LDH ($50), A   ; unmap stub, execution continues at $0100
///
/// No logo check and no header checksum check are performed.
pub const DMG_BOOT_ROM: [u8; 256] = {
    let mut rom = [0u8; 256];
    rom[0x00] = 0x31; // LD SP, $FFFE
    rom[0x01] = 0xFE;
    rom[0x02] = 0xFF;
    rom[0x03] = 0xC3; // JP $00FC
    rom[0x04] = 0xFC;
    rom[0x05] = 0x00;
    rom[0xFC] = 0x3E; // LD A, $01
    rom[0xFD] = 0x01;
    rom[0xFE] = 0xE0; // LDH ($50), A
    rom[0xFF] = 0x50;
    rom
};

#[cfg(test)]
mod tests {
    use super::DMG_BOOT_ROM;

    #[test]
    fn stub_is_tiny_and_unmaps_itself() {
        let used = DMG_BOOT_ROM.iter().filter(|&&b| b != 0).count();
        assert_eq!(used, 9); // 9 non-zero bytes; $0005 is the JP high byte (0x00)
        assert_eq!(&DMG_BOOT_ROM[0xFC..], &[0x3E, 0x01, 0xE0, 0x50]);
    }
}
