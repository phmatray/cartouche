//! Pixel FIFO (Pan Docs, "Pixel FIFO"): mode 3 drawn one dot at a time on every model, so a
//! register written partway through a line takes effect from the pixel it reaches.
//!
//! A BG/window fetcher reads a tile number, its low and its high byte (2 dots each, with the
//! registers of that dot), then pushes the 8 pixels into the BG FIFO once it is empty. Each dot pops
//! one BG pixel (the first SCX % 8 are dropped) with the head of the OBJ FIFO. The line's first
//! fetch is done twice, so the first pixel leaves at dot 12. A popped pixel reaches the LCD
//! `OUT_DELAY` dots later, where it is mixed and coloured with BGP/OBP0/OBP1 (CGB: the BG/OBJ
//! palette RAM) as they are then.
//!
//! The FIFO runs `FIFO_LAG` dots behind mode 3 as the CPU sees it: the last pixels are drawn early
//! in HBlank. Mode 3's end is not known when it starts: once 152 pixels are out (and again after a
//! mid-line write to LCDC, SCX, WY or WX), the rest of the line is run ahead on a copy
//! (`predict_len`), so HBlank starts where the FIFO ends. Both delays are measured with Mealybug
//! Tearoom's DMG and CGB ROMs (`m3_bgp_change`, `m3_scx_high_5_bits`).
//!
//! An OBJ whose X is reached stops the pixels: the fetcher finishes its current tile, then the OBJ
//! row is fetched (6 dots) and merged into the OBJ FIFO, where the pixels already there (lower X,
//! then lower OAM index) keep their place. The window, when x reaches WX - 7, empties the BG FIFO
//! and restarts the fetcher on the window map (6 dots). It shows once WY has matched LY on a line of
//! the frame; turned off and on again, it can start over at a later WX match, on its next row.
//! These waits add up to Pan Docs' "Mode 3 length".
//!
//! CGB mode: the fetcher also reads the tile's attributes from VRAM bank 1 (palette, bank, flips,
//! BG-to-OBJ priority), LCDC bit 0 is the BG/window master priority instead of the BG enable,
//! and OBJs overlap by OAM index unless OPRI bit 0 asks for the DMG's X order. A CGB (in both
//! modes) also latches the tile row with the tile number, as a CGB D does (a CGB C reads it at
//! each data fetch, like a DMG: Mealybug `m3_scy_change2`), shows a BGP write
//! without the DMG's mixed pixel, and LCDC bit 0 one dot later.

use crate::gameboy::Revision;
use crate::ppu::{Ppu, Sprite, SCREEN_WIDTH};
use crate::trace::{LAYER_BG, LAYER_OBJ, LAYER_WIN, NO_OBJ};

/// Dots the fetcher runs behind mode 3 as the CPU sees it, and from a pixel leaving the BG FIFO
/// to the LCD: (DMG, CGB). A CGB fetches 2 dots earlier and shows the pixel at the same time
/// (Mealybug's CGB ROMs: `m3_scx_high_5_bits`, `m3_scy_change`, `m3_lcdc_obj_size_change`).
const FIFO_LAG: [u32; 2] = [8, 6];
const OUT_DELAY: [u32; 2] = [1, 3];
/// Dots left of the 6-dot OBJ fetch when it reads its row's low byte: (DMG, CGB). The high byte
/// comes 2 dots later: on a CGB the fetch's last dot, on a DMG the dot after it, as the pixels
/// resume. Each read uses the OBJ size of its dot (Mealybug `m3_lcdc_obj_size_change` and
/// `m3_lcdc_obj_size_change_scx`, DMG and CGB: an 8x16 → 8x8 write between the two reads gives
/// the 8x8 low byte with the 8x16 high byte).
const OBJ_LO_AT: [u8; 2] = [1, 2];

#[derive(Clone, Copy, Default, PartialEq, Debug)]
pub(crate) enum FetchStep {
    #[default]
    Tile,
    DataLo,
    DataHi,
    Push,
}

#[derive(Clone, Copy, Default)]
pub(crate) struct Fetcher {
    pub step: FetchStep,
    /// Dots already spent in `step` (each of the first three takes 2).
    pub half: bool,
    /// Tiles pushed on this line (BG) or since the window started.
    pub tile_x: u8,
    pub tile: u8,
    pub lo: u8,
    pub hi: u8,
    /// CGB: the tile's attributes (bank 1 of the map).
    pub attr: u8,
    /// CGB: the tile row, latched with the tile number (a CGB D; Mealybug `m3_scy_change`).
    /// A DMG and a CGB C read SCY again for each data byte.
    pub row: u8,
    pub window: bool,
    /// The tile the layer trace records for the pushed pixels: `tile`, or the OBJ's tile when a
    /// CGB TILE_SEL write gave one of the reads that OBJ's data (`tile_sel_switch`).
    pub trace_tile: u8,
    /// A data byte came from $8000-$8FFF (LCDC.4 set at its read, or an OBJ row): with
    /// `trace_tile`, which tile the layer trace records (bit 3 of its `ids`).
    pub from_8000: bool,
}

