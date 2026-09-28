//! Super Game Boy: command packets sent over P1 bit by bit, as a cartridge does, and what the
//! picture becomes. Synthetic ROM and data only: no external files needed.

use gb_core::gameboy::{Console, GameBoy};

/// 32 KB DMG-only ROM with SGB support that loops at $0100, valid header checksum.
fn sgb_rom() -> Vec<u8> {
    let mut r = vec![0u8; 0x8000];
    r[0x100..0x104].copy_from_slice(&[0x00, 0x18, 0xFE, 0x00]); // NOP; JR -2
    r[0x134..0x13D].copy_from_slice(b"CARTOUCHE");
    r[0x146] = 0x03;
    r[0x14B] = 0x33;
    r[0x14D] = (0x134..=0x14C).fold(0u8, |c, i| c.wrapping_sub(r[i]).wrapping_sub(1));
    r
}

fn sgb() -> GameBoy {
    let mut gb = GameBoy::with_sgb(sgb_rom(), 0).unwrap();
    assert_eq!(gb.console, Console::Sgb);
    // Tile 1: shade 3 everywhere; the map shows tile 0 (shade 0), BGP identity.
    for i in 0..16 { gb.bus.write_byte(0x8010 + i, 0xFF); }
    gb.bus.write_byte(0xFF47, 0xE4);
    gb
}

/// Sends one command (1-7 packets of 16 bytes, `data` zero-padded) the way games do.
fn send(gb: &mut GameBoy, cmd: u8, data: &[u8]) {
    for p in command(cmd, data).chunks(16) { send_packet(gb, p); }
}

fn command(cmd: u8, data: &[u8]) -> Vec<u8> {
    let packets = (data.len() + 1).div_ceil(16).max(1);
    let mut bytes = vec![0u8; packets * 16];
    bytes[0] = cmd << 3 | packets as u8;
    bytes[1..=data.len()].copy_from_slice(data);
    bytes
}

fn send_packet(gb: &mut GameBoy, p: &[u8]) {
    gb.bus.write_byte(0xFF00, 0x00);
    gb.bus.write_byte(0xFF00, 0x30);
    for i in 0..128 {
        gb.bus.write_byte(0xFF00, if p[i / 8] >> (i % 8) & 1 != 0 { 0x10 } else { 0x20 });
        gb.bus.write_byte(0xFF00, 0x30);
    }
    gb.bus.write_byte(0xFF00, 0x20); // stop bit
    gb.bus.write_byte(0xFF00, 0x30);
}

fn rgb(c: u16) -> [u8; 4] {
    let f = |s: u16| ((s & 0x1F) * 255 / 31) as u8;
    [f(c), f(c >> 5), f(c >> 10), 0xFF]
}

fn px(gb: &GameBoy, x: usize, y: usize) -> [u8; 4] {
    let o = (y * 160 + x) * 4;
    gb.screen()[o..o + 4].try_into().unwrap()
}

fn frame(gb: &mut GameBoy) {
    gb.run_frame().unwrap();
    gb.run_frame().unwrap();
}

/// Shows shade 3 on cell (x, y) of the map, shade 0 elsewhere.
fn dark_cell(gb: &mut GameBoy, x: u16, y: u16) {
    gb.bus.write_byte(0x9800 + y * 32 + x, 1);
}

const RED: u16 = 0x001F;
const GREEN: u16 = 0x03E0;
const BLUE: u16 = 0x7C00;
const WHITE: u16 = 0x7FFF;

/// PAL01 with colour 0 white and colour 3 of palette 0 / palette 1.
fn pal01(gb: &mut GameBoy, c3a: u16, c3b: u16) {
    let mut d = [0u8; 14];
    d[0..2].copy_from_slice(&WHITE.to_le_bytes());
    d[6..8].copy_from_slice(&c3a.to_le_bytes());
    d[12..14].copy_from_slice(&c3b.to_le_bytes());
    send(gb, 0x00, &d);
}

#[test]
fn pal01_colours_the_picture() {
    let mut gb = sgb();
    dark_cell(&mut gb, 0, 0);
    pal01(&mut gb, RED, GREEN);
    frame(&mut gb);
    assert_eq!(px(&gb, 0, 0), rgb(RED), "shade 3 in palette 0");
    assert_eq!(px(&gb, 8, 0), rgb(WHITE), "shade 0 is the shared colour 0");
}

