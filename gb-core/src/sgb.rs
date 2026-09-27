//! Super Game Boy: the command packets a cartridge sends over the joypad register (P1), and the
//! picture the SNES side makes of the Game Boy's: four palettes picked per 8x8 cell, a mask, and a
//! 256x224 border. Data transfers (`*_TRN`) are read, like on the real thing, from the picture
//! shown a few frames after the command. Sound (SOUND, SOU_TRN; `snes_music` tells the host when a game
//! plays its own music on the SNES side, silent here), SNES code (DATA_SND, DATA_TRN,
//! JUMP) and the rest (ATRC_EN, TEST_EN, ICON_EN, OBJ_TRN) are ignored: their packets are read
//! and dropped. References: Pan Docs "Super Game Boy", SameBoy's `sgb.c` (behaviour only).

use crate::ppu::{Ppu, PALETTE_COLORS, SCREEN_HEIGHT, SCREEN_WIDTH};

pub const BORDER_WIDTH: usize = 256;
pub const BORDER_HEIGHT: usize = 224;
pub const BORDER_SIZE: usize = BORDER_WIDTH * BORDER_HEIGHT * 4;
/// Where the Game Boy's picture sits inside the border.
pub const GAME_X: usize = 48;
pub const GAME_Y: usize = 40;

const CELLS: usize = 20 * 18;
const TRN_LEN: usize = 4096;
/// VBlanks between a transfer command and the frame its data is read from.
const TRN_DELAY: u8 = 3;

#[derive(Clone, Copy, PartialEq, Eq, Debug)]
enum Trn { None, Pal, Attr, Chr(bool), Pct }

pub struct Sgb {
    // Packet reception.
    last_p1: u8,
    receiving: bool,
    bit: usize,
    packet: [u8; 16],
    command: Vec<u8>,
    // Multiplayer (MLT_REQ): 1, 2 or 4 players, the one P1 reads now, and players 2-4's buttons.
    players: u8,
    pub player: u8,
    /// `[d-pad, buttons]` of players 2-4, 0 = pressed (as `Joypad`).
    pub pads: [[u8; 2]; 3],
    // Picture.
    /// Four palettes of four RGB555 colours; colour 0 of palette 0 is every palette's colour 0.
    pals: [[u16; 4]; 4],
    /// Palette of each 8x8 cell (20x18).
    attrs: [u8; CELLS],
    /// 0 off, 1 freeze, 2 black, 3 colour 0.
    mask: u8,
    sys_pals: Vec<u16>, // 512 x 4, PAL_TRN
    atfs: Vec<u8>,      // 45 x 90, ATTR_TRN
    tiles: Vec<u8>,     // 256 SNES 4bpp tiles, CHR_TRN
    map: Vec<u8>,       // 32x32 entries (2 bytes) then 4 x 16 colours, PCT_TRN
    trn: Trn,
    trn_wait: u8,
    /// Shade (0-3) of every Game Boy pixel of the last frame.
    shades: Vec<u8>,
    /// The picture shown (160x144 RGBA, `GameBoy::screen`): the last frame coloured at VBlank, kept
    /// while the mask freezes it. The PPU's own framebuffer keeps the DMG shades it draws.
    pub out: Vec<u8>,
    /// The game sent a border (PCT_TRN); the border as RGBA, and a counter bumped whenever it is redrawn.
    pub has_border: bool,
    pub border: Vec<u8>,
    pub border_version: u32,
    backdrop: u16,
    /// The game sent SOU_TRN (its own program or music for the SNES sound chip, not emulated), then
    /// frames counted since (up to `SNES_WINDOW`) and those with a Game Boy sound channel on.
    pub snes_sound: bool,
    snes_frames: u16,
    gb_sound_frames: u16,
}

/// Frames (10 s) watched after SOU_TRN before telling whether the game's music is on the SNES.
const SNES_WINDOW: u16 = 600;

impl Default for Sgb {
    fn default() -> Self { Self::new() }
}