#[derive(Clone, Copy, Default)]
pub(crate) struct Pixel {
    pub color: u8,
    /// OBJ: 0 OBP0, 1 OBP1 (DMG) or the OBJ palette (CGB); BG: the CGB BG palette.
    pub palette: u8,
    /// OBJ: behind BG colours 1-3; BG (CGB): over OBJs.
    pub bg_priority: bool,
    /// OBJ: its OAM index. BG: the tile number it was fetched with (read only by the layer trace;
    /// it rides here so normal play pays nothing for it).
    pub oam_index: u8,
}

#[derive(Clone, Copy, Default)]
pub(crate) struct PixelFifo {
    pub px: [Pixel; 8],
    pub head: u8,
    pub len: u8,
}

impl PixelFifo {
    #[inline]
    fn pop(&mut self) -> Pixel {
        let p = self.px[self.head as usize];
        self.head = (self.head + 1) & 7;
        self.len -= 1;
        p
    }

    fn clear(&mut self) {
        self.len = 0;
    }
}

#[derive(Clone, Copy, Default)]
pub(crate) struct LineState {
    /// False until the line is set up (and after a save state is loaded: the line is redrawn).
    pub active: bool,
    /// Dots of mode 3 run so far.
    pub dot: u32,
    /// Dots this line runs ahead of the others.
    pub lead: u32,
    /// `FIFO_LAG` and `OUT_DELAY` of the model.
    pub lag: u32,
    pub out_delay: u32,
    /// Mode 3's length as the FIFO measures it: the dot x reached 160.
    pub len: u32,
    /// `Ppu::mode3_len` holds this line's length (`predict_len`), no longer a bound.
    pub measured: bool,
    /// Next screen x to draw; the line is done at 160.
    pub x: u8,
    /// SCX % 8, latched as the first fetch ends.
    pub fine: u8,
    /// BG pixels still to drop at the line start (SCX % 8).
    pub discard: u8,
    /// The OAM X that the next popped pixel reaches (x + 8 once the discard is over).
    pub hit_x: u8,
    pub fetcher: Fetcher,
    /// The line's first fetch, thrown away.
    pub first_fetch: bool,
    pub bg: PixelFifo,
    pub obj: PixelFifo,
    pub sprites: [Sprite; 10],
    pub nsprites: usize,
    /// Bit X set: an OBJ of the line has OAM X = X (so most dots skip the OBJ search).
    pub obj_xs: [u64; 4],
    /// Bit i: `sprites[i]` has been fetched (or passed).
    pub fetched: u16,
    /// OBJ waiting for the fetcher to finish its tile.
    pub obj_pending: Option<u8>,
    /// The running OBJ fetch: OBJ and its row's low byte once read.
    pub obj_fetch: Option<(u8, u8)>,
    /// Dots left of the running OBJ fetch.
    pub obj_dots: u8,
    /// `OBJ_LO_AT` of the model.
    pub obj_lo_at: u8,
    pub window_triggered: bool,
    /// Window restarts on this line after the first: each moves the window to its next row.
    pub win_rows: u8,
    /// The OBJs left of the first real tile have been fetched.
    pub left_done: bool,
    /// Window pixels to drop on a WX below 7.
    pub win_skip: u8,
    /// Traced lines: the line record's registers, taken at the first dot.
    pub record: [u8; 12],
    /// Popped pixels on their way to the LCD, by the dot they were popped (mod 4): (BG, OBJ,
    /// window), `None` on a dot that popped none.
    pub out: [Option<(Pixel, Pixel, bool)>; 4],
    /// Next screen x the LCD shows.
    pub out_x: u8,
    /// LCDC as it was on the previous dot (low byte) and the one before (high byte).
    pub lcdc_prev: u16,
    /// BGP before a write: the next pixel shown mixes both (DMG).
    pub bgp_old: Option<(u8, u32)>,
    /// A register that sets mode 3's length (LCDC, SCX, WY, WX) was written: `measure_len` asks the FIFO again.
    pub relength: bool,
    /// The x the window last started at.
    pub win_x: u8,
    /// WX before the last write, and the last dot the window still compares it (`wx_seen`).
    pub wx_old: u8,
    pub wx_dot: u32,
    /// The high byte of the last OBJ row fetched (kept from line to line), and its tile.
    pub sel_obj: Option<(u8, u8)>,
}