#[test]
fn attr_blk_inside_border_outside() {
    let mut gb = sgb();
    for y in 0..18 { for x in 0..20 { dark_cell(&mut gb, x, y); } }
    pal01(&mut gb, RED, GREEN);
    let mut d = [0u8; 12];
    d[0] = 1; // one data set: inside only (the line follows), palette 1, cells (2,2)-(5,5)
    d[1..7].copy_from_slice(&[0x01, 0x01, 2, 2, 5, 5]);
    send(&mut gb, 0x04, &d);
    frame(&mut gb);
    assert_eq!(px(&gb, 3 * 8, 3 * 8), rgb(GREEN), "inside");
    assert_eq!(px(&gb, 2 * 8, 2 * 8), rgb(GREEN), "the surrounding line takes the inside palette");
    assert_eq!(px(&gb, 6 * 8, 6 * 8), rgb(RED), "outside unchanged");

    // Outside only, palette 1: everything but the inside (and the line) turns green.
    send(&mut gb, 0x04, &[1, 0x04, 0x10, 0, 0, 3, 3]);
    frame(&mut gb);
    assert_eq!(px(&gb, 19 * 8, 17 * 8), rgb(GREEN));
    assert_eq!(px(&gb, 3 * 8, 0), rgb(GREEN), "line = outside palette");
}

#[test]
fn attr_lin_div_chr() {
    let mut gb = sgb();
    for y in 0..18 { for x in 0..20 { dark_cell(&mut gb, x, y); } }
    let mut d = [0u8; 14];
    d[0..2].copy_from_slice(&WHITE.to_le_bytes());
    d[6..8].copy_from_slice(&RED.to_le_bytes());
    d[12..14].copy_from_slice(&GREEN.to_le_bytes());
    send(&mut gb, 0x00, &d); // PAL01: palette 0 red, palette 1 green
    d[6..8].copy_from_slice(&BLUE.to_le_bytes());
    d[12..14].copy_from_slice(&WHITE.to_le_bytes());
    send(&mut gb, 0x01, &d); // PAL23: palette 2 blue, palette 3 white

    // ATTR_DIV: split at column 10 (vertical line): left palette 1, line 2, right 0.
    send(&mut gb, 0x06, &[0x01 << 2 | 0x02 << 4, 10]);
    frame(&mut gb);
    assert_eq!(px(&gb, 9 * 8, 0), rgb(GREEN));
    assert_eq!(px(&gb, 10 * 8, 0), rgb(BLUE));
    assert_eq!(px(&gb, 11 * 8, 0), rgb(RED));

    // ATTR_LIN: row 4 palette 2 (horizontal), column 0 palette 1.
    send(&mut gb, 0x05, &[2, 0x80 | 2 << 5 | 4, 1 << 5]);
    frame(&mut gb);
    assert_eq!(px(&gb, 15 * 8, 4 * 8), rgb(BLUE));
    assert_eq!(px(&gb, 0, 17 * 8), rgb(GREEN));

    // ATTR_CHR from (19, 0) left to right: 3 cells wrapping onto the next row.
    send(&mut gb, 0x07, &[19, 0, 3, 0, 0, 0b10_01_10_00]);
    frame(&mut gb);
    assert_eq!(px(&gb, 19 * 8, 0), rgb(BLUE));
    assert_eq!(px(&gb, 0, 8), rgb(GREEN));
    assert_eq!(px(&gb, 8, 8), rgb(BLUE));
}

#[test]
fn mask_en_black_then_off() {
    let mut gb = sgb();
    pal01(&mut gb, RED, GREEN);
    send(&mut gb, 0x17, &[2]);
    frame(&mut gb);
    assert_eq!(px(&gb, 0, 0), [0, 0, 0, 0xFF]);
    send(&mut gb, 0x17, &[0]);
    frame(&mut gb);
    assert_eq!(px(&gb, 0, 0), rgb(WHITE));
}