impl Sgb {
    pub fn new() -> Self {
        // Before any palette command: the four grey shades.
        let grey = [0x7FFF, 0x56B5, 0x294A, 0x0000];
        Sgb {
            last_p1: 0x30,
            receiving: false,
            bit: 0,
            packet: [0; 16],
            command: Vec::with_capacity(112),
            players: 1,
            player: 0,
            pads: [[0x0F; 2]; 3],
            pals: [grey; 4],
            attrs: [0; CELLS],
            mask: 0,
            sys_pals: vec![0; 512 * 4],
            atfs: vec![0; 45 * 90],
            tiles: vec![0; 256 * 32],
            map: vec![0; 0x880],
            trn: Trn::None,
            trn_wait: 0,
            shades: vec![0; SCREEN_WIDTH * SCREEN_HEIGHT],
            out: vec![0; SCREEN_WIDTH * SCREEN_HEIGHT * 4],
            has_border: false,
            border: vec![0; BORDER_SIZE],
            border_version: 0,
            backdrop: grey[0],
            snes_sound: false,
            snes_frames: 0,
            gb_sound_frames: 0,
        }
    }

    /// A write to P1. Pulses: both lines low = reset (a packet starts), P14 low = a 0 bit,
    /// P15 low = a 1 bit, both high between pulses. 128 bits (LSB first), then a 0 stop bit.
    pub fn write_p1(&mut self, value: u8) {
        let sel = value & 0x30;
        let prev = self.last_p1;
        self.last_p1 = sel;
        match sel {
            0x00 => { self.receiving = true; self.bit = 0; }
            0x30 => {
                // The next player is read after P15 goes back high (MLT_REQ).
                if self.players > 1 && prev & 0x20 == 0 {
                    self.player = (self.player + 1) & (self.players - 1);
                }
            }
            _ if prev == 0x30 && self.receiving => {
                let one = sel == 0x10;
                if self.bit == 128 {
                    self.receiving = false;
                    if !one { self.packet_done(); }
                } else {
                    let (byte, mask) = (&mut self.packet[self.bit / 8], 1 << (self.bit % 8));
                    if one { *byte |= mask } else { *byte &= !mask }
                    self.bit += 1;
                }
            }
            _ => {}
        }
    }

    /// P1 as read for players 2-4 (`None`: player 1, the ordinary joypad).
    pub fn read_p1(&self, select: u8) -> Option<u8> {
        if self.player == 0 { return None; }
        let pad = self.pads[self.player as usize - 1];
        let mut low = 0x0F;
        if select & 0x10 == 0 { low &= pad[0]; }
        if select & 0x20 == 0 { low &= pad[1]; }
        if select == 0x30 { low = 0x0F - self.player; }
        Some(0xC0 | select | low)
    }

    fn packet_done(&mut self) {
        // $F1-$FB: the boot ROM's single packets carrying the cartridge header (their low bits are not a length).
        if self.command.is_empty() && (self.packet[0] & 7 == 0 || self.packet[0] >= 0xF0) { return; }
        self.command.extend_from_slice(&self.packet);
        if self.command.len() / 16 >= (self.command[0] & 7) as usize {
            let cmd = std::mem::take(&mut self.command);
            self.run(&cmd);
            self.command = cmd;
            self.command.clear();
        }
    }