impl Ppu {
    /// Mode 2 → 3: selects the line's OBJs and resets the fetcher.
    pub(crate) fn start_line(&mut self) {
        if self.ly == self.wy { self.window_was_active = true; }
        let (sprites, nsprites) = if self.lcd_on_line0 { ([(0, 0, 0, 0, 0); 10], 0) } else { self.select_sprites(self.ly as usize) };
        let fine = self.scx & 7;
        let mut obj_xs = [0u64; 4];
        for &(x, ..) in &sprites[..nsprites] { obj_xs[x as usize >> 6] |= 1 << (x & 63); }
        self.line = LineState {
            active: true,
            lcdc_prev: self.lcdc as u16 * 0x101,
            fine,
            discard: fine,
            hit_x: 8 - fine,
            first_fetch: true,
            sprites,
            nsprites,
            obj_xs,
            lag: FIFO_LAG[(self.cgb_mode || self.compat) as usize],
            out_delay: OUT_DELAY[(self.cgb_mode || self.compat) as usize],
            obj_lo_at: OBJ_LO_AT[(self.cgb_mode || self.compat) as usize],
            // Line 0 draws one M-cycle earlier after the mode 2 interrupt than the other lines
            // (Mealybug's DMG ROMs make up for it by waiting one M-cycle less on line 0).
            lead: if self.ly == 0 && !self.lcd_on_line0 { 4 } else { 0 },
            sel_obj: self.line.sel_obj,
            ..LineState::default()
        };
        if self.trace.is_some() {
            self.line.record = [
                self.lcdc, self.scx, self.scy, self.wx, self.wy, 0xFF, 0, self.bgp, self.obp0, self.obp1,
                0, if self.lcdc & 0x02 != 0 { nsprites as u8 } else { 0 },
            ];
        }
    }

    /// Runs the line up to `dot` (mode 3's dot count, `MODE0_EARLY` ahead of `mode_clock`).
    pub(crate) fn run_line(&mut self, dot: u32) {
        while self.line.out_x < SCREEN_WIDTH as u8 && self.line.dot + self.line.lag < dot + self.line.lead {
            self.dot();
        }
        if self.line.out_x == SCREEN_WIDTH as u8 { self.end_line(); }
    }

    /// Mode 3's length once most of the line is out (and again after a mid-line LCDC, SCX, WY or
    /// WX write): the FIFO lags mode 3 by `FIFO_LAG` dots, so by the time mode 3 can end, 152
    /// pixels at least are out. Until then `mode3_len` is an upper bound (`MODE3_MAX`).
    pub(crate) fn measure_len(&mut self) {
        if self.line.x >= 152 && (self.line.relength || !self.line.measured) {
            (self.line.relength, self.line.measured) = (false, true);
            // After LCD on, line 0 ends 2 dots later (its mode 3 shows late too).
            self.mode3_len = self.predict_len() + if self.lcd_on_line0 { 2 } else { 0 };
        }
    }

    /// The dot x will reach 160 if no register changes from here: the line run ahead on a copy
    /// (no pixel reaches the LCD). The FIFO lags mode 3, so this is how mode 3 learns its end.
    pub(crate) fn predict_len(&mut self) -> u32 {
        let saved = self.line;
        while self.line.x < SCREEN_WIDTH as u8 {
            self.line.dot += 1;
            self.fifo_dot();
        }
        let len = self.line.len;
        self.line = saved;
        len
    }

    /// The whole line at once.
    #[cfg(test)]
    pub(crate) fn draw_line(&mut self) {
        self.start_line();
        while self.line.out_x < SCREEN_WIDTH as u8 { self.dot(); }
        self.end_line();
    }

    /// The line is drawn: window line counter and trace record.
    pub(crate) fn end_line(&mut self) {
        self.line.active = false;
        let window_line = self.window_line_counter;
        if self.line.window_triggered {
            self.window_line_counter = self.win_line().wrapping_add(1);
        }
        let (line, rec, win_x) = (self.ly as usize, self.line.record, self.wx.saturating_sub(7));
        let (sprites, n) = (self.line.sprites, rec[11] as usize);
        let drawn = self.line.window_triggered;
        let flags = crate::trace::LINE_RENDERED | if self.cgb_mode { crate::trace::LINE_CGB } else { 0 } | self.vram_bank << 2;
        if let Some(t) = self.trace.as_deref_mut() {
            let l = t.building.line_mut(line);
            l[..12].copy_from_slice(&rec);
            l[5] = if drawn { window_line } else { 0xFF };
            l[6] = win_x;
            l[10] = flags;
            for (k, &(x, slot, y, tile, attr)) in sprites[..n].iter().enumerate() {
                l[12 + k * 5..17 + k * 5].copy_from_slice(&[slot as u8, y, x, tile, attr]);
            }
        }
    }

    #[inline]
    fn wy_ok(&self) -> bool {
        self.window_was_active || self.ly == self.wy
    }