#[test]
fn snes_music_is_sou_trn_then_game_boy_channels_off() {
    // `frame` runs two frames.
    let music = |gb: &GameBoy| gb.bus.sgb.as_ref().unwrap().snes_music();
    let mut gb = sgb();
    send(&mut gb, 0x08, &[1, 0, 0, 0]); // SOUND: a built-in effect only
    for _ in 0..350 { frame(&mut gb); }
    assert!(!music(&gb), "no SOU_TRN");
    transfer(&mut gb, 0x09, 0, &[0; 4096]); // SOU_TRN
    for _ in 0..150 { frame(&mut gb); }
    assert!(!music(&gb), "not known before 10 s");
    for _ in 0..150 { frame(&mut gb); }
    assert!(music(&gb), "silent Game Boy side: the music is on the SNES");
    let state = gb.save_state();
    assert!(gb.load_state(&state) && music(&gb), "kept for the session");
    // A game with a Game Boy channel playing all along: SNES sound on top of its own music.
    let mut gb = sgb();
    for (reg, v) in [(0xFF26, 0x80), (0xFF17, 0xF0), (0xFF19, 0x80)] { gb.bus.write_byte(reg, v); }
    transfer(&mut gb, 0x09, 0, &[0; 4096]);
    for _ in 0..300 { frame(&mut gb); }
    assert!(!music(&gb), "the Game Boy plays its own music");
}

#[test]
fn mlt_req_reports_player_ids() {
    let mut gb = sgb();
    let id = |gb: &mut GameBoy| {
        gb.bus.write_byte(0xFF00, 0x10); // P15 low (buttons), then high: the next player
        gb.bus.write_byte(0xFF00, 0x30);
        gb.bus.read_byte(0xFF00) & 0x0F
    };
    assert_eq!(id(&mut gb), 0x0F, "one player");
    send(&mut gb, 0x11, &[1]);
    let ids: Vec<u8> = (0..4).map(|_| id(&mut gb)).collect();
    assert!(ids.contains(&0x0E) && ids.contains(&0x0F), "two players take turns: {ids:?}");
    // Player 2's buttons reach the game on its turn.
    gb.bus.sgb.as_mut().unwrap().pads[0][1] = 0x0E; // A held
    while id(&mut gb) != 0x0E {}
    gb.bus.write_byte(0xFF00, 0x10); // buttons
    assert_eq!(gb.bus.read_byte(0xFF00) & 0x0F, 0x0E);
}

/// Shows `data` (4 KB) as 256 tiles in rows of 20, as games do for a transfer, then sends `cmd`.
fn transfer(gb: &mut GameBoy, cmd: u8, arg: u8, data: &[u8]) {
    for (i, &b) in data.iter().enumerate() { gb.bus.write_byte(0x8000 + i as u16, b); }
    for t in 0..256u16 { gb.bus.write_byte(0x9800 + t / 20 * 32 + t % 20, t as u8); }
    send(gb, 0x17, &[1]); // freeze the picture meanwhile
    send(gb, cmd, &[arg]);
    for _ in 0..4 { gb.run_frame().unwrap(); }
}

#[test]
fn border_from_chr_and_pct_trn() {
    let mut gb = sgb();
    assert!(!gb.bus.sgb.as_ref().unwrap().has_border);
    // CHR_TRN: SNES tile 1 = colour 1 everywhere (bitplane 0 set).
    let mut chr = vec![0u8; 4096];
    for r in 0..8 { chr[32 + r * 2] = 0xFF; }
    transfer(&mut gb, 0x13, 0, &chr);
    // PCT_TRN: map entry (0, 0) = tile 1, palette 4, flipped; border palette 4 colour 1 = blue.
    let mut pct = vec![0u8; 4096];
    pct[0..2].copy_from_slice(&(1u16 | 4 << 10 | 0xC000).to_le_bytes());
    pct[0x802..0x804].copy_from_slice(&BLUE.to_le_bytes());
    transfer(&mut gb, 0x14, 0, &pct);
    pal01(&mut gb, RED, GREEN);
    gb.run_frame().unwrap();

    let s = gb.bus.sgb.as_ref().unwrap();
    assert!(s.has_border);
    let at = |x: usize, y: usize| -> [u8; 4] { s.border[(y * 256 + x) * 4..][..4].try_into().unwrap() };
    assert_eq!(at(7, 7), rgb(BLUE), "tile 1");
    assert_eq!(at(8, 0), rgb(WHITE), "transparent: the backdrop (colour 0)");
}