    fn run(&mut self, c: &[u8]) {
        let color = |i: usize| u16::from_le_bytes([c[i], c[i + 1]]) & 0x7FFF;
        match c[0] >> 3 {
            // PAL01, PAL23, PAL03, PAL12: colour 0, then colours 1-3 of two palettes.
            op @ 0x00..=0x03 => {
                let (a, b) = [(0, 1), (2, 3), (0, 3), (1, 2)][op as usize];
                self.pals[0][0] = color(1);
                for i in 1..4 {
                    self.pals[a][i] = color(1 + i * 2);
                    self.pals[b][i] = color(7 + i * 2);
                }
            }
            0x04 => self.attr_blk(c),
            0x05 => {
                for &l in c[2..].iter().take(c[1] as usize) {
                    let (n, p) = ((l & 0x1F) as usize, (l >> 5) & 3);
                    if l & 0x80 != 0 {
                        if n < 18 { self.attrs[n * 20..n * 20 + 20].fill(p); }
                    } else if n < 20 {
                        for y in 0..18 { self.attrs[y * 20 + n] = p; }
                    }
                }
            }
            0x06 => {
                let (hi, lo, mid) = (c[1] & 3, (c[1] >> 2) & 3, (c[1] >> 4) & 3);
                for y in 0..18 {
                    for x in 0..20 {
                        let d = if c[1] & 0x40 != 0 { y } else { x };
                        self.attrs[y * 20 + x] = match d.cmp(&(c[2] as usize)) {
                            std::cmp::Ordering::Less => lo,
                            std::cmp::Ordering::Equal => mid,
                            std::cmp::Ordering::Greater => hi,
                        };
                    }
                }
            }
            0x07 => {
                let (mut x, mut y) = (c[1] as usize, c[2] as usize);
                let n = (u16::from_le_bytes([c[3], c[4]]) as usize).min(CELLS).min((c.len() - 6) * 4);
                for i in 0..n {
                    if x >= 20 || y >= 18 { break; }
                    self.attrs[y * 20 + x] = (c[6 + i / 4] >> (6 - 2 * (i % 4))) & 3;
                    if c[5] != 0 {
                        y += 1;
                        if y == 18 { y = 0; x += 1; }
                    } else {
                        x += 1;
                        if x == 20 { x = 0; y += 1; }
                    }
                }
            }
            0x0A => {
                for p in 0..4 {
                    let id = (u16::from_le_bytes([c[1 + p * 2], c[2 + p * 2]]) & 0x1FF) as usize;
                    self.pals[p].copy_from_slice(&self.sys_pals[id * 4..id * 4 + 4]);
                }
                if c[9] & 0x80 != 0 { self.attr_file(c[9] & 0x3F); }
                if c[9] & 0x40 != 0 { self.mask = 0; }
            }
            0x0B => self.start_trn(Trn::Pal),
            0x11 => {
                self.players = [1, 2, 1, 4][(c[1] & 3) as usize];
                self.player = 0;
            }
            0x13 => self.start_trn(Trn::Chr(c[1] & 1 != 0)),
            0x14 => self.start_trn(Trn::Pct),
            0x15 => self.start_trn(Trn::Attr),
            0x16 => {
                self.attr_file(c[1] & 0x3F);
                if c[1] & 0x40 != 0 { self.mask = 0; }
            }
            0x17 => self.mask = c[1] & 3,
            0x09 => self.snes_sound = true,
            _ => {} // sound, SNES code and the rest: not emulated
        }
        self.refresh_border();
    }

    fn attr_blk(&mut self, c: &[u8]) {
        let sets = (c[1] as usize).min((c.len() - 2) / 6);
        for s in c[2..2 + sets * 6].chunks(6) {
            let (inside, mut line, outside) = (s[0] & 1 != 0, s[0] & 2 != 0, s[0] & 4 != 0);
            let (pi, mut pl, po) = (s[1] & 3, (s[1] >> 2) & 3, (s[1] >> 4) & 3);
            // Only inside or only outside: the surrounding line takes the same palette.
            if inside && !line && !outside { line = true; pl = pi; }
            if outside && !line && !inside { line = true; pl = po; }
            let (x1, y1, x2, y2) = (s[2] as usize, s[3] as usize, s[4] as usize, s[5] as usize);
            for y in 0..18 {
                for x in 0..20 {
                    let p = if x > x1 && x < x2 && y > y1 && y < y2 {
                        inside.then_some(pi)
                    } else if x < x1 || x > x2 || y < y1 || y > y2 {
                        outside.then_some(po)
                    } else {
                        line.then_some(pl)
                    };
                    if let Some(p) = p { self.attrs[y * 20 + x] = p; }
                }
            }
        }
    }

    fn attr_file(&mut self, n: u8) {
        if n >= 45 { return; }
        let f = &self.atfs[n as usize * 90..n as usize * 90 + 90];
        for i in 0..CELLS {
            self.attrs[i] = (f[i / 4] >> (6 - 2 * (i % 4))) & 3;
        }
    }

    fn start_trn(&mut self, t: Trn) {
        self.trn = t;
        self.trn_wait = TRN_DELAY;
    }

    /// The 4 KB a transfer sends: the shown picture read back as 256 tiles, 20 per row.
    fn trn_data(&self) -> Vec<u8> {
        let mut d = vec![0u8; TRN_LEN];
        for (t, tile) in d.chunks_mut(16).enumerate() {
            let (tx, ty) = (t % 20 * 8, t / 20 * 8);
            for r in 0..8 {
                for c in 0..8 {
                    let s = self.shades[(ty + r) * SCREEN_WIDTH + tx + c];
                    tile[r * 2] |= (s & 1) << (7 - c);
                    tile[r * 2 + 1] |= (s >> 1) << (7 - c);
                }
            }
        }
        d
    }

