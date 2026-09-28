//! CGB infrared port (RP, $FF56): the register alone, and light between two linked consoles.

use gb_core::gameboy::{run_linked_frame, GameBoy};

/// Waits: `CALL SLOT` burns 256 x 16 cycles, `CALL HALF` half of that.
const SLOT: [u8; 3] = [0xCD, 0x00, 0x03];
const HALF: [u8; 3] = [0xCD, 0x10, 0x03];

/// A console running `code` from $0150 (then `JR -2`); `cgb` sets the header's Color flag.
fn console(code: &[u8], cgb: bool) -> GameBoy {
    cart(code, cgb, 0x00)
}

/// `console` with the cartridge type byte ($147) set to `kind`.
fn cart(code: &[u8], cgb: bool, kind: u8) -> GameBoy {
    let mut r = vec![0u8; 0x8000];
    r[0x100..0x103].copy_from_slice(&[0xC3, 0x50, 0x01]); // JP $0150
    r[0x150..0x150 + code.len()].copy_from_slice(code);
    r[0x150 + code.len()..0x152 + code.len()].copy_from_slice(&[0x18, 0xFE]);
    // LD B,n; DEC B; JR NZ,-3; RET
    r[0x300..0x306].copy_from_slice(&[0x06, 0x00, 0x05, 0x20, 0xFD, 0xC9]);
    r[0x310..0x316].copy_from_slice(&[0x06, 0x80, 0x05, 0x20, 0xFD, 0xC9]);
    r[0x143] = if cgb { 0xC0 } else { 0x00 };
    r[0x147] = kind;
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

#[test]
fn a_console_running_alone_again_sees_no_light() {
    let mut a = console(&[0x3E, 0xC1, 0xE0, 0x56], true); // LED on for good
    let mut b = console(&[0x3E, 0xC0, 0xE0, 0x56], true); // reading enabled
    run_linked_frame(&mut a, &mut b).unwrap();
    assert_eq!(b.bus.read_byte(0xFF56) & 2, 0, "linked: light seen");
    b.run_frame().unwrap();
    assert_eq!(b.bus.read_byte(0xFF56) & 2, 2, "alone: dark");
}

#[test]
fn a_save_state_keeps_the_led_and_an_older_state_still_loads() {
    let mut gb = console(&[], true);
    gb.bus.write_byte(0xFF56, 0xC1);
    let state = gb.save_state();

    let mut fresh = console(&[], true);
    assert!(fresh.load_state(&state));
    assert_eq!(fresh.bus.read_byte(0xFF56), 0xFF, "LED on and reading enabled after a load");

    // A state from before RP: the same bytes without the last six (RP, the mode-3 length, the speed switch).
    let mut older = console(&[], true);
    assert!(older.load_state(&state[..state.len() - 6]));
    assert_eq!(older.bus.read_byte(0xFF56), 0x3E, "RP starts off");
}

const HUC1: u8 = 0xFF;
const HUC3: u8 = 0xFE;
/// LD A,$0E; LD ($0000),A: HuC1 IR mode, HuC3 mode $E (A000-BFFF is the IR port).
const IR_MODE: [u8; 5] = [0x3E, 0x0E, 0xEA, 0x00, 0x00];
const PATTERN: [u8; 8] = [1, 0, 1, 1, 0, 0, 1, 0];

/// A HuC sender: one slot per bit of `pattern`, the cartridge LED on for a 1.
fn huc_sender(kind: u8, pattern: &[u8]) -> GameBoy {
    let mut code = IR_MODE.to_vec();
    for &bit in pattern {
        code.extend([0x3E, bit, 0xEA, 0x00, 0xA0]); // LD A,bit; LD ($A000),A
        code.extend(SLOT);
    }
    code.extend([0xAF, 0xEA, 0x00, 0xA0]); // LED off
    cart(&code, false, kind)
}

/// A HuC receiver: samples its IR port into $C000.. at the middle of each sender slot.
fn huc_receiver(kind: u8, samples: usize) -> GameBoy {
    let mut code = IR_MODE.to_vec();
    code.extend([0x21, 0x00, 0xC0]); // LD HL,$C000
    code.extend(HALF);
    for _ in 0..samples {
        code.extend([0xFA, 0x00, 0xA0, 0x22]); // LD A,($A000); LD (HL+),A
        code.extend(SLOT);
    }
    cart(&code, false, kind)
}

fn linked(mut a: GameBoy, mut b: GameBoy) -> Vec<u8> {
    for _ in 0..2 {
        run_linked_frame(&mut a, &mut b).unwrap();
    }
    (0..8).map(|i| b.bus.read_byte(0xC000 + i)).collect()
}

/// `PATTERN` as a HuC IR port reads it: $C1 while the light is seen.
fn huc_seen() -> Vec<u8> {
    PATTERN.iter().map(|&b| 0xC0 | b).collect()
}

#[test]
fn a_huc1_receiver_sees_a_linked_huc1_led() {
    assert_eq!(linked(huc_sender(HUC1, &PATTERN), huc_receiver(HUC1, 8)), huc_seen());
}

#[test]
fn a_huc3_receiver_sees_a_linked_huc3_led() {
    assert_eq!(linked(huc_sender(HUC3, &PATTERN), huc_receiver(HUC3, 8)), huc_seen());
}

#[test]
fn a_huc1_led_and_a_cgb_rp_see_each_other() {
    assert_eq!(linked(huc_sender(HUC1, &PATTERN), receiver(0xC0, 8)), [0, 2, 0, 0, 2, 2, 0, 2], "RP sees the cartridge");
    assert_eq!(linked(sender(&PATTERN), huc_receiver(HUC1, 8)), huc_seen(), "the cartridge sees RP");
}

#[test]
fn a_save_state_keeps_the_huc_led_and_an_older_state_still_loads() {
    for kind in [HUC1, HUC3] {
        // LED on, then back to RAM mode: leaving IR mode keeps the LED lit.
        let mut gb = cart(&[], false, kind);
        gb.bus.write_byte(0x0000, 0x0E);
        gb.bus.write_byte(0xA000, 0x01);
        gb.bus.write_byte(0x0000, 0x00);
        assert!(gb.bus.ir_led(), "{kind:02X}: LED on in RAM mode");
        let state = gb.save_state();

        let mut fresh = cart(&[], false, kind);
        assert!(fresh.load_state(&state));
        assert!(fresh.bus.ir_led(), "{kind:02X}: LED on after a load");

        // A state from before the LED byte: its mapper block one byte shorter.
        let extra = gb.bus.cartridge.export_extra().len();
        let tail = 4 + 1 + 4; // after the mapper block: the timing tail, RP, the mode-3 length
        let at = state.len() - tail - extra - 2;
        let mut old = state[..at].to_vec();
        old.extend(((extra - 1) as u16).to_le_bytes());
        old.extend(&state[at + 2..state.len() - tail - 1]);
        old.extend(&state[state.len() - tail..]);
        let mut older = cart(&[], false, kind);
        assert!(older.load_state(&old));
        assert!(!older.bus.ir_led(), "{kind:02X}: LED off from an older state");
    }
}
