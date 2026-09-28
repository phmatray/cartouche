//! DMG pixel FIFO (Pan Docs, "Pixel FIFO"): mode 3 drawn one dot at a time, so a register written
//! partway through a line takes effect from the pixel it reaches.
//!
//! A BG/window fetcher reads a tile number, its low and its high byte (2 dots each, with the
//! registers of that dot), then pushes the 8 pixels into the BG FIFO once it is empty. Each dot pops
//! one BG pixel (the first SCX % 8 are dropped) with the head of the OBJ FIFO. The line's first
//! fetch is done twice, so the first pixel leaves at dot 12. A popped pixel reaches the LCD
//! `OUT_DELAY` dots later, where it is mixed and coloured with BGP/OBP0/OBP1 as they are then.
//!
//! The FIFO runs `FIFO_LAG` dots behind mode 3 as the CPU sees it: the last pixels are drawn early
//! in HBlank. Mode 3 starts with `Ppu::mode3_length`'s length; a mid-line write to LCDC, WY or WX
//! runs the rest of the line ahead on a copy (`predict_len`), so HBlank starts where the FIFO ends. Both delays are measured
//! with Mealybug Tearoom's DMG ROMs (`m3_bgp_change`, `m3_scx_high_5_bits`).
//!
//! An OBJ whose X is reached stops the pixels: the fetcher finishes its current tile, then the OBJ
//! row is fetched (6 dots) and merged into the OBJ FIFO, where the pixels already there (lower X,
//! then lower OAM index) keep their place. The window, when x reaches WX - 7, empties the BG FIFO
//! and restarts the fetcher on the window map (6 dots). It shows once WY has matched LY on a line of
//! the frame; turned off and on again, it can start over at a later WX match, on its next row. These waits add up to the lengths
//! `Ppu::mode3_length` predicts (Pan Docs, "Mode 3 length").
//!
//! The CGB draws with `render_scanline_cgb` until its own FIFO lands (#156).

use crate::ppu::{Ppu, Sprite, SCREEN_WIDTH};
use crate::trace::{LAYER_BG, LAYER_OBJ, LAYER_WIN, NO_OBJ};

/// Dots the fetcher runs behind mode 3 as the CPU sees it.
const FIFO_LAG: u32 = 8;
/// Dots from a pixel leaving the BG FIFO to the LCD.
const OUT_DELAY: u32 = 1;
/// Dots left of the 6-dot OBJ fetch when it reads its row's low, then high byte (Mealybug
/// `m3_lcdc_obj_size_change`: each read uses the OBJ size of its dot).
const OBJ_LO_AT: u8 = 2;
const OBJ_HI_AT: u8 = 0;

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
    pub window: bool,
}

#[derive(Clone, Copy, Default)]
pub(crate) struct Pixel {
    pub color: u8,
    /// OBJ: 0 OBP0, 1 OBP1.
    pub palette: u8,
    pub bg_priority: bool,
    pub oam_index: u8,
}

#[derive(Clone, Copy, Default)]
pub(crate) struct PixelFifo {
    pub px: [Pixel; 8],
    pub head: u8,
    pub len: u8,
}

