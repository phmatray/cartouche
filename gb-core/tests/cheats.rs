// Cheat codes on synthetic ROMs. Expected values come from the worked examples in the public
// format descriptions (#137), never from the decoder under test.
use gb_core::cheats::{parse, Cheat};
use gb_core::gameboy::GameBoy;

fn rom(byte_2b4: u8) -> Vec<u8> {
    let mut r = vec![0u8; 0x8000];
    r[0x100..0x102].copy_from_slice(&[0x18, 0xFE]); // JR -2
    r[0x147] = 0x00; // ROM only
    r[0x2B4] = byte_2b4;
    r[0x14D] = (0x134..=0x14C).fold(0u8, |c, i| c.wrapping_sub(r[i]).wrapping_sub(1));
    r
}

fn with(byte_2b4: u8, codes: &[&str]) -> GameBoy {
    let mut gb = GameBoy::new(rom(byte_2b4)).unwrap();
    gb.bus.cheats.set(codes.iter().map(|c| parse(c).unwrap()).collect());
    gb
}

#[test]
fn game_genie_six_digits_always_patches() {
    assert_eq!(with(0x01, &[]).bus.read_byte(0x02B4), 0x01);
    assert_eq!(with(0x01, &["3E2-B4F"]).bus.read_byte(0x02B4), 0x3E);
    assert_eq!(with(0x02, &["3e2b4f"]).bus.read_byte(0x02B4), 0x3E);
}

#[test]
fn game_genie_nine_digits_patches_only_on_compare() {
    assert_eq!(with(0x01, &["3E2-B4F-E6E"]).bus.read_byte(0x02B4), 0x3E);
    assert_eq!(with(0x02, &["3E2-B4F-E6E"]).bus.read_byte(0x02B4), 0x02);
}

#[test]
fn gameshark_rewrites_ram_every_frame() {
    let mut gb = with(0x01, &["01FF34C1"]);
    gb.run_frame().unwrap();
    assert_eq!(gb.bus.read_byte(0xC134), 0xFF);
    gb.bus.write_byte(0xC134, 0x00);
    gb.run_frame().unwrap();
    assert_eq!(gb.bus.read_byte(0xC134), 0xFF);
}

#[test]
fn parse_decodes_the_worked_examples() {
    assert_eq!(parse("3E2-B4F-E6E"), Ok(Cheat::Rom { addr: 0x02B4, value: 0x3E, compare: Some(0x01) }));
    assert_eq!(parse("01FF34C1"), Ok(Cheat::Ram { addr: 0xC134, value: 0xFF, bank: None }));
    assert_eq!(parse("91FF34D1"), Ok(Cheat::Ram { addr: 0xD134, value: 0xFF, bank: Some(1) }));
    assert_eq!(parse("90FF34D1"), Ok(Cheat::Ram { addr: 0xD134, value: 0xFF, bank: Some(1) }), "bank 0 means 1");
}

#[test]
fn parse_refuses_bad_codes() {
    assert!(parse("ZZZ").is_err());
    assert!(parse("3E2-B47").is_err(), "d5 = 7 puts the address at $82B4, outside ROM");
    assert!(parse("02FF34C1").is_err(), "type 02 is unsupported");
    assert!(parse("01FF3412").is_err(), "$1234 is an MBC register, not RAM");
}

#[test]
fn set_cheats_is_all_or_nothing() {
    let mut emu = gb_core::Emulator::new();
    assert!(emu.load_rom(&rom(0x01)));
    assert!(emu.set_cheats("3E2-B4F"));
    assert_eq!(emu.read_memory(0x02B4), 0x3E);

    assert!(!emu.set_cheats("3E2-B4F\nZZZ"));
    assert!(emu.get_error().unwrap().contains("ZZZ"));
    assert_eq!(emu.read_memory(0x02B4), 0x3E, "the previous set still applies");

    assert!(!emu.set_cheats("91FF34D1"), "bank codes on a DMG game");
    assert!(emu.get_error().unwrap().contains("Game Boy Color"));

    assert!(emu.set_cheats(""));
    assert_eq!(emu.read_memory(0x02B4), 0x01);
}
