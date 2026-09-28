//! CGB infrared port (RP, $FF56): the register alone, and light between two linked consoles.

use gb_core::gameboy::GameBoy;

/// A console running `code` from $0100 (then `JR -2`); `cgb` sets the header's Color flag.
fn console(code: &[u8], cgb: bool) -> GameBoy {
    let mut r = vec![0u8; 0x8000];
    r[0x100..0x100 + code.len()].copy_from_slice(code);
    r[0x100 + code.len()..0x102 + code.len()].copy_from_slice(&[0x18, 0xFE]);
    r[0x143] = if cgb { 0xC0 } else { 0x00 };
    r[0x14D] = (0x134..=0x14C).fold(0u8, |c, i| c.wrapping_sub(r[i]).wrapping_sub(1));
    let mut gb = GameBoy::new(r).unwrap();
    gb.skip_boot_rom();
    gb
}

#[test]
fn rp_alone_reads_its_led_and_no_light() {
    let mut gb = console(&[], true);
    gb.bus.write_byte(0xFF56, 0xC1);
    assert_eq!(gb.bus.read_byte(0xFF56), 0xFF, "LED on, read enabled, no light seen");
    gb.bus.write_byte(0xFF56, 0x00);
    assert_eq!(gb.bus.read_byte(0xFF56), 0x3E, "LED off, read disabled");
}

#[test]
fn rp_is_unmapped_in_dmg_mode() {
    let mut gb = console(&[], false);
    for v in [0x00, 0xC1] {
        gb.bus.write_byte(0xFF56, v);
        assert_eq!(gb.bus.read_byte(0xFF56), 0xFF);
    }
}