#[test]
fn pal_trn_pal_set_attr_trn_attr_set() {
    let mut gb = sgb();
    for y in 0..18 { for x in 0..20 { dark_cell(&mut gb, x, y); } }
    // System palette 5: colour 3 green; 9: colour 3 blue.
    let mut pals = vec![0u8; 4096];
    pals[5 * 8 + 6..5 * 8 + 8].copy_from_slice(&GREEN.to_le_bytes());
    pals[9 * 8 + 6..9 * 8 + 8].copy_from_slice(&BLUE.to_le_bytes());
    transfer(&mut gb, 0x0B, 0, &pals);
    // Attribute file 2: every cell palette 1 but the first (palette 0).
    let mut atf = vec![0u8; 4096];
    atf[2 * 90..3 * 90].fill(0x55);
    atf[2 * 90] = 0x15;
    transfer(&mut gb, 0x15, 0, &atf);
    for i in 0..16 { gb.bus.write_byte(0x8010 + i, 0xFF); }
    for y in 0..18 { for x in 0..20 { dark_cell(&mut gb, x, y); } }

    // PAL_SET: palette 0 = 9, palette 1 = 5, apply file 2 and cancel the mask.
    send(&mut gb, 0x0A, &[9, 0, 5, 0, 0, 0, 0, 0, 0xC2]);
    frame(&mut gb);
    assert_eq!(px(&gb, 0, 0), rgb(BLUE));
    assert_eq!(px(&gb, 8, 0), rgb(GREEN));

    // ATTR_SET file 0 (all palette 0).
    send(&mut gb, 0x16, &[0]);
    frame(&mut gb);
    assert_eq!(px(&gb, 8, 0), rgb(BLUE));
}

#[test]
fn states_keep_the_sgb_side_and_stay_on_their_console() {
    let mut gb = sgb();
    dark_cell(&mut gb, 0, 0);
    pal01(&mut gb, RED, GREEN);
    send(&mut gb, 0x06, &[0x01 << 2, 10]); // ATTR_DIV: columns 0-9 palette 1
    let state = gb.save_state();
    assert_eq!(gb.state_console(&state), Some(Console::Sgb));

    let mut fresh = sgb();
    dark_cell(&mut fresh, 0, 0);
    assert!(fresh.load_state(&state));
    frame(&mut fresh);
    assert_eq!(px(&fresh, 0, 0), rgb(GREEN), "palettes and attributes come back");

    let mut dmg = GameBoy::with_boot(sgb_rom(), false, 0, 0).unwrap();
    assert_eq!(dmg.console, Console::Dmg);
    assert!(!dmg.load_state(&state), "an SGB state never loads on a Game Boy");
}

#[test]
fn boot_rom_reaches_the_cartridge_and_needs_sgb_support() {
    let mut gb = GameBoy::with_sgb(sgb_rom(), 1).unwrap();
    for _ in 0..300 {
        if !gb.bus.boot_rom_active { break; }
        gb.run_frame().unwrap();
    }
    assert!(!gb.bus.boot_rom_active, "the SGB boot ROM hands over");
    assert!((0x100..0x104).contains(&gb.cpu.regs.pc));
    assert_eq!((gb.cpu.regs.a, gb.cpu.regs.c, gb.cpu.regs.hl()), (0x01, 0x14, 0xC060), "SGB registers");
    // The boot ROM's header packets ($F1-$FB) leave no command half-received: the game's first one works.
    for i in 0..16 { gb.bus.write_byte(0x8010 + i, 0xFF); }
    gb.bus.write_byte(0xFF47, 0xE4);
    gb.bus.write_byte(0xFF40, 0x91);
    dark_cell(&mut gb, 0, 0);
    pal01(&mut gb, RED, GREEN);
    frame(&mut gb);
    assert_eq!(px(&gb, 0, 0), rgb(RED));

    let mut plain = sgb_rom();
    plain[0x14B] = 0x01; // no SGB functions without the old licensee $33
    plain[0x14D] = (0x134..=0x14C).fold(0u8, |c, i| c.wrapping_sub(plain[i]).wrapping_sub(1));
    assert_eq!(GameBoy::with_sgb(plain, 0).unwrap().console, Console::Dmg);
}

