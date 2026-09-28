//! GBS (Game Boy Sound System) v1 files: a sound driver plus song data, loaded at `load`, with an
//! init routine (A = song) and a play routine called at the VBlank or timer rate.
//!
//! `to_rom` wraps one into a small MBC5 cartridge whose driver calls init, then play from the
//! interrupt the header asks for, so the unchanged emulator and audio path play it.

use thiserror::Error;

const HEADER_LEN: usize = 0x70;
const MAX_ROM: usize = 8 << 20; // MBC5: 512 banks of 16 KB

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct GbsHeader {
    pub songs: u8,
    /// First song to play, 1-based.
    pub first: u8,
    pub load: u16,
    pub init: u16,
    pub play: u16,
    pub sp: u16,
    pub tma: u8,
    pub tac: u8,
    pub title: String,
    pub author: String,
    pub copyright: String,
}

#[derive(Error, Debug)]
pub enum GbsError {
    #[error("Not a GBS file: too small")]
    TooSmall,
    #[error("Not a GBS file: bad magic")]
    BadMagic,
    #[error("Unsupported GBS version {0}")]
    UnsupportedVersion(u8),
    #[error("GBS file has no songs")]
    NoSongs,
    #[error("GBS load address 0x{0:04X} is outside 0x0400-0x7FFF")]
    BadLoadAddress(u16),
    #[error("GBS data is too large for a cartridge")]
    TooLarge,
    #[error("Track {track} out of range ({songs} songs)")]
    TrackOutOfRange { track: u8, songs: u8 },
}

fn le16(d: &[u8], at: usize) -> u16 {
    u16::from_le_bytes([d[at], d[at + 1]])
}

fn text(d: &[u8]) -> String {
    let end = d.iter().position(|&b| b == 0).unwrap_or(d.len());
    String::from_utf8_lossy(&d[..end]).into_owned()
}

pub fn parse_header(data: &[u8]) -> Result<GbsHeader, GbsError> {
    if data.len() <= HEADER_LEN {
        return Err(GbsError::TooSmall);
    }
    if &data[0..3] != b"GBS" {
        return Err(GbsError::BadMagic);
    }
    if data[3] != 1 {
        return Err(GbsError::UnsupportedVersion(data[3]));
    }
    if data[4] == 0 {
        return Err(GbsError::NoSongs);
    }
    let load = le16(data, 6);
    if !(0x0400..=0x7FFF).contains(&load) {
        return Err(GbsError::BadLoadAddress(load));
    }
    Ok(GbsHeader {
        songs: data[4],
        first: data[5],
        load,
        init: le16(data, 8),
        play: le16(data, 0x0A),
        sp: le16(data, 0x0C),
        tma: data[0x0E],
        tac: data[0x0F],
        title: text(&data[0x10..0x30]),
        author: text(&data[0x30..0x50]),
        copyright: text(&data[0x50..0x70]),
    })
}

/// A cartridge image that plays `track` (0-based) of the GBS in `data`.
pub fn to_rom(data: &[u8], track: u8) -> Result<Vec<u8>, GbsError> {
    let h = parse_header(data)?;
    if track >= h.songs {
        return Err(GbsError::TrackOutOfRange { track, songs: h.songs });
    }
    let body = &data[HEADER_LEN..];
    let load = h.load as usize;
    let size = (load + body.len()).max(0x8000).next_power_of_two();
    if size > MAX_ROM {
        return Err(GbsError::TooLarge);
    }
    let mut rom = vec![0u8; size];
    rom[load..load + body.len()].copy_from_slice(body);

    let [init_lo, init_hi] = h.init.to_le_bytes();
    let [play_lo, play_hi] = h.play.to_le_bytes();
    let [sp_lo, sp_hi] = h.sp.to_le_bytes();

    // RST vectors are relocated to load + $00…$38.
    for n in (0..0x40).step_by(8) {
        let [lo, hi] = (h.load + n as u16).to_le_bytes();
        rom[n..n + 3].copy_from_slice(&[0xC3, lo, hi]); // JP load+n
    }
    // VBlank ($40) and timer ($50) interrupts: CALL play ; RETI
    for v in [0x40, 0x50] {
        rom[v..v + 4].copy_from_slice(&[0xCD, play_lo, play_hi, 0xD9]);
    }
    rom[0x100..0x104].copy_from_slice(&[0x00, 0xC3, 0x50, 0x01]); // NOP ; JP $0150

    let timer = h.tac & 0x04 != 0;
    let ie = if timer { 0x04 } else { 0x01 };
    #[rustfmt::skip]
    let driver = [
        0xF3,                   // DI
        0x31, sp_lo, sp_hi,     // LD SP, sp
        0x3E, 0x0A,             // LD A, $0A
        0xEA, 0x00, 0x00,       // LD [$0000], A      cartridge RAM on ($A000-$BFFF)
        0x3E, 0x01,             // LD A, 1
        0xEA, 0x00, 0x20,       // LD [$2000], A      ROM bank 1
        0x3E, h.tma,            // LD A, tma
        0xE0, 0x06,             // LDH [$06], A       TMA
        0xE0, 0x05,             // LDH [$05], A       TIMA starts a full period
        0x3E, h.tac,            // LD A, tac
        0xE0, 0x07,             // LDH [$07], A       TAC
        0x3E, 0x80,             // LD A, $80
        0xE0, 0x40,             // LDH [$40], A       LCD on (VBlank needs it)
        0x3E, ie,               // LD A, ie
        0xE0, 0xFF,             // LDH [$FF], A       IE: VBlank or timer
        0xAF,                   // XOR A
        0xE0, 0x0F,             // LDH [$0F], A       IF cleared
        0x3E, track,            // LD A, track
        0xCD, init_lo, init_hi, // CALL init
        0xFB,                   // EI
        0x76,                   // loop: HALT
        0x18, 0xFD,             // JR loop
    ];
    rom[0x150..0x150 + driver.len()].copy_from_slice(&driver);

    // Header: title "GBS", MBC5 + RAM, ROM size, 8 KB RAM, checksum. No logo bytes.
    rom[0x134..0x137].copy_from_slice(b"GBS");
    rom[0x147] = 0x1A;
    rom[0x148] = (size.trailing_zeros() - 15) as u8;
    rom[0x149] = 0x02;
    rom[0x14D] = (0x134..=0x14C).fold(0u8, |c, a| c.wrapping_sub(rom[a]).wrapping_sub(1));
    Ok(rom)
}