    /// LCDC turns the window on (on a DMG, LCDC bit 0 turns it off too).
    #[inline]
    fn win_on(&self) -> bool {
        self.lcdc & 0x20 != 0 && (self.cgb_mode || self.lcdc & 0x01 != 0)
    }

    /// WX as the window compares it: a write reaches it one dot late (Mealybug `m3_wx_5_change`,
    /// `m3_wx_6_change`).
    #[inline]
    fn wx_seen(&self) -> u8 {
        if self.line.dot <= self.line.wx_dot { self.line.wx_old } else { self.wx }
    }

    /// The window row being drawn.
    #[inline]
    fn win_line(&self) -> u8 {
        self.window_line_counter.wrapping_add(self.line.win_rows)
    }

    #[inline]
    fn fetch_tile_row(&self, tile: u8) -> usize {
        if self.lcdc & 0x10 != 0 { tile as usize * 16 } else { (0x1000 + (tile as i8 as i32) * 16) as usize }
    }

    /// VRAM address of the fetched tile's row (CGB: in the attribute's bank, flipped by it).
    #[inline]
    fn fetch_addr(&self) -> usize {
        let f = &self.line.fetcher;
        let row = if (self.cgb_mode || self.compat) && self.rev != Revision::CgbC { f.row } else { self.bg_row() };
        let row = if f.attr & 0x40 != 0 { 7 - row } else { row };
        self.fetch_tile_row(f.tile) + row as usize * 2 + if f.attr & 0x08 != 0 { 0x2000 } else { 0 }
    }

    /// The fetched tile's row (before a CGB Y flip).
    #[inline]
    fn bg_row(&self) -> u8 {
        if self.line.fetcher.window { self.win_line() & 7 } else { self.scy.wrapping_add(self.ly) & 7 }
    }

    /// One dot of the BG/window fetcher.
    #[inline]
    fn fetcher_dot(&mut self) {
        let f = self.line.fetcher;
        if f.step != FetchStep::Push && !f.half {
            self.line.fetcher.half = true;
            return;
        }
        self.line.fetcher.half = false;
        match f.step {
            FetchStep::Tile => {
                let (map, col, row) = if f.window {
                    (self.lcdc & 0x40, f.tile_x & 31, self.win_line() >> 3)
                } else {
                    (self.lcdc & 0x08, (self.scx >> 3).wrapping_add(f.tile_x) & 31, self.scy.wrapping_add(self.ly) >> 3)
                };
                let base = if map != 0 { 0x1C00 } else { 0x1800 };
                // The first tile is fetched twice, but its number is read once (Mealybug `m3_scy_change`).
                if f.window || f.tile_x != 0 || self.line.first_fetch {
                    let at = base + row as usize * 32 + col as usize;
                    self.line.fetcher.tile = self.vram[at];
                    if self.cgb_mode { self.line.fetcher.attr = self.vram[0x2000 + at]; }
                    self.line.fetcher.row = self.bg_row();
                }
                self.line.fetcher.trace_tile = self.line.fetcher.tile;
                self.line.fetcher.step = FetchStep::DataLo;
            }
            FetchStep::DataLo => {
                self.line.fetcher.lo = self.vram[self.fetch_addr()];
                self.line.fetcher.from_8000 = self.lcdc & 0x10 != 0;
                self.line.fetcher.step = FetchStep::DataHi;
            }
            FetchStep::DataHi => {
                self.line.fetcher.hi = self.vram[self.fetch_addr() + 1];
                self.line.fetcher.from_8000 |= self.lcdc & 0x10 != 0;
                self.line.fetcher.half = true; // at Push: the high byte was read on the last dot
                if self.line.first_fetch {
                    // The fine scroll is latched as the first fetch ends (Mealybug `m3_window_timing_wx_0`
                    // takes a SCX write 2 dots before it, `m3_scx_low_3_bits` leaves one 2 dots after it).
                    let fine = self.scx & 7;
                    (self.line.fine, self.line.discard, self.line.hit_x) = (fine, fine, 8 - fine);
                }
                self.line.fetcher.step = FetchStep::Push;
            }
            FetchStep::Push => {
                if self.line.bg.len != 0 { return; }
                if self.line.first_fetch {
                    self.line.first_fetch = false;
                } else {
                    // The tile rides in `oam_index` for the layer trace. Read here from `self`, not
                    // `f`: as `f.tile`, the compiler loads it on every fetcher dot, not once a push.
                    let tile = self.line.fetcher.trace_tile;
                    let bg = &mut self.line.bg;
                    // Bit 3 of a BG pixel's palette: `from_8000`, for the layer trace.
                    let (palette, bg_priority) = (f.attr & 7 | (f.from_8000 as u8) << 3, f.attr & 0x80 != 0);
                    for i in 0..8 {
                        let bit = if f.attr & 0x20 != 0 { i } else { 7 - i };
                        let color = (f.hi >> bit & 1) << 1 | (f.lo >> bit & 1);
                        bg.px[i as usize] = Pixel { color, palette, bg_priority, oam_index: tile };
                    }
                    (bg.head, bg.len) = (0, 8);
                    if f.window && f.tile_x == 0 {
                        (bg.head, bg.len) = (self.line.win_skip, 8 - self.line.win_skip);
                    }
                    self.line.fetcher.tile_x = f.tile_x.wrapping_add(1);
                }
                // The push dot is also the first dot of the next tile number fetch.
                self.line.fetcher.step = FetchStep::Tile;
                self.line.fetcher.half = true;
                if f.window && f.tile_x == 0 {
                    // ponytail: WX 0-6 drops the window's first pixels at no cost (6 dots in all, as
                    // gbmicrotest win0-3 measure) by starting the next fetch early. With WX 0 and a fine
                    // scroll, the window comes one dot later (Mealybug `m3_window_timing_wx_0`). A WX
                    // 0-6 written mid-line is matched on its dot (`fifo_dot`), not per invisible pixel.
                    let early = if self.line.win_skip == 7 && self.line.fine != 0 && !self.cgb_mode { 4 } else { 5 };
                    for _ in 0..self.line.win_skip.min(early) { self.fetcher_dot(); }
                }
            }
        }
    }

