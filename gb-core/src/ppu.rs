pub const SCREEN_WIDTH: usize = 160;
pub const SCREEN_HEIGHT: usize = 144;
pub const FRAMEBUFFER_SIZE: usize = SCREEN_WIDTH * SCREEN_HEIGHT * 4;

use crate::trace::{Tracer, LAYER_BG, LAYER_OBJ, LAYER_WIN, LINE_CGB, LINE_RENDERED, NO_OBJ};

/// An OBJ selected for a scanline: (x, OAM slot, y, tile, attributes), raw OAM values.
type Sprite = (u8, usize, u8, u8, u8);

pub const PALETTE_COLORS: [[u8; 4]; 4] = [
    [0xE0, 0xF8, 0xD0, 0xFF], // lightest
    [0x88, 0xC0, 0x70, 0xFF], // light
    [0x34, 0x68, 0x56, 0xFF], // dark
    [0x08, 0x18, 0x20, 0xFF], // darkest
];

#[derive(Debug, Clone, Copy, PartialEq)]
pub enum PpuMode {
    HBlank = 0,
    VBlank = 1,
    OamScan = 2,
    Drawing = 3,
}

pub struct Ppu {
    // LCD registers
    pub lcdc: u8,  // FF40
    pub stat: u8,  // FF41
    pub scy: u8,   // FF42
    pub scx: u8,   // FF43
    pub ly: u8,    // FF44
    pub lyc: u8,   // FF45
    pub bgp: u8,   // FF47
    pub obp0: u8,  // FF48
    pub obp1: u8,  // FF49
    pub wy: u8,    // FF4A
    pub wx: u8,    // FF4B

    pub vram: [u8; 0x4000],
    pub vram_bank: u8,
    pub oam: [u8; 0xA0],

    pub mode: PpuMode,
    pub mode_clock: u32,
    pub window_line_counter: u8,
    pub(crate) window_was_active: bool,
    /// First line after the LCD is switched on: no OAM scan (STAT reads mode 0)
    /// and the line is 4 dots short.
    pub(crate) lcd_on_line0: bool,

    pub framebuffer: [u8; FRAMEBUFFER_SIZE],
    pub frame_ready: bool,

    // Per-scanline BG color ID buffer for OBJ-to-BG priority
    bg_color_ids: [u8; SCREEN_WIDTH],

    // STAT interrupt line — used for rising-edge detection to avoid re-firing
    pub(crate) stat_irq_line: bool,

    // CGB color support
    pub cgb_mode: bool,
    /// A CGB running a DMG cartridge: drawn like a DMG, coloured through BG palette 0 and OBJ palettes 0-1.
    pub compat: bool,
    pub bg_cram: [u8; 64],
    pub obj_cram: [u8; 64],
    pub bcps: u8,
    pub ocps: u8,
    bg_cgb_priority: [bool; SCREEN_WIDTH],

    /// Per-frame layer trace; `None` (the default) in normal play. See `trace.rs`.
    pub trace: Option<Box<Tracer>>,
    /// Traced lines only: `[slot, colour id, attr, drawn]` of the OBJ claiming each dot.
    line_obj: [[u8; 4]; SCREEN_WIDTH],
}

impl Ppu {
    pub fn new() -> Self {
        Self {
            lcdc: 0,
            stat: 0,
            scy: 0,
            scx: 0,
            ly: 0,
            lyc: 0,
            bgp: 0,
            obp0: 0,
            obp1: 0,
            wy: 0,
            wx: 0,
            vram: [0; 0x4000],
            vram_bank: 0,
            oam: [0; 0xA0],
            mode: PpuMode::OamScan,
            mode_clock: 0,
            window_line_counter: 0,
            window_was_active: false,
            lcd_on_line0: false,
            framebuffer: [0; FRAMEBUFFER_SIZE],
            frame_ready: false,
            bg_color_ids: [0; SCREEN_WIDTH],
            stat_irq_line: false,
            cgb_mode: false,
            compat: false,
            bg_cram: [0; 64],
            obj_cram: [0; 64],
            bcps: 0,
            ocps: 0,
            bg_cgb_priority: [false; SCREEN_WIDTH],
            trace: None,
            line_obj: [[NO_OBJ, 0, 0, 0]; SCREEN_WIDTH],
        }
    }

    /// Turns the per-frame layer trace on or off (off drops its buffers).
    pub fn set_tracing(&mut self, on: bool) {
        if on != self.trace.is_some() {
            self.trace = on.then(Box::default);
        }
    }

    pub fn read_vram(&self, offset: u16) -> u8 {
        self.vram[(self.vram_bank as usize) * 0x2000 + offset as usize]
    }

    pub fn write_vram(&mut self, offset: u16, value: u8) {
        self.vram[(self.vram_bank as usize) * 0x2000 + offset as usize] = value;
    }