    fn finish_trn(&mut self) {
        let d = self.trn_data();
        match self.trn {
            Trn::Pal => {
                for (i, c) in d.chunks(2).enumerate() { self.sys_pals[i] = u16::from_le_bytes([c[0], c[1]]) & 0x7FFF; }
            }
            Trn::Attr => self.atfs.copy_from_slice(&d[..45 * 90]),
            Trn::Chr(high) => { self.tiles[high as usize * 4096..][..4096].copy_from_slice(&d); self.backdrop = u16::MAX; }
            Trn::Pct => { self.map.copy_from_slice(&d[..0x880]); self.has_border = true; self.backdrop = u16::MAX; }
            Trn::None => {}
        }
        self.trn = Trn::None;
        self.refresh_border();
    }

    /// Redraws the border when it (or the colour showing through it) changed.
    fn refresh_border(&mut self) {
        if !self.has_border || self.backdrop == self.pals[0][0] { return; }
        self.backdrop = self.pals[0][0];
        for ty in 0..BORDER_HEIGHT / 8 {
            for tx in 0..BORDER_WIDTH / 8 {
                let e = u16::from_le_bytes([self.map[(ty * 32 + tx) * 2], self.map[(ty * 32 + tx) * 2 + 1]]);
                let tile = &self.tiles[(e & 0xFF) as usize * 32..][..32];
                let pal = ((e >> 10) & 3) as usize;
                for r in 0..8 {
                    let row = if e & 0x8000 != 0 { 7 - r } else { r };
                    let p = [tile[row * 2], tile[row * 2 + 1], tile[16 + row * 2], tile[16 + row * 2 + 1]];
                    for c in 0..8 {
                        let bit = if e & 0x4000 != 0 { c } else { 7 - c };
                        let idx = (0..4).fold(0, |a, k| a | ((p[k] >> bit) & 1) << k) as usize;
                        let rgb = if idx == 0 { self.backdrop } else {
                            let o = 0x800 + (pal * 16 + idx) * 2;
                            u16::from_le_bytes([self.map[o], self.map[o + 1]])
                        };
                        let o = ((ty * 8 + r) * BORDER_WIDTH + tx * 8 + c) * 4;
                        self.border[o..o + 4].copy_from_slice(&rgba(rgb));
                    }
                }
            }
        }
        self.border_version = self.border_version.wrapping_add(1);
    }

    /// VBlank: reads the Game Boy's shades back from the frame the PPU drew (DMG colours), runs a
    /// pending transfer, then paints the picture with the SGB palettes (or the mask).
    // ponytail: shades recovered from the DMG colours rather than kept by the PPU (a line the PPU did
    // not draw keeps the last one's); keep a shade buffer in the PPU if that ever shows.
    /// `gb_sound`: a Game Boy sound channel is on (NR52 bits 0-3).
    pub fn vblank(&mut self, fb: &[u8], gb_sound: bool) {
        if self.snes_sound && self.snes_frames < SNES_WINDOW {
            self.snes_frames += 1;
            self.gb_sound_frames += gb_sound as u16;
        }
        for (s, px) in self.shades.iter_mut().zip(fb.chunks(4)) {
            *s = PALETTE_COLORS.iter().position(|c| c[..3] == px[..3]).unwrap_or(0) as u8;
        }
        if self.trn != Trn::None {
            self.trn_wait -= 1;
            if self.trn_wait == 0 { self.finish_trn(); }
        }
        match self.mask {
            0 => {
                for (i, &s) in self.shades.iter().enumerate() {
                    let cell = (i / SCREEN_WIDTH / 8) * 20 + i % SCREEN_WIDTH / 8;
                    let pal = self.attrs[cell] as usize;
                    let c = if s == 0 { self.pals[0][0] } else { self.pals[pal][s as usize] };
                    self.out[i * 4..i * 4 + 4].copy_from_slice(&rgba(c));
                }
            }
            1 => {}
            m => {
                let c = rgba(if m == 2 { 0 } else { self.pals[0][0] });
                for px in self.out.chunks_mut(4) { px.copy_from_slice(&c); }
            }
        }
    }

