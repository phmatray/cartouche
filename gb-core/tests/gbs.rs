//! GBS (Game Boy Sound System) files: the header parser, the synthetic cartridge that plays them,
//! and playback on the unchanged emulator. The GBS is assembled byte by byte here: no music file
//! from anywhere.

use gb_core::cartridge::Cartridge;
use gb_core::gbs::{parse_header, to_rom, GbsError};

/// A 3-song GBS loaded at $0400. Init ($0400) stores A at $C000 and starts a square-wave note on
/// channel 1; play ($0420) increments $C001.
fn synthetic_gbs(tac: u8, tma: u8) -> Vec<u8> {
    let mut g = vec![0u8; 0x70];
    g[0..3].copy_from_slice(b"GBS");
    g[3] = 1; // version
    g[4] = 3; // songs
    g[5] = 1; // first song (1-based)
    g[6..8].copy_from_slice(&0x0400u16.to_le_bytes()); // load
    g[8..10].copy_from_slice(&0x0400u16.to_le_bytes()); // init
    g[10..12].copy_from_slice(&0x0420u16.to_le_bytes()); // play
    g[12..14].copy_from_slice(&0xDFFFu16.to_le_bytes()); // stack pointer
    g[14] = tma;
    g[15] = tac;
    g[0x10..0x14].copy_from_slice(b"Test");
    g[0x30..0x39].copy_from_slice(b"Cartouche");
    let init = [
        0xEA, 0x00, 0xC0, // LD [$C000], A
        0x3E, 0x80, 0xE0, 0x26, // LD A,$80 ; LDH [$26],A   sound on
        0x3E, 0x77, 0xE0, 0x24, // LD A,$77 ; LDH [$24],A   full volume
        0x3E, 0xFF, 0xE0, 0x25, // LD A,$FF ; LDH [$25],A   every channel to both sides
        0x3E, 0xF0, 0xE0, 0x12, // LD A,$F0 ; LDH [$12],A   channel 1 envelope
        0x3E, 0x87, 0xE0, 0x14, // LD A,$87 ; LDH [$14],A   trigger
        0xC9, // RET
    ];
    let mut code = vec![0u8; 0x30];
    code[..init.len()].copy_from_slice(&init);
    code[0x20..0x25].copy_from_slice(&[0x21, 0x01, 0xC0, 0x34, 0xC9]); // LD HL,$C001 ; INC [HL] ; RET
    g.extend_from_slice(&code);
    g
}

#[test]
fn parse_header_reads_the_fields() {
    let h = parse_header(&synthetic_gbs(0, 0)).unwrap();
    assert_eq!((h.songs, h.first), (3, 1));
    assert_eq!((h.load, h.init, h.play, h.sp), (0x0400, 0x0400, 0x0420, 0xDFFF));
    assert_eq!((h.title.as_str(), h.author.as_str(), h.copyright.as_str()), ("Test", "Cartouche", ""));
}

#[test]
fn parse_header_rejects_bad_files_each_with_its_own_error() {
    let mut magic = synthetic_gbs(0, 0);
    magic[0] = b'X';
    assert!(matches!(parse_header(&magic), Err(GbsError::BadMagic)));

    let mut v2 = synthetic_gbs(0, 0);
    v2[3] = 2;
    assert!(matches!(parse_header(&v2), Err(GbsError::UnsupportedVersion(2))));

    let mut none = synthetic_gbs(0, 0);
    none[4] = 0;
    assert!(matches!(parse_header(&none), Err(GbsError::NoSongs)));

    let mut low = synthetic_gbs(0, 0);
    low[6..8].copy_from_slice(&0x0200u16.to_le_bytes());
    assert!(matches!(parse_header(&low), Err(GbsError::BadLoadAddress(0x0200))));

    assert!(matches!(parse_header(&synthetic_gbs(0, 0)[..0x70]), Err(GbsError::TooSmall)));
}

#[test]
fn to_rom_builds_a_valid_cartridge_without_the_logo() {
    let rom = to_rom(&synthetic_gbs(0, 0), 0).unwrap();
    assert_eq!(rom.len(), 0x8000);
    assert!(rom[0x104..0x134].iter().all(|&b| b == 0));
    assert_eq!(&rom[0x400..0x403], &[0xEA, 0x00, 0xC0]); // the data sits at `load`
    Cartridge::from_rom(rom).unwrap();
}

#[test]
fn to_rom_rejects_a_track_past_the_last_song() {
    assert!(matches!(to_rom(&synthetic_gbs(0, 0), 3), Err(GbsError::TrackOutOfRange { track: 3, songs: 3 })));
}

// ─── Playback on the emulator ───

use gb_core::Emulator;

fn play(gbs: &[u8], track: u8, frames: usize) -> Emulator {
    let mut emu = Emulator::new();
    assert!(emu.load_gbs(gbs, track), "{:?}", emu.get_error());
    for _ in 0..frames {
        emu.run_frame();
    }
    emu
}

#[test]
fn vblank_mode_calls_init_with_the_track_then_play_every_frame() {
    let emu = play(&synthetic_gbs(0, 0), 1, 60);
    assert_eq!(emu.read_memory(0xC000), 1);
    let calls = emu.read_memory(0xC001);
    assert!((59..=61).contains(&calls), "play ran {calls} times");
}

#[test]
fn timer_mode_calls_play_at_the_tma_tac_rate() {
    // TAC $04 = 4096 Hz, TMA $C0 = 64 ticks per overflow → 64 Hz.
    let emu = play(&synthetic_gbs(0x04, 0xC0), 0, 60);
    let calls = emu.read_memory(0xC001);
    assert!((63..=65).contains(&calls), "play ran {calls} times");
}

#[test]
fn init_starts_a_note_that_reaches_the_audio_buffer() {
    let mut emu = play(&synthetic_gbs(0, 0), 0, 10);
    let n = emu.drain_audio();
    let samples = unsafe { std::slice::from_raw_parts(emu.audio_buffer_ptr(), n) };
    assert!(samples.iter().any(|&s| s != 0.0));
}

#[test]
fn load_gbs_rejects_a_non_gbs_file_with_an_error() {
    let mut emu = Emulator::new();
    assert!(!emu.load_gbs(b"nope", 0));
    assert!(emu.get_error().is_some());
}