    /// CGB (both modes): an LCDC.4 write on the dot right after a tile data read lands inside
    /// that read on hardware, which then gives the tile number ANDed with the byte at the new
    /// address. Fitted to Mealybug `m3_lcdc_tile_sel_change` (CGB D) and Age `m3-bg-lcdc`
    /// (CGB B-E), both directions; a write one dot later or earlier reads plainly, and so does
    /// every write in double speed (Age `m3-bg-lcdc-ds`), which lands elsewhere in the dot.
    /// A write that sets LCDC.4 once an OBJ has been fetched gives instead the high byte of the
    /// last OBJ row fetched, on any line before (Matt Currie's PPU notes, TILE_SEL: "bitplane 1
    /// data from the most recently drawn sprite"). Mealybug `m3_lcdc_tile_sel_change` and
    /// `m3_lcdc_tile_sel_win_change` (CGB D: the tile row beside the first line of an OBJ, which
    /// takes the previous line's OBJ row), `m3_lcdc_tile_sel_change2` and
    /// `m3_lcdc_tile_sel_win_change2` (CGB C: 126 and 109 pixels fewer differ).
    pub(crate) fn tile_sel_switch(&mut self) {
        if !(self.cgb_mode || self.compat) || self.m_cycle_dots != 4 || !self.line.active || self.mode != crate::ppu::PpuMode::Drawing {
            return;
        }
        let f = self.line.fetcher;
        let hi = match (f.step, f.half) {
            (FetchStep::DataHi, false) => false,
            (FetchStep::Push, true) => true,
            _ => return,
        };
        let byte = match self.line.sel_obj {
            // Set: the high byte of the last OBJ row fetched.
            Some((obj_hi, obj_tile)) if self.lcdc & 0x10 != 0 => {
                (self.line.fetcher.trace_tile, self.line.fetcher.from_8000) = (obj_tile, true);
                obj_hi
            }
            _ => f.tile & self.vram[self.fetch_addr() + hi as usize],
        };
        if hi { self.line.fetcher.hi = byte } else { self.line.fetcher.lo = byte }
    }

    /// The OBJ fetch: reads the OBJ's row and merges it into the OBJ FIFO, `shift` pixels already past.
    fn fetch_obj(&mut self, i: usize, shift: u8) {
        let a = self.obj_row(i);
        self.line.sel_obj = Some((self.vram[a + 1], (a >> 4) as u8));
        self.merge_obj(i, shift, self.vram[a], self.vram[a + 1]);
    }

    /// VRAM address of OBJ `i`'s row on this line, with the OBJ size of this dot.
    fn obj_row(&self, i: usize) -> usize {
        let (_, _, y, tile, attr) = self.line.sprites[i];
        let tall = self.lcdc & 0x04 != 0;
        let mut row = self.ly.wrapping_sub(y.wrapping_sub(16)) & if tall { 15 } else { 7 };
        if attr & 0x40 != 0 { row = if tall { 15 } else { 7 } - row; }
        let tile = if tall { tile & 0xFE | row >> 3 } else { tile };
        let bank = if self.cgb_mode && attr & 0x08 != 0 { 0x2000 } else { 0 };
        bank + tile as usize * 16 + (row & 7) as usize * 2
    }