    pub fn read_oam(&self, offset: u16) -> u8 {
        self.oam[offset as usize]
    }

    pub fn write_oam(&mut self, offset: u16, value: u8) {
        self.oam[offset as usize] = value;
    }

    pub fn read_register(&self, addr: u16) -> u8 {
        match addr {
            0xFF40 => self.lcdc,
            0xFF41 => {
                let mode_bits = if self.lcd_on_line0 { 0 } else { self.mode as u8 };
                // With the LCD off the coincidence bit is frozen at its LCD-off value
                // (kept in stored bit 2). Bit 7 is unused and always reads 1.
                let lyc_flag = if self.lcdc & 0x80 == 0 { self.stat & 0x04 }
                    else if self.ly == self.lyc { 0x04 } else { 0 };
                0x80 | (self.stat & 0x78) | lyc_flag | mode_bits
            }
            0xFF42 => self.scy,
            0xFF43 => self.scx,
            0xFF44 => self.ly,
            0xFF45 => self.lyc,
            0xFF47 => self.bgp,
            0xFF48 => self.obp0,
            0xFF49 => self.obp1,
            0xFF4A => self.wy,
            0xFF4B => self.wx,
            0xFF4F => 0xFE | self.vram_bank,
            0xFF68 => self.bcps | 0x40, // bit 6 is unused and reads 1
            0xFF69 => self.bg_cram[(self.bcps & 0x3F) as usize],
            0xFF6A => self.ocps | 0x40,
            0xFF6B => self.obj_cram[(self.ocps & 0x3F) as usize],
            _ => 0xFF,
        }
    }

    pub fn write_register(&mut self, addr: u16, value: u8) {
        match addr {
            0xFF40 => {
                let was_enabled = self.lcdc & 0x80 != 0;
                self.lcdc = value;
                let is_enabled = self.lcdc & 0x80 != 0;
                if was_enabled && !is_enabled {
                    let lyc_flag = if self.ly == self.lyc { 0x04 } else { 0 };
                    self.stat = (self.stat & !0x04) | lyc_flag;
                    self.ly = 0;
                    self.mode = PpuMode::HBlank;
                    self.mode_clock = 0;
                    self.stat_irq_line = false;
                    self.lcd_on_line0 = false;
                } else if !was_enabled && is_enabled {
                    // Line 0 restarts 4 dots in, without an OAM scan.
                    self.mode = PpuMode::OamScan;
                    self.mode_clock = 4;
                    self.lcd_on_line0 = true;
                }
            }
            0xFF41 => self.stat = (value & 0x78) | (self.stat & 0x07),
            0xFF42 => self.scy = value,
            0xFF43 => self.scx = value,
            0xFF44 => {}
            0xFF45 => self.lyc = value,
            0xFF47 => self.bgp = value,
            0xFF48 => self.obp0 = value,
            0xFF49 => self.obp1 = value,
            0xFF4A => self.wy = value,
            0xFF4B => self.wx = value,
            0xFF4F => self.vram_bank = value & 0x01,
            0xFF68 => self.bcps = value,
            0xFF69 => {
                let idx = (self.bcps & 0x3F) as usize;
                self.bg_cram[idx] = value;
                if self.bcps & 0x80 != 0 {
                    let new_idx = ((self.bcps & 0x3F) + 1) & 0x3F;
                    self.bcps = (self.bcps & 0x80) | new_idx;
                }
            }
            0xFF6A => self.ocps = value,
            0xFF6B => {
                let idx = (self.ocps & 0x3F) as usize;
                self.obj_cram[idx] = value;
                if self.ocps & 0x80 != 0 {
                    let new_idx = ((self.ocps & 0x3F) + 1) & 0x3F;
                    self.ocps = (self.ocps & 0x80) | new_idx;
                }
            }
            _ => {}
        }
    }