#[test]
fn a_state_saved_mid_transfer_still_transfers() {
    let mut gb = sgb();
    let mut chr = vec![0u8; 4096];
    for r in 0..8 { chr[32 + r * 2] = 0xFF; }
    transfer(&mut gb, 0x13, 0, &chr);
    // PCT_TRN, saved halfway through the frame the transfer reads back.
    let mut pct = vec![0u8; 4096];
    pct[0..2].copy_from_slice(&(1u16 | 4 << 10).to_le_bytes());
    pct[0x802..0x804].copy_from_slice(&BLUE.to_le_bytes());
    for (i, &b) in pct.iter().enumerate() { gb.bus.write_byte(0x8000 + i as u16, b); }
    send(&mut gb, 0x14, &[0]);
    for _ in 0..2 { assert!(gb.run_to_vblank().unwrap()); }
    while gb.bus.ppu.ly != 0 { gb.step_instruction().unwrap(); }
    while gb.bus.ppu.ly < 72 { gb.step_instruction().unwrap(); }
    let state = gb.save_state();

    let mut loaded = sgb();
    assert!(loaded.load_state(&state));
    for g in [&mut gb, &mut loaded] { for _ in 0..3 { g.run_to_vblank().unwrap(); } }
    let (a, b) = (gb.bus.sgb.as_ref().unwrap(), loaded.bus.sgb.as_ref().unwrap());
    assert!(b.has_border);
    assert_eq!(b.border[(7 * 256 + 7) * 4..][..4], rgb(BLUE), "the map read after the load is whole");
    assert!(a.border == b.border);
}

#[test]
fn a_game_boy_state_loads_on_the_super_game_boy() {
    let mut dmg = GameBoy::with_boot(sgb_rom(), false, 0, 0).unwrap();
    for i in 0..16 { dmg.bus.write_byte(0x8010 + i, 0xFF); }
    dmg.bus.write_byte(0xFF47, 0xE4);
    dark_cell(&mut dmg, 0, 0);
    let state = dmg.save_state();
    assert_eq!(dmg.state_console(&state), Some(Console::Dmg));

    let mut gb = sgb();
    pal01(&mut gb, RED, GREEN);
    assert!(gb.load_state(&state), "the same machine: a save made before the switch was on still loads");
    assert_eq!(gb.console, Console::Sgb);
    frame(&mut gb);
    assert_eq!(px(&gb, 0, 0), rgb(0x0000), "the SGB side starts fresh (grey) until the game sends its colours");
    pal01(&mut gb, RED, GREEN);
    frame(&mut gb);
    assert_eq!(px(&gb, 0, 0), rgb(RED));
}

#[test]
fn a_state_saved_between_the_packets_of_a_command_keeps_them() {
    // ATTR_BLK in two packets; its third data set (cells (2,2)-(5,5) inside: palette 1) straddles them.
    let mut d = [0u8; 19];
    d[0] = 3;
    d[13..19].copy_from_slice(&[0x01, 0x01, 2, 2, 5, 5]);
    let bytes = command(0x04, &d);
    let mut gb = sgb();
    for y in 0..18 { for x in 0..20 { dark_cell(&mut gb, x, y); } }
    pal01(&mut gb, RED, GREEN);
    send_packet(&mut gb, &bytes[..16]);
    let state = gb.save_state();

    let mut loaded = sgb();
    assert!(loaded.load_state(&state));
    // Half-way through the second packet too: the bits received so far are kept.
    let p = &bytes[16..];
    loaded.bus.write_byte(0xFF00, 0x00);
    loaded.bus.write_byte(0xFF00, 0x30);
    for i in 0..128 {
        if i == 40 {
            let mid = loaded.save_state();
            loaded = sgb();
            assert!(loaded.load_state(&mid));
        }
        loaded.bus.write_byte(0xFF00, if p[i / 8] >> (i % 8) & 1 != 0 { 0x10 } else { 0x20 });
        loaded.bus.write_byte(0xFF00, 0x30);
    }
    loaded.bus.write_byte(0xFF00, 0x20);
    loaded.bus.write_byte(0xFF00, 0x30);
    frame(&mut loaded);
    assert_eq!(px(&loaded, 3 * 8, 3 * 8), rgb(GREEN), "the command completes after the load");
    assert_eq!(px(&loaded, 8 * 8, 8 * 8), rgb(RED));
}