impl PixelFifo {
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
    /// Mode 3's length as the FIFO measures it: the dot x reached 160 (`Ppu::mode3_length` predicts it).
    pub len: u32,
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
    /// Bit i: `sprites[i]` has been fetched (or passed).
    pub fetched: u16,
    /// OBJ waiting for the fetcher to finish its tile.
    pub obj_pending: Option<u8>,
    /// The running OBJ fetch: OBJ and its row's low byte once read.
    pub obj_fetch: Option<(u8, u8)>,
    /// Dots left of the running OBJ fetch.
    pub obj_dots: u8,
    pub window_triggered: bool,
    /// Window restarts on this line after the first: each moves the window to its next row.
    pub win_rows: u8,
    /// The OBJs left of the first real tile have been fetched.
    pub left_done: bool,
    /// Window pixels to drop on a WX below 7.
    pub win_skip: u8,
    /// Traced lines: the line record's registers, taken at the first dot.
    pub record: [u8; 12],
    /// Popped pixels on their way to the LCD: (BG, OBJ, window, dot popped).
    pub out: [(Pixel, Pixel, bool, u32); 16],
    pub out_head: u8,
    pub out_len: u8,
    /// Next screen x the LCD shows.
    pub out_x: u8,
    /// LCDC as it was on the previous dot.
    pub lcdc_prev: u8,
    /// BGP before a write: the next pixel shown mixes both (DMG).
    pub bgp_old: Option<(u8, u32)>,
    /// A register that sets mode 3's length (LCDC, WY, WX) was written: `Ppu::step` asks the FIFO again.
    pub relength: bool,
}