    /// Advance PPU by the given T-cycles. Returns (vblank_irq, stat_irq, hblank_entry).
    pub fn step(&mut self, cycles: u32) -> (bool, bool, bool) {
        if self.lcdc & 0x80 == 0 {
            return (false, false, false);
        }

        let mut vblank_irq = false;
        let mut hblank_entry = false;
        let prev_stat_line = self.stat_irq_line;

        self.mode_clock += cycles;

        match self.mode {
            PpuMode::OamScan => {
                if self.mode_clock >= 80 {
                    self.mode_clock -= 80;
                    self.mode = PpuMode::Drawing;
                    self.lcd_on_line0 = false;
                }
            }
            PpuMode::Drawing => {
                if self.mode_clock >= 172 {
                    self.mode_clock -= 172;
                    self.mode = PpuMode::HBlank;
                    hblank_entry = true;
                    self.render_scanline();
                }
            }
            PpuMode::HBlank => {
                if self.mode_clock >= 204 {
                    self.mode_clock -= 204;
                    self.ly += 1;

                    if self.ly == 144 {
                        self.mode = PpuMode::VBlank;
                        self.frame_ready = true;
                        if let Some(t) = self.trace.as_deref_mut() {
                            t.finish_frame(&self.framebuffer, &self.oam, &self.bg_cram, &self.obj_cram, &self.vram, self.cgb_mode, self.compat);
                        }
                        self.window_line_counter = 0;
                        self.window_was_active = false;
                        vblank_irq = true;
                    } else {
                        self.mode = PpuMode::OamScan;
                    }
                }
            }
            PpuMode::VBlank => {
                if self.mode_clock >= 456 {
                    self.mode_clock -= 456;
                    self.ly += 1;

                    if self.ly > 153 {
                        self.ly = 0;
                        self.mode = PpuMode::OamScan;
                    }
                }
            }
        }

        // Compute combined STAT interrupt signal and fire only on rising edge.
        // This prevents re-firing when the condition was already active (STAT blocking).
        let new_stat_line = self.compute_stat_line();
        let stat_irq = new_stat_line && !prev_stat_line;
        self.stat_irq_line = new_stat_line;

        (vblank_irq, stat_irq, hblank_entry)
    }

    /// OR of all enabled STAT interrupt sources. Used for rising-edge detection.
    fn compute_stat_line(&self) -> bool {
        let hblank = (self.mode == PpuMode::HBlank || self.lcd_on_line0) && self.stat & 0x08 != 0;
        let vblank = self.mode == PpuMode::VBlank  && self.stat & 0x10 != 0;
        let oam    = self.mode == PpuMode::OamScan && !self.lcd_on_line0 && self.stat & 0x20 != 0;
        let lyc    = self.ly == self.lyc            && self.stat & 0x40 != 0;
        hblank || vblank || oam || lyc
    }

    /// OAM row (1..=19) the DMG PPU is reading during the M-cycle that just
    /// ended, if an access to $FE00-$FEFF would corrupt OAM now. Row 0 and the
    /// last M-cycle of mode 2 (row 20) never corrupt. CGB is unaffected.
    fn oam_bug_row(&self) -> Option<usize> {
        if self.cgb_mode || self.compat || self.lcdc & 0x80 == 0 || self.mode != PpuMode::OamScan || self.lcd_on_line0 {
            return None;
        }
        let row = (self.mode_clock / 4) as usize;
        (1..20).contains(&row).then_some(row * 8)
    }

    /// OAM bug: write (or 16-bit INC/DEC) during mode 2.
    /// Bitwise glitches are per-bit, so they are applied byte-wise.
    pub fn oam_bug_write(&mut self) {
        let Some(r) = self.oam_bug_row() else { return };
        for i in 0..2 {
            let (a, b, c) = (self.oam[r + i], self.oam[r - 8 + i], self.oam[r - 4 + i]);
            self.oam[r + i] = ((a ^ c) & (b ^ c)) ^ c;
        }
        self.oam.copy_within(r - 6..r, r + 2);
    }

    /// OAM bug: read during mode 2.
    pub fn oam_bug_read(&mut self) {
        let Some(r) = self.oam_bug_row() else { return };
        for i in 0..2 {
            let (a, b, c) = (self.oam[r + i], self.oam[r - 8 + i], self.oam[r - 4 + i]);
            self.oam[r + i] = b | (a & c);
        }
        self.oam.copy_within(r - 6..r, r + 2);
    }

    /// OAM bug: read with a simultaneous 16-bit increment/decrement
    /// (LD A,(HL+/-), POP), then the regular read corruption.
    pub fn oam_bug_read_inc(&mut self) {
        if let Some(r) = self.oam_bug_row().filter(|&r| (32..152).contains(&r)) {
            for i in 0..2 {
                let (a, b, c, d) = (self.oam[r - 16 + i], self.oam[r - 8 + i], self.oam[r + i], self.oam[r - 4 + i]);
                self.oam[r - 8 + i] = (b & (a | c | d)) | (a & c & d);
            }
            self.oam.copy_within(r - 8..r, r);
            self.oam.copy_within(r - 8..r, r - 16);
        }
        self.oam_bug_read();
    }

    fn render_scanline(&mut self) {
        let line = self.ly as usize;
        if line >= SCREEN_HEIGHT { return; }
        let traced = self.trace.is_some();
        if traced {
            self.line_obj = [[NO_OBJ, 0, 0, 0]; SCREEN_WIDTH];
        }
        let window_line = self.window_line_counter;
        if self.cgb_mode {
            self.render_scanline_cgb(line);
        } else {
            self.render_scanline_dmg(line);
        }
        if traced {
            self.trace_line(line, window_line);
        }
    }