    /// Everything but the derived pictures (redrawn from the rest). The command in flight comes
    /// last, so a state without it (saved by an older version) still loads.
    pub fn export_state(&self, out: &mut Vec<u8>) {
        out.extend_from_slice(&[self.players, self.player, self.mask, trn_code(self.trn), self.trn_wait]);
        for p in self.pals.iter().flatten().chain(&self.sys_pals) { out.extend_from_slice(&p.to_le_bytes()); }
        out.extend_from_slice(&self.attrs);
        out.extend_from_slice(&self.atfs);
        out.extend_from_slice(&self.tiles);
        out.extend_from_slice(&self.map);
        out.push(self.has_border as u8);
        out.extend_from_slice(&[self.last_p1, self.receiving as u8, self.bit as u8]);
        out.extend_from_slice(&self.packet);
        out.push(self.command.len() as u8);
        out.extend_from_slice(&self.command);
    }

    /// With nothing left in `data` (a Game Boy state loaded here), the SGB side starts fresh:
    /// the game sends its colours again at its next scene.
    pub fn import_state(&mut self, data: &[u8], pos: &mut usize) -> bool {
        let mut s = Sgb::new();
        if *pos < data.len() {
            let len = 5 + 32 + CELLS + 512 * 8 + 45 * 90 + 256 * 32 + 0x880 + 1;
            let Some(d) = data.get(*pos..*pos + len) else { return false };
            *pos += len;
            // Values are clamped: a damaged state must not index out of the tables.
            s.players = if matches!(d[0], 2 | 4) { d[0] } else { 1 };
            s.player = d[1] & (s.players - 1);
            s.mask = d[2] & 3;
            s.trn = [Trn::None, Trn::Pal, Trn::Attr, Trn::Chr(false), Trn::Chr(true), Trn::Pct][(d[3] as usize).min(5)];
            // One VBlank more: the frame in progress at the save is not whole after a load
            // (the PPU picture is not in the state), so the transfer reads the next one.
            s.trn_wait = d[4].max(1).saturating_add(1);
            let mut o = 5;
            let mut word = || { let v = u16::from_le_bytes([d[o], d[o + 1]]); o += 2; v };
            for p in s.pals.iter_mut().flatten() { *p = word(); }
            for p in s.sys_pals.iter_mut() { *p = word(); }
            let mut take = |n: usize| { let r = &d[o..o + n]; o += n; r };
            for (a, &b) in s.attrs.iter_mut().zip(take(CELLS)) { *a = b & 3; }
            s.atfs.copy_from_slice(take(45 * 90));
            s.tiles.copy_from_slice(take(256 * 32));
            s.map.copy_from_slice(take(0x880));
            s.has_border = take(1)[0] != 0;
            // The packets of a command received so far: without them the rest would run as
            // commands of their own. Absent from older states.
            if let Some(&[p1, receiving, bit]) = data.get(*pos..*pos + 3) {
                let Some(packet) = data.get(*pos + 3..*pos + 19) else { return false };
                let Some(&n) = data.get(*pos + 19) else { return false };
                let n = n as usize;
                let Some(command) = data.get(*pos + 20..*pos + 20 + n) else { return false };
                *pos += 20 + n;
                s.last_p1 = p1 & 0x30;
                s.receiving = receiving != 0;
                s.bit = (bit as usize).min(128);
                s.packet.copy_from_slice(packet);
                // At most 7 whole packets, and never a finished command.
                if n % 16 == 0 && !command.is_empty() && n / 16 < (command[0] & 7) as usize {
                    s.command.extend_from_slice(command);
                }
            }
        }
        s.pads = self.pads;
        (s.snes_sound, s.snes_frames, s.gb_sound_frames) = (self.snes_sound, self.snes_frames, self.gb_sound_frames);
        s.border_version = self.border_version.wrapping_add(1);
        s.backdrop = u16::MAX;
        s.refresh_border();
        *self = s;
        true
    }
}

impl Sgb {
    /// The game plays its music on the SNES sound chip, which isn't emulated: it sent SOU_TRN,
    /// then kept the Game Boy's own channels off most of the next 10 s (a game that only adds
    /// SNES sound on top of its Game Boy music is not one).
    pub fn snes_music(&self) -> bool {
        self.snes_frames >= SNES_WINDOW && self.gb_sound_frames < SNES_WINDOW / 2
    }
}

fn trn_code(t: Trn) -> u8 {
    match t { Trn::None => 0, Trn::Pal => 1, Trn::Attr => 2, Trn::Chr(false) => 3, Trn::Chr(true) => 4, Trn::Pct => 5 }
}

fn rgba(c: u16) -> [u8; 4] {
    Ppu::rgb555_to_rgba8888(c as u8, (c >> 8) as u8)
}
