//! CGB infrared port (RP, $FF56): the register alone, and light between two linked consoles.

use gb_core::gameboy::{run_linked_frame, GameBoy};

/// Waits: `CALL SLOT` burns 256 x 16 cycles, `CALL HALF` half of that.
const SLOT: [u8; 3] = [0xCD, 0x00, 0x03];
const HALF: [u8; 3] = [0xCD, 0x10, 0x03];

/// A console running `code` from $0150 (then `JR -2`); `cgb` sets the header's Color flag.
fn console(code: &[u8], cgb: bool) -> GameBoy {
    let mut r = vec![0u8; 0x8000];
    r[0x100..0x103].copy_from_slice(&[0xC3, 0x50, 0x01]); // JP $0150
    r[0x150..0x150 + code.len()].copy_from_slice(code);
    r[0x150 + code.len()..0x152 + code.len()].copy_from_slice(&[0x18, 0xFE]);
    // LD B,n; DEC B; JR NZ,-3; RET
    r[0x300..0x306].copy_from_slice(&[0x06, 0x00, 0x05, 0x20, 0xFD, 0xC9]);
    r[0x310..0x316].copy_from_slice(&[0x06, 0x80, 0x05, 0x20, 0xFD, 0xC9]);
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

/// Sender: one slot per bit of `pattern`, LED on for a 1 (reading enabled either way).
fn sender(pattern: &[u8]) -> GameBoy {
    let mut code = vec![];
    for &bit in pattern {
        code.extend([0x3E, 0xC0 | bit, 0xE0, 0x56]); // LD A,$C0|bit; LDH ($56),A
        code.extend(SLOT);
    }
    code.extend([0x3E, 0xC0, 0xE0, 0x56]); // LED off
    console(&code, true)
}

/// Receiver: writes `rp`, then samples RP bit 1 into $C000.. at the middle of each sender slot.
fn receiver(rp: u8, samples: usize) -> GameBoy {
    let mut code = vec![0x3E, rp, 0xE0, 0x56, 0x21, 0x00, 0xC0]; // LD A,rp; LDH ($56),A; LD HL,$C000
    code.extend(HALF);
    for _ in 0..samples {
        code.extend([0xF0, 0x56, 0xE6, 0x02, 0x22]); // LDH A,($56); AND 2; LD (HL+),A
        code.extend(SLOT);
    }
    console(&code, true)
}

fn samples(rp: u8) -> Vec<u8> {
    let pattern = [1, 0, 1, 1, 0, 0, 1, 0];
    let (mut a, mut b) = (sender(&pattern), receiver(rp, pattern.len()));
    for _ in 0..2 {
        run_linked_frame(&mut a, &mut b).unwrap();
    }
    (0..8).map(|i| b.bus.read_byte(0xC000 + i)).collect()
}

#[test]
fn a_linked_receiver_sees_the_partners_led() {
    assert_eq!(samples(0xC0), [0, 2, 0, 0, 2, 2, 0, 2]);
}

#[test]
fn a_receiver_with_reading_disabled_sees_nothing() {
    assert_eq!(samples(0x00), [2; 8]);
}