    /// DMG: OBJs turned off (LCDC.1) while an OBJ waits for its fetch or is being fetched stop that
    /// fetch at once; the OBJ is not drawn and the pixels resume on that dot (a CGB fetches it
    /// anyway). A fetch already under way also gives back the dot it had begun: the pixels run one
    /// dot further ahead for the rest of the line, while mode 3 keeps its length (SameBoy's LCDC
    /// write handler ends the PPU's current step at once but counts it in the line). Mealybug
    /// `m3_lcdc_obj_en_change_variant` on the DMG: its BGP stripe, OBJs at X 16 and 17. The OBJs left
    /// of the first tile, already merged, are not undone.
    #[inline]
    fn obj_abort(&self) -> bool {
        self.lcdc & 0x02 == 0 && !(self.cgb_mode || self.compat) && self.line.obj_fetch.is_some() | self.line.obj_pending.is_some()
    }

    /// The running OBJ fetch reads its row's high byte and merges the row into the OBJ FIFO.
    #[inline]
    fn obj_hi(&mut self, i: u8, lo: u8) {
        self.line.obj_fetch = None;
        let a = self.obj_row(i as usize);
        self.line.sel_obj = Some((self.vram[a + 1], (a >> 4) as u8));
        self.merge_obj(i as usize, 0, lo, self.vram[a + 1]);
    }

    fn merge_obj(&mut self, i: usize, shift: u8, lo: u8, hi: u8) {
        let (_, slot, _, _, attr) = self.line.sprites[i];
        let palette = if self.cgb_mode { attr & 7 } else { attr >> 4 & 1 };
        // CGB: the lower OAM index wins where both are opaque (unless OPRI bit 0 asks for X order).
        let by_index = self.cgb_mode && self.opri & 1 == 0;
        let obj = &mut self.line.obj;
        for c in shift..8 {
            let bit = if attr & 0x20 != 0 { c } else { 7 - c };
            let px = Pixel { color: (hi >> bit & 1) << 1 | (lo >> bit & 1), palette, bg_priority: attr & 0x80 != 0, oam_index: slot as u8 };
            let k = c - shift;
            let at = ((obj.head + k) & 7) as usize;
            let old = obj.px[at];
            // A transparent pixel gives its place.
            if k >= obj.len || old.color == 0 || by_index && px.color != 0 && px.oam_index < old.oam_index {
                obj.px[at] = px;
            }
        }
        obj.len = obj.len.max(8 - shift);
    }

    /// The first OBJ still to fetch at the current X, in OAM order.
    #[inline]
    fn obj_hit(&self) -> Option<usize> {
        if self.lcdc & 0x02 == 0 { return None; }
        let l = &self.line;
        if l.obj_xs[l.hit_x as usize >> 6] & 1 << (l.hit_x & 63) == 0 { return None; }
        (0..l.nsprites).find(|&i| l.fetched & 1 << i == 0 && l.sprites[i].0 == l.hit_x)
    }

    /// OBJs left of the first real tile (OAM X + SCX % 8 below 8) are fetched before the first
    /// pixel: X 0 costs 11 dots, the others 6 plus, for the first, 5 minus X + SCX % 8.
    fn fetch_left_objs(&mut self) -> u32 {
        if self.lcdc & 0x02 == 0 { return 0; }
        let fine = self.line.fine;
        let mut order: [(u8, usize); 10] = [(0, 0); 10];
        let mut n = 0;
        for i in 0..self.line.nsprites {
            let x = self.line.sprites[i].0;
            if x < 8 - fine {
                order[n] = (x, i);
                n += 1;
            }
        }
        order[..n].sort_unstable();
        let (mut cost, mut paid0, mut paid) = (0, false, false);
        for &(x, i) in &order[..n] {
            cost += 6;
            if x == 0 && !paid0 {
                paid0 = true;
                cost += 5;
            } else if x != 0 && !paid {
                paid = true;
                cost += 5u32.saturating_sub((x + fine) as u32);
            }
            self.line.fetched |= 1 << i;
            self.fetch_obj(i, 8 - fine - x);
        }
        cost
    }

    /// One dot of mode 3 (and of its last pixels' way to the LCD in HBlank).
    pub(crate) fn dot(&mut self) {
        self.line.dot += 1;
        if self.line.x < SCREEN_WIDTH as u8 { self.fifo_dot(); }
        if let Some((bg, obj, window)) = self.line.out[self.line.dot.wrapping_sub(self.line.out_delay) as usize & 3].take() {
            self.output_pixel(bg, obj, window);
        }
        self.line.lcdc_prev = self.line.lcdc_prev << 8 | self.lcdc as u16;
    }