impl Ppu {
    /// Mode 2 → 3 on a DMG: selects the line's OBJs and resets the fetcher.
    pub(crate) fn start_line(&mut self) {
        if self.ly == self.wy { self.window_was_active = true; }
        let (sprites, nsprites) = if self.lcd_on_line0 { ([(0, 0, 0, 0, 0); 10], 0) } else { self.select_sprites(self.ly as usize) };
        let fine = self.scx & 7;
        self.line = LineState {
            active: true,
            lcdc_prev: self.lcdc,
            fine,
            discard: fine,
            hit_x: 8 - fine,
            first_fetch: true,
            sprites,
            nsprites,
            // Line 0 draws one M-cycle earlier after the mode 2 interrupt than the other lines
            // (Mealybug's DMG ROMs make up for it by waiting one M-cycle less on line 0).
            lead: if self.ly == 0 && !self.lcd_on_line0 { 4 } else { 0 },
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
        while self.line.out_x < SCREEN_WIDTH as u8 && self.line.dot + FIFO_LAG < dot + self.line.lead {
            self.dot_dmg();
        }
        if self.line.out_x == SCREEN_WIDTH as u8 { self.end_line_dmg(); }
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

    /// The whole line at once (tests and callers outside `step`).
    pub(crate) fn draw_line_dmg(&mut self) {
        self.start_line();
        while self.line.out_x < SCREEN_WIDTH as u8 { self.dot_dmg(); }
        self.end_line_dmg();
    }

    /// The line is drawn: window line counter and trace record.
    pub(crate) fn end_line_dmg(&mut self) {
        self.line.active = false;
        let window_line = self.window_line_counter;
        if self.line.window_triggered {
            self.window_line_counter = self.win_line().wrapping_add(1);
        }
        let (line, rec, win_x) = (self.ly as usize, self.line.record, self.wx.saturating_sub(7));
        let (sprites, n) = (self.line.sprites, rec[11] as usize);
        let drawn = self.line.window_triggered;
        let flags = crate::trace::LINE_RENDERED | self.vram_bank << 2;
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

    fn wy_ok(&self) -> bool {
        self.window_was_active || self.ly == self.wy
    }

    /// The window row being drawn.
    fn win_line(&self) -> u8 {
        self.window_line_counter.wrapping_add(self.line.win_rows)
    }

    fn fetch_tile_row(&self, tile: u8) -> usize {
        if self.lcdc & 0x10 != 0 { tile as usize * 16 } else { (0x1000 + (tile as i8 as i32) * 16) as usize }
    }

    fn fetch_row(&self) -> u8 {
        if self.line.fetcher.window { self.win_line() & 7 } else { self.scy.wrapping_add(self.ly) & 7 }
    }

    /// One dot of the BG/window fetcher.
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
                    self.line.fetcher.tile = self.vram[base + row as usize * 32 + col as usize];
                }
                self.line.fetcher.step = FetchStep::DataLo;
            }
            FetchStep::DataLo => {
                self.line.fetcher.lo = self.vram[self.fetch_tile_row(f.tile) + self.fetch_row() as usize * 2];
                self.line.fetcher.step = FetchStep::DataHi;
            }
            FetchStep::DataHi => {
                self.line.fetcher.hi = self.vram[self.fetch_tile_row(f.tile) + self.fetch_row() as usize * 2 + 1];
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
                    let bg = &mut self.line.bg;
                    for i in 0..8 {
                        let bit = 7 - i;
                        bg.px[i as usize].color = (f.hi >> bit & 1) << 1 | (f.lo >> bit & 1);
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
                    // scroll, the window comes one dot later (Mealybug `m3_window_timing_wx_0`). WX
                    // written mid-line below 7 (`m3_wx_4/5/6_change`) is not modelled.
                    let early = if self.line.win_skip == 7 && self.line.fine != 0 { 4 } else { 5 };
                    for _ in 0..self.line.win_skip.min(early) { self.fetcher_dot(); }
                }
            }
        }
    }

    /// The OBJ fetch: reads the OBJ's row and merges it into the OBJ FIFO, `shift` pixels already past.
    fn fetch_obj(&mut self, i: usize, shift: u8) {
        let a = self.obj_row(i);
        self.merge_obj(i, shift, self.vram[a], self.vram[a + 1]);
    }

    /// VRAM address of OBJ `i`'s row on this line, with the OBJ size of this dot.
    fn obj_row(&self, i: usize) -> usize {
        let (_, _, y, tile, attr) = self.line.sprites[i];
        let tall = self.lcdc & 0x04 != 0;
        let mut row = self.ly.wrapping_sub(y.wrapping_sub(16)) & if tall { 15 } else { 7 };
        if attr & 0x40 != 0 { row = if tall { 15 } else { 7 } - row; }
        let tile = if tall { tile & 0xFE | row >> 3 } else { tile };
        tile as usize * 16 + (row & 7) as usize * 2
    }

    fn merge_obj(&mut self, i: usize, shift: u8, lo: u8, hi: u8) {
        let (_, slot, _, _, attr) = self.line.sprites[i];
        let obj = &mut self.line.obj;
        for c in shift..8 {
            let bit = if attr & 0x20 != 0 { c } else { 7 - c };
            let px = Pixel { color: (hi >> bit & 1) << 1 | (lo >> bit & 1), palette: attr >> 4 & 1, bg_priority: attr & 0x80 != 0, oam_index: slot as u8 };
            let k = c - shift;
            let at = ((obj.head + k) & 7) as usize;
            if k >= obj.len {
                obj.px[at] = px;
            } else if obj.px[at].color == 0 {
                obj.px[at] = px; // a transparent pixel gives its place
            }
        }
        obj.len = obj.len.max(8 - shift);
    }

    /// The first OBJ still to fetch at the current X, in OAM order.
    fn obj_hit(&self) -> Option<usize> {
        if self.lcdc & 0x02 == 0 { return None; }
        let l = &self.line;
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

    /// One dot of mode 3 on a DMG (and of its last pixels' way to the LCD in HBlank).
    pub(crate) fn dot_dmg(&mut self) {
        self.line.dot += 1;
        if self.line.x < SCREEN_WIDTH as u8 { self.fifo_dot(); }
        while self.line.out_len > 0 && self.line.out[self.line.out_head as usize].3 + OUT_DELAY <= self.line.dot {
            let (bg, obj, window, _) = self.line.out[self.line.out_head as usize];
            self.line.out_head = (self.line.out_head + 1) & 15;
            self.line.out_len -= 1;
            self.output_pixel(bg, obj, window);
        }
        self.line.lcdc_prev = self.lcdc;
    }

    fn fifo_dot(&mut self) {
        // WX 0-6 is matched before x = 0 (x = WX - 7), while the first tile is being fetched.
        if self.wx < 7 && self.line.dot == 6 + self.wx as u32 && self.lcdc & 0x21 == 0x21 && self.wy_ok() {
            self.line.win_skip = 7 - self.wx;
        }
        if self.line.obj_dots > 0 {
            self.line.obj_dots -= 1;
            // The OBJ row's low byte, then its high byte, each read with the OBJ size of its dot.
            if let Some((i, lo)) = self.line.obj_fetch {
                let a = self.obj_row(i as usize);
                if self.line.obj_dots == OBJ_LO_AT { self.line.obj_fetch = Some((i, self.vram[a])); }
                if self.line.obj_dots == OBJ_HI_AT {
                    self.line.obj_fetch = None;
                    self.merge_obj(i as usize, 0, lo, self.vram[a + 1]);
                }
            }
            return;
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
        if !self.line.fetcher.window && self.line.left_done && self.line.discard == 0 && self.lcdc & 0x21 == 0x21
            && if self.line.win_skip > 0 { x == 0 } else { self.wy_ok() && x + 7 == self.wx }
        {
            // Turned off and on again, the window starts over on its next row.
            if self.line.window_triggered { self.line.win_rows += 1; }
            self.line.window_triggered = true;
            self.line.bg.clear();
            self.line.fetcher = Fetcher { window: true, ..Fetcher::default() };
        } else if self.line.fetcher.window && self.lcdc & 0x20 == 0 {
            self.line.fetcher.window = false; // window switched off: back to the BG map
        }
        self.fetcher_dot();
        if self.line.bg.len == 0 { return; }
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
        l.out[((l.out_head + l.out_len) & 15) as usize] = (bg, obj, window, l.dot);
        l.out_len += 1;
    }

    /// A pixel reaches the LCD: mixed and paletted with the registers of this dot.
    fn output_pixel(&mut self, bg: Pixel, obj: Pixel, window: bool) {
        let x = self.line.out_x as usize;
        self.line.out_x += 1;
        let bgp = match self.line.bgp_old.take() {
            Some((old, dot)) if dot + 1 >= self.line.dot => self.bgp | old, // the dot of the write
            _ => self.bgp,
        };
        // BG enable reaches the LCD one dot after BGP does.
        let bg_id = if self.line.lcdc_prev & 0x01 != 0 { bg.color } else { 0 };
        let obj_on = obj.color != 0 && self.lcdc & 0x02 != 0;
        let shown = obj_on && !(obj.bg_priority && bg_id != 0);
        let obj_color = obj_on.then(|| self.apply_palette(if obj.palette != 0 { self.obp1 } else { self.obp0 }, obj.color, 1 + obj.palette));
        let bg_color = self.apply_palette(bgp, bg_id, 0);
        let line = self.ly as usize;
        self.set_pixel(x, line, if shown { obj_color.unwrap() } else { bg_color });
        if self.trace.is_some() {
            self.trace_pixel(x, window, bg_id, bg_color, obj, obj_color, shown);
        }
    }

    /// Traced lines: the planes and info of the pixel just drawn (layout in `trace.rs`).
    fn trace_pixel(&mut self, x: usize, window: bool, bg_id: u8, bg_color: [u8; 4], obj: Pixel, obj_color: Option<[u8; 4]>, shown: bool) {
        // The BG plane runs under the window too: sample it where the window covers it.
        let under = if window && self.lcdc & 0x01 != 0 {
            let (sx, sy) = (self.scx.wrapping_add(x as u8), self.scy.wrapping_add(self.ly));
            let map = if self.lcdc & 0x08 != 0 { 0x1C00 } else { 0x1800 };
            let tile = self.vram[map + (sy >> 3) as usize * 32 + (sx >> 3) as usize];
            let id = self.get_tile_pixel(self.fetch_tile_row(tile), sy & 7, sx & 7);
            self.apply_palette(self.bgp, id, 0)
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
        b.info[p..p + 4].copy_from_slice(&[layer, slot, bg_id | cid << 4, attr]);
    }
}