    /// Traced lines: copies the line as it stands after the BG (`window == false`) or the
    /// window pass into the BG plane / the window plane of the frame being built.
    fn trace_plane(&mut self, line: usize, window: bool) {
        if let Some(t) = self.trace.as_deref_mut() {
            let r = line * SCREEN_WIDTH * 4..(line + 1) * SCREEN_WIDTH * 4;
            let plane = if window { &mut t.building.win } else { &mut t.building.bg };
            plane[r.clone()].copy_from_slice(&self.framebuffer[r]);
        }
    }

    /// Traced lines: records the line's registers, OBJ selection and per-pixel layer info.
    fn trace_line(&mut self, line: usize, window_line: u8) {
        let Some(mut t) = self.trace.take() else { return };
        let window_drawn = self.window_line_counter != window_line;
        let win_x = self.wx.saturating_sub(7) as usize;
        let (sprites, n) = if self.lcdc & 0x02 != 0 { self.select_sprites(line) } else { ([(0, 0, 0, 0, 0); 10], 0) };
        let b = &mut t.building;
        for x in 0..SCREEN_WIDTH {
            let i = line * SCREEN_WIDTH + x;
            let p = i * 4;
            let covered = window_drawn && x >= win_x;
            if !covered {
                b.win[p..p + 4].fill(0);
            }
            let [slot, cid, attr, drawn] = self.line_obj[x];
            let obj = if slot == NO_OBJ {
                [0; 4]
            } else if self.cgb_mode {
                self.get_obj_cram_color(attr & 0x07, cid)
            } else {
                self.apply_palette(if attr & 0x10 != 0 { self.obp1 } else { self.obp0 }, cid, 1 + (attr >> 4 & 1))
            };
            b.obj[p..p + 4].copy_from_slice(&obj);
            let layer = if drawn != 0 { LAYER_OBJ } else if covered { LAYER_WIN } else { LAYER_BG };
            let ids = self.bg_color_ids[x] | (self.bg_cgb_priority[x] as u8) << 2 | cid << 4;
            b.info[p..p + 4].copy_from_slice(&[layer, slot, ids, attr]);
        }
        let l = b.line_mut(line);
        l[..12].copy_from_slice(&[
            self.lcdc,
            self.scx,
            self.scy,
            self.wx,
            self.wy,
            if window_drawn { window_line } else { 0xFF },
            win_x as u8,
            self.bgp,
            self.obp0,
            self.obp1,
            LINE_RENDERED | if self.cgb_mode { LINE_CGB } else { 0 } | self.vram_bank << 2,
            n as u8,
        ]);
        for (k, &(x, slot, y, tile, attr)) in sprites[..n].iter().enumerate() {
            l[12 + k * 5..17 + k * 5].copy_from_slice(&[slot as u8, y, x, tile, attr]);
        }
        self.trace = Some(t);
    }

    /// The first 10 OBJs (OAM order) that overlap `line`.
    fn select_sprites(&self, line: usize) -> ([Sprite; 10], usize) {
        let height: i16 = if self.lcdc & 0x04 != 0 { 16 } else { 8 };
        let mut out = [(0, 0, 0, 0, 0); 10];
        let mut n = 0;
        for i in 0..40 {
            let b = i * 4;
            let top = self.oam[b] as i16 - 16;
            if (top..top + height).contains(&(line as i16)) {
                out[n] = (self.oam[b + 1], i, self.oam[b], self.oam[b + 2], self.oam[b + 3]);
                n += 1;
                if n == 10 { break; }
            }
        }
        (out, n)
    }

    fn render_scanline_dmg(&mut self, line: usize) {
        let line_start = line * SCREEN_WIDTH * 4;
        let blank = if self.compat { self.get_bg_cram_color(0, 0) } else { PALETTE_COLORS[0] };
        for x in 0..SCREEN_WIDTH {
            let offset = line_start + x * 4;
            self.framebuffer[offset..offset + 4].copy_from_slice(&blank);
            self.bg_color_ids[x] = 0;
        }

        if self.lcdc & 0x01 != 0 {
            self.render_bg_line(line);
        }
        self.trace_plane(line, false);

        if self.lcdc & 0x20 != 0 && self.lcdc & 0x01 != 0 && self.ly >= self.wy {
            self.render_window_line(line);
        }
        self.trace_plane(line, true);

        if self.lcdc & 0x02 != 0 {
            self.render_sprites_line(line);
        }
    }

