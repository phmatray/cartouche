use crate::gameboy::Console;

/// Cartouche's boot ROMs, built from `gb-core/boot-src/cartouche_boot.asm` (a fork of SameBoy's, Expat/MIT; its
/// `build.sh` rebuilds these byte for byte, and the guard pins their hashes). Each plays one of three original
/// start-up animations, 1 Registration, 2 Insert, 3 Shelf pick; none reads, shows or checks the cartridge's
/// logo, and none contains Nintendo's boot ROM or its logo bytes. Mapped at $0000-$00FF and $0200 to their end
/// ($0AFF): the cartridge header shows through at $0100-$01FF.
static DMG: [&[u8]; 3] = [
    include_bytes!("../boot/dmg_registration.bin"),
    include_bytes!("../boot/dmg_insert.bin"),
    include_bytes!("../boot/dmg_shelf.bin"),
];
static CGB: [&[u8]; 3] = [
    include_bytes!("../boot/cgb_registration.bin"),
    include_bytes!("../boot/cgb_insert.bin"),
    include_bytes!("../boot/cgb_shelf.bin"),
];
/// Super Game Boy: the DMG animation, then the cartridge header to the SNES side as packets, like the original.
static SGB: [&[u8]; 3] = [
    include_bytes!("../boot/sgb_registration.bin"),
    include_bytes!("../boot/sgb_insert.bin"),
    include_bytes!("../boot/sgb_shelf.bin"),
];
/// The CGB boot with no animation: it sets the machine up and colourises an original cartridge, run unseen.
static CGB_PLAIN: &[u8] = include_bytes!("../boot/cgb_plain.bin");

/// The boot ROM `console` runs for start-up `animation` (0 none, 1-3 as above). Without an animation a CGB runs
/// the plain one and a DMG or SGB the stub below (both usually skipped: `GameBoy::with_boot`).
pub fn image(console: Console, animation: u8) -> &'static [u8] {
    let (set, none): (&[&[u8]; 3], &'static [u8]) = match console {
        Console::Dmg => (&DMG, &DMG_BOOT_ROM),
        Console::Sgb => (&SGB, &DMG_BOOT_ROM),
        Console::Cgb | Console::Compat => (&CGB, CGB_PLAIN),
    };
    match animation {
        1..=3 => set[animation as usize - 1],
        _ => none,
    }
}

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
    use super::*;

    #[test]
    fn stub_is_tiny_and_unmaps_itself() {
        let used = DMG_BOOT_ROM.iter().filter(|&&b| b != 0).count();
        assert_eq!(used, 9); // 9 non-zero bytes; $0005 is the JP high byte (0x00)
        assert_eq!(&DMG_BOOT_ROM[0xFC..], &[0x3E, 0x01, 0xE0, 0x50]);
    }

    #[test]
    fn every_image_hands_over_through_ff50() {
        for c in [Console::Dmg, Console::Cgb, Console::Compat, Console::Sgb] {
            for a in 0..=3 {
                let rom = image(c, a);
                assert_eq!(&rom[0xFE..0x100], &[0xE0, 0x50], "{c:?} {a}");
                assert!(rom.len() == 0x100 || rom.len() == 0xB00);
            }
        }
    }
}