    #[inline(always)]
    fn fifo_dot(&mut self) {
        // WX 0-6 is matched before x = 0 (x = WX - 7), while the first tile is being fetched; the
        // first match holds (a later WX 0-6 match on the same line is no new start).
        if self.line.dot <= 12 && self.line.win_skip == 0 {
            let wx = self.wx_seen();
            if wx < 7 && self.line.dot == 6 + wx as u32 && self.win_on() && self.wy_ok() {
                self.line.win_skip = 7 - wx;
            }
        }
        if self.line.obj_dots > 0 && self.obj_abort() {
            (self.line.obj_dots, self.line.obj_fetch) = (0, None);
            self.line.lead += 1; // the fetch dot it had begun (`obj_abort`)
        }
        if self.line.obj_dots > 0 {
            self.line.obj_dots -= 1;
            self.line.fetcher.half = false; // the fetcher waits at Push: its last read is past
            // The OBJ row's low byte, then its high byte, each read with the OBJ size of its dot.
            if let Some((i, lo)) = self.line.obj_fetch {
                if self.line.obj_dots == self.line.obj_lo_at {
                    self.line.obj_fetch = Some((i, self.vram[self.obj_row(i as usize)]));
                } else if self.line.obj_dots + 2 == self.line.obj_lo_at {
                    self.obj_hi(i, lo);
                }
            }
            return;
        }
        if let Some((i, lo)) = self.line.obj_fetch {
            self.obj_hi(i, lo); // DMG: the high byte, on the dot the pixels resume
        }
        // The first real tile waits at the push while the OBJs left of it are fetched.
        if !self.line.left_done && !self.line.first_fetch && self.line.fetcher.step == FetchStep::Push {
            self.line.left_done = true;
            let cost = self.fetch_left_objs();
            if cost > 0 {
                self.line.obj_dots = cost as u8 - 1;
                return;
            }
        }
        // Window: at x = WX - 7 (x = 0 for WX 0-6), once the line has started and the fine scroll is
        // dropped, the BG FIFO is emptied and the fetcher restarts on the window map.
        let x = self.line.x;
        if !self.line.fetcher.window && self.line.left_done && self.line.discard == 0 && self.win_on()
            && if self.line.win_skip > 0 { x == 0 } else { self.wy_ok() && x + 7 == self.wx_seen() }
        {
            // Turned off and on again, the window starts over on its next row.
            if self.line.window_triggered { self.line.win_rows += 1; }
            self.line.window_triggered = true;
            self.line.win_x = x;
            self.line.bg.clear();
            self.line.fetcher = Fetcher { window: true, ..Fetcher::default() };
        } else if self.line.fetcher.window && self.line.bg.len == 0 && x + 7 == self.wx_seen() && x != self.line.win_x && self.win_on() {
            // WX matched again while the window runs: between two of its tiles, the LCD gets one
            // colour-0 pixel and the window goes on a pixel later (Mealybug `m3_wx_4_change`,
            // `m3_wx_5_change`); inside a tile nothing shows.
            let bg = &mut self.line.bg;
            bg.px[0] = Pixel::default();
            (bg.head, bg.len) = (0, 1);
        } else if self.line.fetcher.window && self.lcdc & 0x20 == 0 {
            self.line.fetcher.window = false; // window switched off: back to the BG map
        }
        self.fetcher_dot();
        if self.line.bg.len == 0 { return; }
        if self.line.obj_pending.is_some() && self.obj_abort() {
            self.line.obj_pending = None;
        }
        if let Some(i) = self.line.obj_pending {
            // Waiting for the fetcher to finish its tile, then 6 dots of OBJ fetch.
            if self.line.fetcher.step == FetchStep::Push {
                self.line.obj_pending = None;
                self.line.obj_fetch = Some((i, 0));
                self.line.obj_dots = 5;
            }
            return;
        }
        if let Some(i) = self.obj_hit() {
            self.line.fetched |= 1 << i;
            if self.line.fetcher.step == FetchStep::Push {
                self.line.obj_fetch = Some((i as u8, 0));
                self.line.obj_dots = 5;
            } else {
                self.line.obj_pending = Some(i as u8);
            }
            return;
        }
        self.pop_pixel();
    }

    #[inline]
    fn pop_pixel(&mut self) {
        let bg = self.line.bg.pop();
        let obj = if self.line.obj.len > 0 { self.line.obj.pop() } else { Pixel::default() };
        self.line.hit_x = self.line.hit_x.wrapping_add(1);
        if self.line.discard > 0 {
            self.line.discard -= 1;
            return;
        }
        self.line.x += 1;
        if self.line.x == SCREEN_WIDTH as u8 { self.line.len = self.line.dot; }
        let l = &mut self.line;
        let window = l.fetcher.window && l.window_triggered;
        l.out[l.dot as usize & 3] = Some((bg, obj, window));
    }