    fn render_bg_line(&mut self, line: usize) {
        let tile_data_base: u16 = if self.lcdc & 0x10 != 0 { 0x0000 } else { 0x0800 };
        let tile_map_base: u16 = if self.lcdc & 0x08 != 0 { 0x1C00 } else { 0x1800 };
        let signed_addressing = self.lcdc & 0x10 == 0;

        let y = self.scy.wrapping_add(line as u8);
        let tile_row = (y / 8) as u16;
        let pixel_row = y % 8;

        for screen_x in 0..SCREEN_WIDTH {
            let x = self.scx.wrapping_add(screen_x as u8);
            let tile_col = (x / 8) as u16;
            let pixel_col = x % 8;

            let map_offset = tile_map_base + tile_row * 32 + tile_col;
            let tile_index = self.vram[map_offset as usize];

            let tile_addr = if signed_addressing {
                let signed_index = tile_index as i8 as i16;
                (tile_data_base as i16 + (signed_index + 128) * 16) as u16
            } else {
                tile_data_base + tile_index as u16 * 16
            };

            let color_id = self.get_tile_pixel(tile_addr as usize, pixel_row, pixel_col);
            self.bg_color_ids[screen_x] = color_id;
            let color = self.apply_palette(self.bgp, color_id, 0);
            self.set_pixel(screen_x, line, color);
        }
    }

    fn render_window_line(&mut self, line: usize) {
        if self.wx > 166 || self.wy > 143 {
            return;
        }

        let window_x_start = if self.wx < 7 { 0 } else { (self.wx - 7) as usize };
        if line < self.wy as usize {
            return;
        }

        let tile_data_base: u16 = if self.lcdc & 0x10 != 0 { 0x0000 } else { 0x0800 };
        let tile_map_base: u16 = if self.lcdc & 0x40 != 0 { 0x1C00 } else { 0x1800 };
        let signed_addressing = self.lcdc & 0x10 == 0;

        let window_y = self.window_line_counter;
        let tile_row = (window_y / 8) as u16;
        let pixel_row = window_y % 8;

        let mut rendered = false;

        for screen_x in window_x_start..SCREEN_WIDTH {
            rendered = true;
            let window_col = (screen_x - window_x_start) as u8;
            let tile_col = (window_col / 8) as u16;
            let pixel_col = window_col % 8;

            let map_offset = tile_map_base + tile_row * 32 + tile_col;
            let tile_index = self.vram[map_offset as usize];

            let tile_addr = if signed_addressing {
                let signed_index = tile_index as i8 as i16;
                (tile_data_base as i16 + (signed_index + 128) * 16) as u16
            } else {
                tile_data_base + tile_index as u16 * 16
            };

            let color_id = self.get_tile_pixel(tile_addr as usize, pixel_row, pixel_col);
            self.bg_color_ids[screen_x] = color_id;
            let color = self.apply_palette(self.bgp, color_id, 0);
            self.set_pixel(screen_x, line, color);
        }

        if rendered {
            self.window_line_counter += 1;
        }
    }

    fn render_sprites_line(&mut self, line: usize) {
        let sprite_height: i16 = if self.lcdc & 0x04 != 0 { 16 } else { 8 };
        let (mut selected, n) = self.select_sprites(line);
        let sprites_on_line = &mut selected[..n];

        // Highest priority first (DMG: lowest X, then lowest OAM index). The first opaque OBJ
        // pixel claims the dot even when it then loses to the BG, masking the OBJs behind it.
        sprites_on_line.sort_by(|a, b| a.0.cmp(&b.0).then(a.1.cmp(&b.1)));
        let mut claimed = [false; SCREEN_WIDTH];

        for &mut (sx, oam_idx, sy, tile, flags) in sprites_on_line {
            let screen_x_start = sx as i16 - 8;
            let flip_x = flags & 0x20 != 0;
            let flip_y = flags & 0x40 != 0;
            let bg_priority = flags & 0x80 != 0;
            let palette = if flags & 0x10 != 0 { self.obp1 } else { self.obp0 };

            let mut row = (line as i16 - (sy as i16 - 16)) as u8;
            if flip_y {
                row = (sprite_height as u8) - 1 - row;
            }

            let tile_index = if sprite_height == 16 {
                if row < 8 { tile & 0xFE } else { tile | 0x01 }
            } else {
                tile
            };
            let tile_row = row % 8;
            let tile_addr = tile_index as usize * 16;

            for col in 0..8u8 {
                let px = screen_x_start + col as i16;
                if px < 0 || px >= SCREEN_WIDTH as i16 {
                    continue;
                }

                let actual_col = if flip_x { 7 - col } else { col };
                let color_id = self.get_tile_pixel(tile_addr, tile_row, actual_col);

                if color_id == 0 || claimed[px as usize] {
                    continue;
                }
                claimed[px as usize] = true;
                let traced = self.trace.is_some();
                if traced {
                    self.line_obj[px as usize] = [oam_idx as u8, color_id, flags, 0];
                }

                if bg_priority && self.bg_color_ids[px as usize] != 0 {
                    continue;
                }

                let color = self.apply_palette(palette, color_id, 1 + (flags >> 4 & 1));
                self.set_pixel(px as usize, line, color);
                if traced {
                    self.line_obj[px as usize][3] = 1;
                }
            }
        }
    }

