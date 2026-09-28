//! Deterministic sessions: with an emulated clock, a console is a pure function of its ROM, battery
//! save, clock seed and inputs (the lockstep and rollback link modes, #151), on synthetic ROMs.

use gb_core::gameboy::GameBoy;

/// An MBC3+TIMER+RAM+BATTERY ROM that, forever: latches the clock and copies its seconds register
/// to $C000, then copies the joypad's button row to $C001.
fn clock_rom() -> Vec<u8> {
    let mut r = vec![0u8; 0x8000];
    r[0x100..0x104].copy_from_slice(&[0x00, 0xC3, 0x50, 0x01]); // NOP; JP $0150
    r[0x147] = 0x10;
    r[0x149] = 0x02; // 8 KB
    let code = [
        0x3E, 0x0A, 0xEA, 0x00, 0x00, // LD A,$0A; LD ($0000),A   RAM and clock on
        0x3E, 0x08, 0xEA, 0x00, 0x40, // LD A,$08; LD ($4000),A   select S
        // loop:
        0xAF, 0xEA, 0x00, 0x60, // XOR A; LD ($6000),A
        0x3C, 0xEA, 0x00, 0x60, // INC A; LD ($6000),A          latch
        0xFA, 0x00, 0xA0, 0xEA, 0x00, 0xC0, // LD A,($A000); LD ($C000),A
        0x3E, 0x10, 0xE0, 0x00, // LD A,$10; LDH ($00),A        buttons
        0xF0, 0x00, 0xEA, 0x01, 0xC0, // LDH A,($00); LD ($C001),A
        0x18, 0xE5, // JR loop
    ];
    r[0x150..0x150 + code.len()].copy_from_slice(&code);
    r[0x14D] = (0x134..=0x14C).fold(0u8, |c, i| c.wrapping_sub(r[i]).wrapping_sub(1));
    r
}

fn console(seed: Option<f64>) -> GameBoy {
    let mut gb = GameBoy::new(clock_rom()).unwrap();
    gb.skip_boot_rom();
    if let Some(s) = seed { gb.set_emulated_clock(s); }
    gb
}

/// AC2: the clock counts emulated time — 598 frames are ten seconds — however long the host takes.
#[test]
fn the_clock_reads_ten_seconds_after_598_frames() {
    let mut gb = console(Some(0.0));
    for _ in 0..598 { gb.run_frame().unwrap(); }
    assert_eq!(gb.bus.read_byte(0xC000), 10);
}

/// With the same seed, two consoles write the same battery save, clock stamp included, even when
/// the host is slow, and a save loaded into both catches up the same seed-relative time.
#[test]
fn an_emulated_clock_stamps_the_same_battery_save_everywhere() {
    let (mut a, mut b) = (console(Some(1_000_000.0)), console(Some(1_000_000.0)));
    for _ in 0..240 { a.run_frame().unwrap(); }
    std::thread::sleep(std::time::Duration::from_millis(1100));
    for _ in 0..240 { b.run_frame().unwrap(); }
    let sav = a.bus.cartridge.export_sram();
    assert_eq!(sav, b.bus.cartridge.export_sram());
    let stamp = u64::from_le_bytes(sav[sav.len() - 8..].try_into().unwrap());
    assert_eq!(stamp, 1_000_004, "the seed plus the 4 emulated seconds");

    let (mut c, mut d) = (console(Some(1_000_100.0)), console(Some(1_000_100.0)));
    c.bus.cartridge.import_sram(&sav);
    std::thread::sleep(std::time::Duration::from_millis(1100));
    d.bus.cartridge.import_sram(&sav);
    assert_eq!(c.bus.cartridge.export_sram(), d.bus.cartridge.export_sram());
}

/// Two consoles joined by the cable, both on the same emulated clock.
fn pair() -> (GameBoy, GameBoy) {
    (console(Some(1_700_000_000.0)), console(Some(1_700_000_000.0)))
}

/// Presses the buttons whose bits are set in `mask` (bit 0 = A … bit 7 = Down), releases the rest.
fn press(gb: &mut GameBoy, mask: u8) {
    use gb_core::joypad::JoypadButton::*;
    for (i, b) in [A, B, Select, Start, Right, Left, Up, Down].into_iter().enumerate() {
        gb.bus.joypad.set_button(b, mask >> i & 1 != 0);
    }
}

/// AC1: two independently built sessions fed one input log agree frame by frame, whatever the
/// host's timing between frames.
#[test]
fn two_linked_sessions_fed_the_same_inputs_hash_the_same_every_frame() {
    let log: Vec<u8> = (0..600).map(|i| [0x00, 0x01, 0x10, 0x81][i % 4]).collect();
    let (mut a1, mut b1) = pair();
    std::thread::sleep(std::time::Duration::from_millis(1100)); // the other machine, a second later
    let (mut a2, mut b2) = pair();
    for (frame, &mask) in log.iter().enumerate() {
        if frame % 100 == 0 { std::thread::sleep(std::time::Duration::from_millis(20)); }
        for gb in [&mut a1, &mut a2] { press(gb, mask); }
        for gb in [&mut b1, &mut b2] { press(gb, !mask); }
        gb_core::gameboy::run_linked_frame(&mut a1, &mut b1).unwrap();
        gb_core::gameboy::run_linked_frame(&mut a2, &mut b2).unwrap();
        assert_eq!((a1.state_hash(), b1.state_hash()), (a2.state_hash(), b2.state_hash()), "frame {frame}");
    }
    assert_ne!(a1.state_hash(), b1.state_hash(), "the two sides saw different inputs");
    assert_eq!(a1.bus.read_byte(0xC000), 10, "and their clocks ran");
}

/// AC4: loading a console's own state back changes nothing its hash can see.
#[test]
fn a_state_loaded_back_hashes_the_same() {
    let mut gb = console(Some(1_700_000_000.0));
    for _ in 0..300 { gb.run_frame().unwrap(); }
    let before = gb.state_hash();
    assert!(gb.load_state(&gb.save_state()));
    assert_eq!(gb.state_hash(), before);
}