/// After a state load the thumbnail is put back as DMG shades too, so the SGB colours the rows the
/// next frame drew before the save point as the thumbnail showed them (not blank).
#[test]
fn the_first_frame_after_a_load_continues_the_thumbnail() {
    let mut gb = sgb();
    dark_cell(&mut gb, 0, 0);
    pal01(&mut gb, RED, GREEN);
    frame(&mut gb);
    while gb.bus.ppu.ly != 60 { gb.step_instruction().unwrap(); }
    let (state, thumb) = (gb.save_state(), gb.screen().to_vec());

    let mut fresh = sgb();
    assert!(fresh.load_state(&state));
    fresh.set_screen(&thumb);
    while fresh.bus.ppu.ly != 144 { fresh.step_instruction().unwrap(); }
    assert_eq!(px(&fresh, 0, 0), rgb(RED), "drawn before the save point");
    assert_eq!(px(&fresh, 0, 100), rgb(WHITE), "drawn after the load");
}

// ─── SNES sound (SOU_TRN) ───

/// A SOU_TRN payload: `[len][dest][data]` blocks, then a zero length and the start address,
/// zero-padded to 4 KB.
fn sou(blocks: &[(u16, &[u8])], start: u16) -> Vec<u8> {
    let mut d = Vec::new();
    for (dest, data) in blocks {
        d.extend_from_slice(&(data.len() as u16).to_le_bytes());
        d.extend_from_slice(&dest.to_le_bytes());
        d.extend_from_slice(data);
    }
    d.extend_from_slice(&[0, 0]);
    d.extend_from_slice(&start.to_le_bytes());
    d.resize(4096, 0);
    d
}

/// Hand-assembled SPC700 loop: MOV A,$F4; MOV $F5,A; INCW $10; BRA back to the start.
const ECHO_LOOP: [u8; 8] = [0xE4, 0xF4, 0xC4, 0xF5, 0x3A, 0x10, 0x2F, 0xF8];

fn snes(gb: &GameBoy) -> &gb_core::sgb::SnesAudio {
    &gb.bus.sgb.as_ref().unwrap().audio
}

#[test]
fn sou_trn_uploads_and_runs_a_sound_program() {
    let mut gb = sgb();
    transfer(&mut gb, 0x09, 0, &sou(&[(0x0200, &ECHO_LOOP), (0x0300, &[1, 2, 3])], 0x0200));
    assert_eq!(snes(&gb).aram()[0x200..0x208], ECHO_LOOP, "first block in audio RAM");
    assert_eq!(snes(&gb).aram()[0x300..0x303], [1, 2, 3], "second block");
    let count = |gb: &GameBoy| u16::from_le_bytes([snes(gb).aram()[0x10], snes(gb).aram()[0x11]]);
    let before = count(&gb);
    gb.run_frame().unwrap();
    assert_ne!(count(&gb), before, "the program runs");
    assert!(snes(&gb).covered(), "it only ran what it uploaded");

    let mut gb = sgb();
    transfer(&mut gb, 0x09, 0, &sou(&[(0x0200, &ECHO_LOOP)], 0x1000));
    gb.run_frame().unwrap();
    assert!(!snes(&gb).covered(), "started outside the upload");

    let mut gb = sgb();
    let mut unterminated = vec![0u8; 4096];
    unterminated[0..4].copy_from_slice(&[0xFF, 0x0F, 0x00, 0x02]); // one block longer than the transfer
    transfer(&mut gb, 0x09, 0, &unterminated);
    assert!(!snes(&gb).covered() && snes(&gb).aram()[0x200] == 0, "ignored");
}