    // CGB rendering

    fn render_scanline_cgb(&mut self, line: usize) {
        let c0 = self.get_bg_cram_color(0, 0);
        let ls = line * SCREEN_WIDTH * 4;
        for x in 0..SCREEN_WIDTH {
            let o = ls + x * 4;
            self.framebuffer[o..o + 4].copy_from_slice(&c0);
            self.bg_color_ids[x] = 0;
            self.bg_cgb_priority[x] = false;
        }
        let bgmp = self.lcdc & 0x01 != 0;
        self.render_bg_line_cgb(line);
        self.trace_plane(line, false);
        if self.lcdc & 0x20 != 0 && self.ly >= self.wy { self.render_window_line_cgb(line); }
        self.trace_plane(line, true);
        if self.lcdc & 0x02 != 0 { self.render_sprites_line_cgb(line, bgmp); }
    }

    fn render_bg_line_cgb(&mut self, line: usize) {
        let tdb: u16 = if self.lcdc & 0x10 != 0 { 0x0000 } else { 0x0800 };
        let tmb: u16 = if self.lcdc & 0x08 != 0 { 0x1C00 } else { 0x1800 };
        let signed = self.lcdc & 0x10 == 0;
        let y = self.scy.wrapping_add(line as u8);
        let tr = (y / 8) as u16;
        let pr = y % 8;
        for sx in 0..SCREEN_WIDTH {
            let x = self.scx.wrapping_add(sx as u8);
            let tc = (x / 8) as u16;
            let pc = x % 8;
            let mo = tmb + tr * 32 + tc;
            let ti = self.vram[mo as usize];
            let attr = self.vram[0x2000 + mo as usize];
            let pal = attr & 0x07;
            let bank = (attr >> 3) & 0x01;
            let fx = attr & 0x20 != 0;
            let fy = attr & 0x40 != 0;
            let prio = attr & 0x80 != 0;
            let ta = if signed {
                let si = ti as i8 as i16;
                (tdb as i16 + (si + 128) * 16) as u16
            } else { tdb + ti as u16 * 16 };
            let ar = if fy { 7 - pr } else { pr };
            let ac = if fx { 7 - pc } else { pc };
            let cid = self.get_tile_pixel_banked(ta as usize, ar, ac, bank);
            self.bg_color_ids[sx] = cid;
            self.bg_cgb_priority[sx] = prio;
            let col = self.get_bg_cram_color(pal, cid);
            self.set_pixel(sx, line, col);
        }
    }

    fn render_window_line_cgb(&mut self, line: usize) {
        if self.wx > 166 || self.wy > 143 { return; }
        let wxs = if self.wx < 7 { 0 } else { (self.wx - 7) as usize };
        if line < self.wy as usize { return; }
        let tdb: u16 = if self.lcdc & 0x10 != 0 { 0x0000 } else { 0x0800 };
        let tmb: u16 = if self.lcdc & 0x40 != 0 { 0x1C00 } else { 0x1800 };
        let signed = self.lcdc & 0x10 == 0;
        let wy = self.window_line_counter;
        let tr = (wy / 8) as u16;
        let pr = wy % 8;
        let mut rendered = false;
        for sx in wxs..SCREEN_WIDTH {
            rendered = true;
            let wc = (sx - wxs) as u8;
            let tc = (wc / 8) as u16;
            let pc = wc % 8;
            let mo = tmb + tr * 32 + tc;
            let ti = self.vram[mo as usize];
            let attr = self.vram[0x2000 + mo as usize];
            let pal = attr & 0x07;
            let bank = (attr >> 3) & 0x01;
            let fx = attr & 0x20 != 0;
            let fy = attr & 0x40 != 0;
            let prio = attr & 0x80 != 0;
            let ta = if signed {
                let si = ti as i8 as i16;
                (tdb as i16 + (si + 128) * 16) as u16
            } else { tdb + ti as u16 * 16 };
            let ar = if fy { 7 - pr } else { pr };
            let ac = if fx { 7 - pc } else { pc };
            let cid = self.get_tile_pixel_banked(ta as usize, ar, ac, bank);
            self.bg_color_ids[sx] = cid;
            self.bg_cgb_priority[sx] = prio;
            let col = self.get_bg_cram_color(pal, cid);
            self.set_pixel(sx, line, col);
        }
        if rendered { self.window_line_counter += 1; }
    }