    /// A pixel reaches the LCD: mixed and paletted with the registers of this dot.
    #[inline]
    fn output_pixel(&mut self, bg: Pixel, obj: Pixel, window: bool) {
        let x = self.line.out_x as usize;
        self.line.out_x += 1;
        let obj_on = obj.color != 0 && self.lcdc & 0x02 != 0;
        let (bg_id, bg_color, obj_color, shown);
        if self.cgb_mode {
            // LCDC bit 0 off: OBJs over everything; on: over BG colour 0, or where neither the
            // OBJ nor the tile asks for the BG in front.
            bg_id = bg.color;
            shown = obj_on && (self.lcdc & 0x01 == 0 || bg_id == 0 || !(obj.bg_priority || bg.bg_priority));
            obj_color = obj_on.then(|| self.get_obj_cram_color(obj.palette, obj.color));
            bg_color = self.get_bg_cram_color(bg.palette & 7, bg_id);
        } else {
            // A DMG shows the dot of a BGP write with both values mixed, a CGB (compatibility mode)
            // the new one (Mealybug `m3_bgp_change`).
            let bgp = match self.line.bgp_old.take() {
                Some((old, dot)) if dot + 1 >= self.line.dot && !self.compat => self.bgp | old,
                _ => self.bgp,
            };
            // BG enable reaches the LCD one dot after BGP does, two on a CGB (`m3_lcdc_bg_en_change`).
            let lcdc = if self.compat { self.line.lcdc_prev >> 8 } else { self.line.lcdc_prev };
            bg_id = if lcdc & 0x01 != 0 { bg.color } else { 0 };
            shown = obj_on && !(obj.bg_priority && bg_id != 0);
            obj_color = obj_on.then(|| self.apply_palette(if obj.palette != 0 { self.obp1 } else { self.obp0 }, obj.color, 1 + obj.palette));
            bg_color = self.apply_palette(bgp, bg_id, 0);
        }
        let line = self.ly as usize;
        self.set_pixel(x, line, if shown { obj_color.unwrap() } else { bg_color });
        if self.trace.is_some() {
            self.trace_pixel(x, window, bg_id | (bg.bg_priority as u8) << 2 | bg.palette & 8, bg.oam_index, bg_color, obj, obj_color, shown);
        }
    }

    /// Traced lines: the planes and info of the pixel just drawn (layout in `trace.rs`).
    /// `ids`: the BG colour id, and in bit 2 the CGB tile's priority over OBJs; `tile`: the BG/window
    /// tile number it was fetched with.
    #[allow(clippy::too_many_arguments)]
    fn trace_pixel(&mut self, x: usize, window: bool, ids: u8, tile: u8, bg_color: [u8; 4], obj: Pixel, obj_color: Option<[u8; 4]>, shown: bool) {
        // The BG plane runs under the window too: sample it where the window covers it.
        let under = if window && (self.cgb_mode || self.lcdc & 0x01 != 0) {
            let (sx, sy) = (self.scx.wrapping_add(x as u8), self.scy.wrapping_add(self.ly));
            let at = if self.lcdc & 0x08 != 0 { 0x1C00 } else { 0x1800 } + (sy >> 3) as usize * 32 + (sx >> 3) as usize;
            let attr = if self.cgb_mode { self.vram[0x2000 + at] } else { 0 };
            let (row, col) = (if attr & 0x40 != 0 { 7 - (sy & 7) } else { sy & 7 }, if attr & 0x20 != 0 { 7 - (sx & 7) } else { sx & 7 });
            let a = self.fetch_tile_row(self.vram[at]) + row as usize * 2 + if attr & 0x08 != 0 { 0x2000 } else { 0 };
            let id = (self.vram[a + 1] >> (7 - col) & 1) << 1 | (self.vram[a] >> (7 - col) & 1);
            if self.cgb_mode { self.get_bg_cram_color(attr & 7, id) } else { self.apply_palette(self.bgp, id, 0) }
        } else if window {
            self.apply_palette(self.bgp, 0, 0)
        } else {
            bg_color
        };
        let attr = if obj_color.is_some() { self.oam[obj.oam_index as usize * 4 + 3] } else { 0 };
        let Some(t) = self.trace.as_deref_mut() else { return };
        let p = (self.ly as usize * SCREEN_WIDTH + x) * 4;
        let b = &mut t.building;
        b.bg[p..p + 4].copy_from_slice(&under);
        b.win[p..p + 4].copy_from_slice(&if window { bg_color } else { [0; 4] });
        b.obj[p..p + 4].copy_from_slice(&obj_color.unwrap_or([0; 4]));
        let layer = if shown { LAYER_OBJ } else if window { LAYER_WIN } else { LAYER_BG };
        let slot = if obj_color.is_some() { obj.oam_index } else { NO_OBJ };
        let cid = if obj_color.is_some() { obj.color } else { 0 };
        b.info[p..p + 4].copy_from_slice(&[layer, slot, ids | cid << 4, attr]);
        b.tile[p / 4] = tile;
    }
}