/// A hand-built BRR square wave (one looping block: eight samples up, eight down, shift 12)
/// at $0300, its directory entry at $0400, and a program at $0200 that plays it on voice 0 at
/// 32 kHz / 16 (2 kHz), full volume, then runs `ECHO_LOOP`.
fn tone(start: u16) -> Vec<u8> {
    let mut p = Vec::new();
    // FLG (unmute, echo writes off), DIR, main volume, voice 0: volume, pitch $1000, source 0,
    // direct GAIN $7F, then KON.
    for (reg, v) in [(0x6C, 0x20), (0x5D, 0x04), (0x0C, 0x7F), (0x1C, 0x7F), (0x00, 0x7F), (0x01, 0x7F),
        (0x02, 0x00), (0x03, 0x10), (0x04, 0x00), (0x05, 0x00), (0x07, 0x7F), (0x4C, 0x01)] {
        p.extend_from_slice(&[0x8F, reg, 0xF2, 0x8F, v, 0xF3]); // MOV $F2,#reg; MOV $F3,#v
    }
    p.extend_from_slice(&ECHO_LOOP);
    let brr = [0xC3, 0x77, 0x77, 0x77, 0x77, 0x88, 0x88, 0x88, 0x88];
    sou(&[(0x0200, &p), (0x0300, &brr), (0x0400, &[0x00, 0x03, 0x00, 0x03])], start)
}

/// RMS of the mixed audio of one frame.
fn frame_rms(gb: &mut GameBoy) -> f32 {
    gb.bus.apu.clear_samples();
    gb.run_frame().unwrap();
    let n = gb.bus.apu.buffer_len();
    let s = unsafe { std::slice::from_raw_parts(gb.bus.apu.buffer_ptr(), n) };
    (s.iter().map(|x| x * x).sum::<f32>() / n.max(1) as f32).sqrt()
}

fn snes_music(gb: &GameBoy) -> bool {
    gb.bus.sgb.as_ref().unwrap().snes_music()
}

#[test]
fn a_sound_program_is_heard_with_the_game_boy_audio() {
    let mut gb = sgb();
    assert!(frame_rms(&mut gb) < 0.01, "silent before");
    transfer(&mut gb, 0x09, 0, &tone(0x0200));
    for _ in 0..30 { gb.run_frame().unwrap(); }
    let rms = frame_rms(&mut gb);
    assert!(rms > 0.1, "the tone plays: RMS {rms}");
    for _ in 0..350 { frame(&mut gb); }
    assert!(!snes_music(&gb), "covered: no switch back to the Game Boy");
    assert!(frame_rms(&mut gb) > 0.1, "still playing");
}

#[test]
fn a_program_that_leaves_its_upload_is_silent_and_switches_back() {
    let mut gb = sgb();
    transfer(&mut gb, 0x09, 0, &tone(0x1000));
    for _ in 0..30 { gb.run_frame().unwrap(); }
    let rms = frame_rms(&mut gb);
    assert!(rms < 0.01, "silent: RMS {rms}");
    for _ in 0..300 { frame(&mut gb); }
    assert!(snes_music(&gb), "the notice path, as before");
}

#[test]
fn sound_parameters_reach_the_program() {
    let mut gb = sgb();
    transfer(&mut gb, 0x09, 0, &sou(&[(0x0200, &ECHO_LOOP)], 0x0200));
    send(&mut gb, 0x08, &[0x42, 0x01, 0x02, 0x03]); // SOUND
    gb.run_frame().unwrap();
    assert_eq!(snes(&gb).ports_out()[1], 0x42, "$F4 echoed to $F5");
}

#[test]
fn a_state_keeps_the_snes_sound_playing() {
    let mut gb = sgb();
    transfer(&mut gb, 0x09, 0, &tone(0x0200));
    for _ in 0..30 { gb.run_frame().unwrap(); }
    let state = gb.save_state();

    let mut fresh = sgb();
    assert!(fresh.load_state(&state));
    let rms = frame_rms(&mut fresh);
    assert!(rms > 0.1, "the tone goes on: RMS {rms}");
    assert!(snes(&fresh).covered());

    // The previous version (5): the same layout without the SNES block, which an idle SNES side
    // saves as a single 0 just before the tail (stop mode, KEY0, an empty mapper block).
    let mut v5 = sgb().save_state();
    assert_eq!(v5[4], 6, "this layout is version 6");
    let n = v5.len();
    assert_eq!(v5[n - 5], 0, "an idle SNES side");
    v5.remove(n - 5);
    v5[4] = 5;
    assert!(gb.load_state(&v5), "a version 5 state loads");
    let rms = frame_rms(&mut gb);
    assert!(rms < 0.01 && !snes(&gb).covered(), "with the SNES side idle: RMS {rms}");
}