    fn render_sprites_line_cgb(&mut self, line: usize, bgmp: bool) {
        let sh: i16 = if self.lcdc & 0x04 != 0 { 16 } else { 8 };
        let (spr, n) = self.select_sprites(line);
        // Highest priority (lowest OAM index) first; see render_sprites_line.
        let mut claimed = [false; SCREEN_WIDTH];
        for &(sx, slot, sy, ti, fl) in &spr[..n] {
            let x0 = sx as i16 - 8;
            let fx = fl & 0x20 != 0;
            let fy = fl & 0x40 != 0;
            let obp = fl & 0x80 != 0;
            let cpal = fl & 0x07;
            let cbnk = (fl >> 3) & 0x01;
            let mut row = (line as i16 - (sy as i16 - 16)) as u8;
            if fy { row = sh as u8 - 1 - row; }
            let ti2 = if sh == 16 { if row < 8 { ti & 0xFE } else { ti | 0x01 } } else { ti };
            let ta = ti2 as usize * 16;
            let tr = row % 8;
            for col in 0..8u8 {
                let px = x0 + col as i16;
                if px < 0 || px >= SCREEN_WIDTH as i16 { continue; }
                let px = px as usize;
                let ac = if fx { 7 - col } else { col };
                let cid = self.get_tile_pixel_banked(ta, tr, ac, cbnk);
                if cid == 0 || claimed[px] { continue; }
                claimed[px] = true;
                let traced = self.trace.is_some();
                if traced { self.line_obj[px] = [slot as u8, cid, fl, 0]; }
                if bgmp {
                    if self.bg_cgb_priority[px] && self.bg_color_ids[px] != 0 { continue; }
                    if obp && self.bg_color_ids[px] != 0 { continue; }
                }
                let color = self.get_obj_cram_color(cpal, cid);
                self.set_pixel(px, line, color);
                if traced { self.line_obj[px][3] = 1; }
            }
        }
    }

    // Helpers

    fn get_tile_pixel(&self, tile_addr: usize, row: u8, col: u8) -> u8 {
        let byte_offset = tile_addr + (row as usize * 2);
        if byte_offset + 1 >= 0x2000 {
            return 0;
        }
        let lo = self.vram[byte_offset];
        let hi = self.vram[byte_offset + 1];
        let bit = 7 - col;
        ((hi >> bit) & 1) << 1 | ((lo >> bit) & 1)
    }

    fn get_tile_pixel_banked(&self, addr: usize, row: u8, col: u8, bank: u8) -> u8 {
        let base = bank as usize * 0x2000;
        let o = base + addr + row as usize * 2;
        if o + 1 >= self.vram.len() { return 0; }
        let lo = self.vram[o];
        let hi = self.vram[o + 1];
        let bit = 7 - col;
        ((hi >> bit) & 1) << 1 | ((lo >> bit) & 1)
    }

    /// `which`: 0 BG/window, 1 OBP0, 2 OBP1 (the CRAM palette used in compatibility mode).
    fn apply_palette(&self, palette: u8, color_id: u8, which: u8) -> [u8; 4] {
        let shade = (palette >> (color_id * 2)) & 0x03;
        match (self.compat, which) {
            (false, _) => PALETTE_COLORS[shade as usize],
            (true, 0) => self.get_bg_cram_color(0, shade),
            (true, _) => self.get_obj_cram_color(which - 1, shade),
        }
    }

    pub(crate) fn rgb555_to_rgba8888(lo: u8, hi: u8) -> [u8; 4] {
        let v = (hi as u16) << 8 | lo as u16;
        let r = ((v & 0x1F) as u16 * 255 / 31) as u8;
        let g = (((v >> 5) & 0x1F) as u16 * 255 / 31) as u8;
        let b = (((v >> 10) & 0x1F) as u16 * 255 / 31) as u8;
        [r, g, b, 0xFF]
    }

    fn get_bg_cram_color(&self, pal: u8, cid: u8) -> [u8; 4] {
        let i = pal as usize * 8 + cid as usize * 2;
        if i + 1 >= self.bg_cram.len() { return [0xFF, 0xFF, 0xFF, 0xFF]; }
        Self::rgb555_to_rgba8888(self.bg_cram[i], self.bg_cram[i + 1])
    }

    fn get_obj_cram_color(&self, pal: u8, cid: u8) -> [u8; 4] {
        let i = pal as usize * 8 + cid as usize * 2;
        if i + 1 >= self.obj_cram.len() { return [0xFF, 0xFF, 0xFF, 0xFF]; }
        Self::rgb555_to_rgba8888(self.obj_cram[i], self.obj_cram[i + 1])
    }

