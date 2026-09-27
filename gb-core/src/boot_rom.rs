/// SameBoy's open-source boot ROMs (Lior Halphon, Expat/MIT licence, v1.0.3, built from
/// BootROMs/*.asm with rgbds; tag, source and SHA-256 in THIRD_PARTY_NOTICES.md). They are
/// original code: the logo they show is read from the cartridge header at $0104, and neither
/// binary contains Nintendo's boot ROM or its logo bytes. `GameBoy::with_boot` runs them.
pub static SAMEBOY_DMG: &[u8; 0x100] = include_bytes!("../boot/sameboy_dmg_boot.bin");
/// Mapped at $0000-$00FF and $0200-$08FF (the cartridge header shows through at $0100-$01FF).
pub static SAMEBOY_CGB: &[u8; 0x900] = include_bytes!("../boot/sameboy_cgb_boot.bin");

/// Original minimal DMG boot stub (256 bytes), written for Cartouche.
///
/// Cartouche does not ship, embed or reproduce Nintendo's boot ROM (its code,
/// its logo animation, or the 48-byte logo bitmap). `GameBoy::new` maps this
/// stub (the test suites run from it); the web app uses `GameBoy::with_boot`.
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