    fn set_pixel(&mut self, x: usize, y: usize, rgba: [u8; 4]) {
        let offset = (y * SCREEN_WIDTH + x) * 4;
        if offset + 4 <= self.framebuffer.len() {
            self.framebuffer[offset..offset + 4].copy_from_slice(&rgba);
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn ppu_rgb555_white() {
        assert_eq!(Ppu::rgb555_to_rgba8888(0xFF, 0x7F), [255, 255, 255, 255]);
    }

    #[test]
    fn ppu_rgb555_black() {
        assert_eq!(Ppu::rgb555_to_rgba8888(0x00, 0x00), [0, 0, 0, 255]);
    }

    #[test]
    fn ppu_rgb555_red() {
        let [r, g, b, _] = Ppu::rgb555_to_rgba8888(0x1F, 0x00);
        assert_eq!((r, g, b), (255, 0, 0));
    }

    #[test]
    fn ppu_bcps_auto_increment() {
        let mut p = Ppu::new();
        p.write_register(0xFF68, 0x80);
        p.write_register(0xFF69, 0xAB);
        assert_eq!(p.bg_cram[0], 0xAB);
        assert_eq!(p.bcps & 0x3F, 1);
    }

    #[test]
    fn ppu_bcps_wrap() {
        let mut p = Ppu::new();
        p.write_register(0xFF68, 0x80 | 63);
        p.write_register(0xFF69, 0xFF);
        assert_eq!(p.bcps & 0x3F, 0);
    }

    #[test]
    fn ppu_ocps_auto_increment() {
        let mut p = Ppu::new();
        p.write_register(0xFF6A, 0x80);
        p.write_register(0xFF6B, 0x12);
        assert_eq!(p.obj_cram[0], 0x12);
        assert_eq!(p.ocps & 0x3F, 1);
    }

    #[test]
    fn ppu_vram_bank_select() {
        let mut p = Ppu::new();
        p.write_vram(0, 0xAA);
        p.write_register(0xFF4F, 1);
        p.write_vram(0, 0xBB);
        assert_eq!(p.vram[0], 0xAA);
        assert_eq!(p.vram[0x2000], 0xBB);
    }

    #[test]
    fn ppu_bcpd_read() {
        let mut p = Ppu::new();
        p.bg_cram[5] = 0x42;
        p.write_register(0xFF68, 5);
        assert_eq!(p.read_register(0xFF69), 0x42);
    }

    #[test]
    fn ppu_ocpd_read() {
        let mut p = Ppu::new();
        p.obj_cram[10] = 0x77;
        p.write_register(0xFF6A, 10);
        assert_eq!(p.read_register(0xFF6B), 0x77);
    }

    /// Two OBJs at the same spot over BG colour 1: OAM 0 (higher priority) has the
    /// BG-over-OBJ attribute, so the BG shows and OAM 1 stays hidden behind OAM 0.
    fn masked_sprite_ppu(cgb: bool) -> Ppu {
        let mut p = Ppu::new();
        p.cgb_mode = cgb;
        p.lcdc = 0x93; // LCD, BG, OBJ on; tile data at $8000
        p.vram[0..16].copy_from_slice(&[0xFF, 0x00].repeat(8)); // tile 0: colour 1
        p.vram[16..32].copy_from_slice(&[0x00, 0xFF].repeat(8)); // tile 1: colour 2
        p.oam[0..8].copy_from_slice(&[16, 8, 1, 0x80, 16, 8, 1, 0x00]);
        p.bgp = 0xE4;
        p.obp0 = 0xE4;
        p.bg_cram[2..4].copy_from_slice(&[0x00, 0x7C]); // BG pal 0, colour 1: blue
        p.obj_cram[4..6].copy_from_slice(&[0x1F, 0x00]); // OBJ pal 0, colour 2: red
        p.render_scanline();
        p
    }

    #[test]
    fn obj_behind_bg_masks_lower_priority_obj_dmg() {
        assert_eq!(masked_sprite_ppu(false).framebuffer[0..4], PALETTE_COLORS[1]);
    }

    #[test]
    fn obj_behind_bg_masks_lower_priority_obj_cgb() {
        assert_eq!(masked_sprite_ppu(true).framebuffer[0..4], [0, 0, 255, 255]);
    }

    #[test]
    fn ppu_cram_color_red() {
        let mut p = Ppu::new();
        p.bg_cram[0] = 0x1F;
        p.bg_cram[1] = 0x00;
        assert_eq!(p.get_bg_cram_color(0, 0), [255, 0, 0, 255]);
    }

    #[test]
    fn stat_bit7_reads_1_and_lyc_flag_freezes_while_lcd_off() {
        let mut p = Ppu::new();
        p.write_register(0xFF41, 0xFF);
        assert_eq!(p.read_register(0xFF41) & 0x80, 0x80);
        p.lcdc = 0x80;
        p.ly = 145;
        p.lyc = 145;
        p.write_register(0xFF40, 0x00); // LCD off at LY == LYC: flag latched set
        assert_eq!(p.ly, 0);
        assert_eq!(p.read_register(0xFF41) & 0x04, 0x04);
        p.write_register(0xFF45, 0x91); // LYC writes don't update it while off
        assert_eq!(p.read_register(0xFF41) & 0x04, 0x04);
        p.write_register(0xFF40, 0x80); // LCD on: live again (LY 0 != LYC)
        assert_eq!(p.read_register(0xFF41) & 0x04, 0);
    }
}
