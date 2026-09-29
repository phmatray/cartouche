pub const SCREEN_WIDTH: usize = 160;
pub const SCREEN_HEIGHT: usize = 144;
pub const FRAMEBUFFER_SIZE: usize = SCREEN_WIDTH * SCREEN_HEIGHT * 4;

use crate::fifo::LineState;
use crate::gameboy::Revision;
use crate::trace::Tracer;

/// An OBJ selected for a scanline: (x, OAM slot, y, tile, attributes), raw OAM values.
pub(crate) type Sprite = (u8, usize, u8, u8, u8);

/// HBlank (its interrupt, HBlank DMA) starts this many dots before mode 3's length
/// (`Ppu::mode3_len`) runs out, and STAT reads mode 0 from 3 dots later (`read_register`): so a
/// CPU takes the interrupt, and reads mode 0, at the M-cycle hardware does for every SCX, window
/// and OBJ (gbmicrotest `hblank_int_scx*`, `ppu_sprite0_scx*`, `sprite_*`, `win*`).
const MODE0_EARLY: u32 = 2;
/// The longest mode 3 a line can have (172 + 7 fine scroll + 6 window + 10 OBJs of 11 dots): what
/// `mode3_len` holds until the FIFO measures the line (`measure_len`).
const MODE3_MAX: u32 = 295;

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
    /// First line after the LCD is switched on, until its HBlank: no OAM scan (STAT reads mode 0),
    /// the line is 4 dots short, and its mode 3 shows late and ends late.
    pub(crate) lcd_on_line0: bool,
    /// Dots mode 3 lasts on the current line, as the pixel FIFO measures it (`measure_len`; until
    /// then `MODE3_MAX`); HBlank gets the rest.
    pub mode3_len: u32,
    /// Dots per CPU M-cycle: 4, or 2 in CGB double speed (set by the bus when the speed changes).
    pub m_cycle_dots: u32,
    /// The hardware revision (a copy of `MemoryBus::rev`, set with it): CGB E reads line 0's first
    /// STAT M-cycle and OAM around mode 0 differently.
    pub rev: Revision,

    /// The line-by-line picture being drawn.
    pub framebuffer: [u8; FRAMEBUFFER_SIZE],
    /// The last complete picture, copied from `framebuffer` at VBlank entry: what is shown, so a
    /// frame the emulator stops in the middle of never mixes two emulated frames.
    pub front: Vec<u8>,
    pub frame_ready: bool,

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
    /// OPRI ($FF6C): bit 0 set, CGB OBJs overlap by X (as on a DMG) instead of by OAM index.
    pub opri: u8,

    /// Per-frame layer trace; `None` (the default) in normal play. See `trace.rs`.
    pub trace: Option<Box<Tracer>>,
    /// The pixel FIFO of the line in mode 3 (`fifo.rs`); not saved, a loaded state redraws the line.
    pub(crate) line: LineState,
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
            mode3_len: MODE3_MAX,
            m_cycle_dots: 4,
            rev: Revision::Default,
            framebuffer: [0; FRAMEBUFFER_SIZE],
            front: vec![0; FRAMEBUFFER_SIZE],
            frame_ready: false,
            stat_irq_line: false,
            cgb_mode: false,
            compat: false,
            bg_cram: [0; 64],
            obj_cram: [0; 64],
            bcps: 0,
            ocps: 0,
            opri: 0,
            trace: None,
            line: LineState::default(),
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

    /// The CPU cannot reach OAM in modes 2 and 3 nor VRAM and CGB palette RAM (BCPD/OCPD) in
    /// mode 3 (reads $FF, writes are dropped; Pan Docs "LCD Color Palettes"). A read is blocked from the M-cycle before STAT shows the mode (the internal mode)
    /// until STAT shows mode 0; a write only while STAT shows it, except in the M-cycle mode 3
    /// has begun but STAT still shows mode 2, which lets a write through. The line after the LCD
    /// turns on has no OAM scan and no lead.
    /// (gbmicrotest `poweron_oam_*`, `poweron_vram_*`, `oam_*_l0/l1_*`, `vram_*_l0/l1_*`.)
    pub fn cpu_locked(&self, addr: u16, write: bool) -> bool {
        if self.lcdc & 0x80 == 0 || !matches!(addr, 0x8000..=0x9FFF | 0xFE00..=0xFE9F | 0xFF69 | 0xFF6B) {
            return false;
        }
        let shown = match self.read_register(0xFF41) & 3 {
            2 if self.lcd_on_line0 && self.mode == PpuMode::Drawing => 0,
            m => m,
        };
        let internal = match self.mode {
            PpuMode::OamScan if !self.lcd_on_line0 => 2,
            PpuMode::Drawing if !self.lcd_on_line0 => 3,
            _ => 0,
        };
        let from = if (0xFE00..=0xFE9F).contains(&addr) { 2 } else { 3 };
        if write {
            shown >= from && !(shown == 2 && self.mode == PpuMode::Drawing)
        } else {
            // A CGB E unlocks OAM one dot after STAT shows mode 0 in single speed (Age oam-read's `EFF`).
            let e_lag = from == 2 && self.rev == Revision::CgbE && self.m_cycle_dots == 4
                && self.mode == PpuMode::HBlank && self.mode_clock == 3;
            shown >= from || internal >= from || e_lag
        }
    }

    pub fn read_register(&self, addr: u16) -> u8 {
        match addr {
            0xFF40 => self.lcdc,
            0xFF41 => {
                // A new mode reads one M-cycle late: its STAT interrupt is requested one M-cycle
                // ahead of the hardware line, since the CPU samples IF before its opcode fetch.
                // An M-cycle is 4 dots, 2 in double speed.
                let m = self.m_cycle_dots;
                let mode_bits = match self.mode {
                    _ if self.lcdc & 0x80 == 0 => 0,
                    PpuMode::HBlank if self.mode_clock < 5 - m / 2 => 3, // see MODE0_EARLY
                    // The first line after LCD on has no mode 2, and its mode 3 shows 4 dots late.
                    PpuMode::OamScan if self.lcd_on_line0 => 0,
                    PpuMode::Drawing if self.lcd_on_line0 && self.mode_clock < 4 => 0,
                    PpuMode::Drawing if self.mode_clock < m => 2,
                    // Line 0 after VBlank: 0 like the other lines in single speed on a CGB B/C, still
                    // 1 in double speed and on a CGB E, which has no mode-0 M-cycle there (Age stat-mode).
                    PpuMode::OamScan if self.mode_clock < m => if self.ly == 0 && (m == 2 || self.rev == Revision::CgbE) { 1 } else { 0 },
                    PpuMode::VBlank if self.mode_clock < m && self.ly == 144 => 0,
                    mode => mode as u8,
                };
                // With the LCD off the coincidence bit is frozen at its LCD-off value
                // (kept in stored bit 2). Bit 7 is unused and always reads 1.
                let lyc_flag = if self.lcdc & 0x80 == 0 { self.stat & 0x04 }
                    else if self.ly_compare(false) == Some(self.lyc) { 0x04 } else { 0 };
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
            0xFF6C => 0xFE | self.opri,
            _ => 0xFF,
        }
    }

    pub fn write_register(&mut self, addr: u16, value: u8) {
        if self.line.active && self.mode == PpuMode::Drawing && matches!(addr, 0xFF40 | 0xFF43 | 0xFF4A | 0xFF4B)
            && self.read_register(addr) != value
        {
            self.line.relength = true; // see `measure_len`
        }
        match addr {
            0xFF40 => {
                let was_enabled = self.lcdc & 0x80 != 0;
                let tile_sel = (self.lcdc ^ value) & 0x10 != 0;
                self.lcdc = value;
                if tile_sel { self.tile_sel_switch(); }
                let is_enabled = self.lcdc & 0x80 != 0;
                if was_enabled && !is_enabled {
                    let lyc_flag = if self.ly_compare(false) == Some(self.lyc) { 0x04 } else { 0 };
                    self.stat = (self.stat & !0x04) | lyc_flag;
                    self.ly = 0;
                    self.mode = PpuMode::HBlank;
                    self.mode_clock = 0;
                    self.stat_irq_line = false;
                    self.lcd_on_line0 = false;
                    self.line.active = false;
                    self.window_was_active = false;
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
            0xFF47 => {
                self.line.bgp_old = Some((self.bgp, self.line.dot));
                self.bgp = value;
            }
            0xFF48 => self.obp0 = value,
            0xFF49 => self.obp1 = value,
            0xFF4A => self.wy = value,
            0xFF4B => {
                (self.line.wx_old, self.line.wx_dot) = (self.wx, self.line.dot + 1); // see `wx_seen`
                self.wx = value;
            }
            0xFF4F => self.vram_bank = value & 0x01,
            0xFF68 => self.bcps = value,
            0xFF69 => {
                self.bg_cram[(self.bcps & 0x3F) as usize] = value;
                self.palette_index_step(addr);
            }
            0xFF6A => self.ocps = value,
            0xFF6B => {
                self.obj_cram[(self.ocps & 0x3F) as usize] = value;
                self.palette_index_step(addr);
            }
            0xFF6C => self.opri = value & 1,
            _ => {}
        }
    }

    /// BCPS/OCPS auto-increment after a BCPD/OCPD write. It also runs when a mode-3 lock drops
    /// the write (Pan Docs "LCD Color Palettes": the index still increments; SameBoy agrees).
    pub fn palette_index_step(&mut self, addr: u16) {
        let ps = if addr == 0xFF69 { &mut self.bcps } else { &mut self.ocps };
        if *ps & 0x80 != 0 {
            *ps = 0x80 | (ps.wrapping_add(1) & 0x3F);
        }
    }

    /// Stop mode: the LCD shows blank (white, as SameBoy draws it) until the CPU wakes.
    pub fn blank(&mut self) {
        let white = if self.cgb_mode || self.compat { [0xFF; 4] } else { PALETTE_COLORS[0] };
        for px in self.front.chunks_exact_mut(4) { px.copy_from_slice(&white); }
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
                    self.mode3_len = MODE3_MAX;
                    self.start_line();
                }
            }
            PpuMode::Drawing => {
                if !self.line.active { self.start_line(); } // a state loaded in mode 3: redraw the line
                self.run_line(self.mode_clock + MODE0_EARLY);
                self.measure_len();
                if self.mode_clock >= self.mode3_len - MODE0_EARLY {
                    self.mode_clock -= self.mode3_len - MODE0_EARLY;
                    self.mode = PpuMode::HBlank;
                    self.lcd_on_line0 = false;
                    hblank_entry = true;
                }
            }
            PpuMode::HBlank => {
                // The FIFO lags behind the mode the CPU sees; the line ends in HBlank.
                if self.line.active { self.run_line(self.mode_clock + self.mode3_len); }
                if self.mode_clock >= 376 + MODE0_EARLY - self.mode3_len {
                    self.mode_clock -= 376 + MODE0_EARLY - self.mode3_len;
                    self.ly += 1;

                    if self.ly == 144 {
                        self.mode = PpuMode::VBlank;
                        self.frame_ready = true;
                        self.front.copy_from_slice(&self.framebuffer);
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
                // Line 153 shows LY = 153 for one M-cycle only, then 0 (compared with LYC too).
                if self.ly == 153 && self.mode_clock >= 4 {
                    self.ly = 0;
                }
                if self.mode_clock >= 456 {
                    self.mode_clock -= 456;
                    if self.ly == 0 {
                        self.mode = PpuMode::OamScan;
                    } else {
                        self.ly += 1;
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
        let hblank = (self.mode == PpuMode::HBlank || self.lcd_on_line0 && self.mode == PpuMode::OamScan) && self.stat & 0x08 != 0;
        let vblank = self.mode == PpuMode::VBlank  && self.stat & 0x10 != 0;
        // Line 144 starts with the mode 2 source too, for one M-cycle.
        let oam    = (self.mode == PpuMode::OamScan && !self.lcd_on_line0 || self.mode == PpuMode::VBlank && self.ly == 144 && self.mode_clock < 4) && self.stat & 0x20 != 0;
        // No comparator blank at a line start: the interrupt is requested one M-cycle ahead of the
        // line (the CPU samples IF before its opcode fetch).
        let lyc    = self.ly_compare(true) == Some(self.lyc) && self.stat & 0x40 != 0;
        hblank || vblank || oam || lyc
    }

    /// The line LY=LYC compares against: none for the first M-cycle of a line (the comparator
    /// is updating), and on line 153 (whose LY reads 0 after its first M-cycle) 153 for one
    /// M-cycle, none for one, then 0 through line 0.
    #[inline]
    fn ly_compare(&self, irq: bool) -> Option<u8> {
        let c = self.mode_clock;
        match (self.mode, self.ly) {
            (PpuMode::VBlank, 0 | 153) => match c { 0..=3 => None, 4..=7 => Some(153), 8..=11 => None, _ => Some(0) },
            (PpuMode::OamScan, 0) => Some(0),
            (PpuMode::OamScan | PpuMode::VBlank, _) if c < 4 && !irq => None,
            _ => Some(self.ly),
        }
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

    /// The first 10 OBJs (OAM order) that overlap `line`.
    pub(crate) fn select_sprites(&self, line: usize) -> ([Sprite; 10], usize) {
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

    /// `which`: 0 BG/window, 1 OBP0, 2 OBP1 (the CRAM palette used in compatibility mode).
    #[inline]
    pub(crate) fn apply_palette(&self, palette: u8, color_id: u8, which: u8) -> [u8; 4] {
        let shade = (palette >> (color_id * 2)) & 0x03;
        match (self.compat, which) {
            (false, _) => PALETTE_COLORS[shade as usize],
            (true, 0) => self.get_bg_cram_color(0, shade),
            (true, _) => self.get_obj_cram_color(which - 1, shade),
        }
    }

    #[inline]
    pub(crate) fn rgb555_to_rgba8888(lo: u8, hi: u8) -> [u8; 4] {
        /// 5-bit channel → 8-bit (x * 255 / 31), looked up: the FIFO converts every pixel.
        const C8: [u8; 32] = {
            let mut t = [0; 32];
            let mut i = 0;
            while i < 32 { t[i] = (i * 255 / 31) as u8; i += 1; }
            t
        };
        let v = (hi as usize) << 8 | lo as usize;
        [C8[v & 0x1F], C8[v >> 5 & 0x1F], C8[v >> 10 & 0x1F], 0xFF]
    }

    #[inline]
    pub(crate) fn get_bg_cram_color(&self, pal: u8, cid: u8) -> [u8; 4] {
        let i = pal as usize * 8 + cid as usize * 2;
        if i + 1 >= self.bg_cram.len() { return [0xFF, 0xFF, 0xFF, 0xFF]; }
        Self::rgb555_to_rgba8888(self.bg_cram[i], self.bg_cram[i + 1])
    }

    #[inline]
    pub(crate) fn get_obj_cram_color(&self, pal: u8, cid: u8) -> [u8; 4] {
        let i = pal as usize * 8 + cid as usize * 2;
        if i + 1 >= self.obj_cram.len() { return [0xFF, 0xFF, 0xFF, 0xFF]; }
        Self::rgb555_to_rgba8888(self.obj_cram[i], self.obj_cram[i + 1])
    }

    #[inline]
    pub(crate) fn set_pixel(&mut self, x: usize, y: usize, rgba: [u8; 4]) {
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
        p.draw_line();
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
        (p.mode, p.mode_clock) = (PpuMode::VBlank, 100);
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

    #[test]
    fn line_153_reports_ly_0_early_for_lyc_0() {
        let mut p = Ppu::new();
        p.write_register(0xFF41, 0x40); // LYC interrupt, LYC = 0
        p.write_register(0xFF40, 0x80);
        while !(p.ly == 153 && p.mode == PpuMode::VBlank) { p.step(4); }
        assert_eq!(p.read_register(0xFF44), 153, "the first M-cycle of line 153");
        let mut fired = false;
        for _ in 0..3 { fired |= p.step(4).1; }
        assert_eq!(p.read_register(0xFF44), 0, "LY reads 0 for the rest of line 153");
        assert!(fired, "LY=LYC=0 interrupt on line 153");
        assert_eq!(p.read_register(0xFF41) & 0x07, 0x05, "mode 1, coincidence");
        while p.mode == PpuMode::VBlank { assert!(!p.step(4).1, "no second edge"); }
        assert_eq!(p.read_register(0xFF44), 0);
    }

    #[test]
    fn lcd_on_line_0_has_no_mode2_stat_edge() {
        let mut p = Ppu::new();
        p.write_register(0xFF41, 0x20); // mode 2 interrupt
        p.write_register(0xFF40, 0x80);
        while p.ly == 0 {
            let fired = p.step(4).1;
            assert_eq!(fired, p.ly == 1, "line 0 after LCD on skips the OAM scan; line 1 has one");
        }
    }

    /// Line 0 after LCD on: mode 3 ends 2 dots later than on other lines, SCX extension included,
    /// and shows 4 dots in (2 dots later than other lines in double speed). Age stat-mode.
    #[test]
    fn lcd_on_line_0_mode3_timing() {
        for (m_cycle_dots, shows_late) in [(4, 0), (2, 2)] {
            for scx in [0, 5] {
                let mut p = Ppu::new();
                (p.scx, p.m_cycle_dots) = (scx, m_cycle_dots);
                p.write_register(0xFF40, 0x81);
                // Per line, dots from the line start until STAT reads 3, then until it reads 0.
                let mut edges = [[0u32; 2]; 2];
                let mut t = 4; // line 0 starts 4 dots in
                let mut prev = 0;
                while p.ly < 2 {
                    let line = p.ly as usize;
                    p.step(1);
                    t += 1;
                    let mode = p.read_register(0xFF41) & 3;
                    let dot = t - 456 * line as u32;
                    if mode == 3 && prev != 3 { edges[line][0] = dot; }
                    if mode == 0 && prev == 3 { edges[line][1] = dot; }
                    prev = if p.ly as usize != line { 0 } else { mode };
                }
                let what = format!("{m_cycle_dots} dots per M-cycle, SCX {scx}: {edges:?}");
                assert_eq!(edges[0][0], edges[1][0] + shows_late, "{what}");
                assert_eq!(edges[0][1], edges[1][1] + 2, "{what}");
            }
        }
    }

    /// The first M-cycle of line 0 after VBlank reads mode 0 in single speed, still 1 in double
    /// speed (Age stat-mode, CGB B/C) and on a CGB E (stat-mode-cgbE's `M1E`).
    #[test]
    fn line_0_after_vblank_first_m_cycle() {
        for (m_cycle_dots, rev, mode) in [(4, Revision::Default, 0), (4, Revision::CgbC, 0), (2, Revision::Default, 1), (4, Revision::CgbE, 1)] {
            let mut p = Ppu::new();
            (p.lcdc, p.mode, p.ly, p.mode_clock, p.m_cycle_dots, p.rev) = (0x81, PpuMode::VBlank, 153, 400, m_cycle_dots, rev);
            while p.mode == PpuMode::VBlank { p.step(1); }
            assert_eq!(p.read_register(0xFF41) & 3, mode, "{m_cycle_dots} dots per M-cycle, {rev:?}");
            while p.mode_clock < m_cycle_dots { p.step(1); }
            assert_eq!(p.read_register(0xFF41) & 3, 2);
        }
    }

    /// In single speed a CGB E keeps OAM locked for reads one dot after STAT shows mode 0; a CGB
    /// B/C reads it there (Age oam-read's `EFF`). Writes and VRAM are unchanged.
    #[test]
    fn cgb_e_unlocks_oam_reads_a_dot_after_mode_0() {
        for (rev, locked) in [(Revision::Default, false), (Revision::CgbC, false), (Revision::CgbE, true)] {
            let mut p = Ppu::new();
            (p.lcdc, p.ly, p.rev) = (0x81, 10, rev);
            while !p.step(1).2 {}
            while p.read_register(0xFF41) & 3 == 3 { p.step(1); }
            assert_eq!(p.cpu_locked(0xFE00, false), locked, "{rev:?}");
            assert!(!p.cpu_locked(0xFE00, true) && !p.cpu_locked(0x8000, false), "{rev:?}");
            p.step(1);
            assert!(!p.cpu_locked(0xFE00, false), "{rev:?}: a dot later");
        }
    }

    /// STAT reads mode 3 for a few dots after mode 3 runs out (see MODE0_EARLY): 3 in single
    /// speed, 4 (two M-cycles) in double speed (Age stat-mode-ds, spsw-mode0).
    #[test]
    fn stat_reads_mode_0_later_in_double_speed() {
        for (m_cycle_dots, lag) in [(4, 3), (2, 4)] {
            let mut p = Ppu::new();
            p.lcdc = 0x81;
            p.ly = 10;
            p.m_cycle_dots = m_cycle_dots;
            while !p.step(1).2 {}
            let mut dots = 0;
            while p.read_register(0xFF41) & 3 == 3 {
                p.step(1);
                dots += 1;
            }
            assert_eq!(dots, lag, "{m_cycle_dots} dots per M-cycle");
        }
    }

    /// Steps line 10 dot by dot from its start: (dot where mode 3's length runs out, dots until LY moves on).
    fn line_timing(setup: impl Fn(&mut Ppu)) -> (u32, u32) {
        let mut p = Ppu::new();
        p.lcdc = 0x83; // LCD, BG, OBJ on
        p.ly = 10;
        setup(&mut p);
        let (mut dot, mut hblank_at) = (0, 0);
        while p.read_register(0xFF44) == 10 {
            dot += 1;
            if p.step(1).2 { hblank_at = dot + MODE0_EARLY; }
        }
        (hblank_at, dot)
    }

    fn objs_at(p: &mut Ppu, xs: &[u8]) {
        for (i, &x) in xs.iter().enumerate() {
            p.oam[i * 4..i * 4 + 2].copy_from_slice(&[10 + 16, x]); // top row on line 10
        }
    }

    #[test]
    fn mode3_grows_with_scx_window_and_objs() {
        assert_eq!(line_timing(|_| {}).0, 80 + 172);
        assert_eq!(line_timing(|p| p.scx = 3).0, 80 + 172 + 3);
        assert_eq!(line_timing(|p| p.scx = 8).0, 80 + 172, "only the fine scroll counts");
        assert_eq!(line_timing(|p| { p.lcdc |= 0x20; p.wx = 7; p.wy = 10; }).0, 80 + 172 + 6);
        assert_eq!(line_timing(|p| { p.lcdc |= 0x20; p.wx = 7; p.wy = 11; }).0, 80 + 172, "window below the line");
        // Pan Docs: 6 per OBJ, plus 5 minus its offset in its BG tile for the first OBJ on a tile.
        assert_eq!(line_timing(|p| objs_at(p, &[8])).0, 80 + 172 + 11);
        assert_eq!(line_timing(|p| objs_at(p, &[11])).0, 80 + 172 + 8);
        assert_eq!(line_timing(|p| { objs_at(p, &[8]); p.scx = 2; }).0, 80 + 172 + 2 + 9);
        assert_eq!(line_timing(|p| { objs_at(p, &[0]); p.scx = 3; }).0, 80 + 172 + 3 + 11, "OAM X 0 costs 11 whatever the scroll");
        assert_eq!(line_timing(|p| objs_at(p, &[0, 0])).0, 80 + 172 + 11 + 6, "and X 0 OBJs share it");
        assert_eq!(line_timing(|p| objs_at(p, &[8; 10])).0, 80 + 172 + 11 + 9 * 6, "one tile, one wait");
        assert_eq!(line_timing(|p| objs_at(p, &[8, 16, 24, 32, 40, 48, 56, 64, 72, 80])).0, 80 + 172 + 10 * 11);
        assert_eq!(line_timing(|p| { objs_at(p, &[8]); p.lcdc &= !0x02; }).0, 80 + 172, "OBJs off");
        assert_eq!(line_timing(|p| objs_at(p, &[168])).0, 80 + 172, "past the right edge");
    }

    #[test]
    fn line_is_456_dots() {
        assert_eq!(line_timing(|_| {}).1, 456);
        assert_eq!(line_timing(|p| { objs_at(p, &[8; 10]); p.scx = 7; p.lcdc |= 0x20; p.wy = 10; }).1, 456);
    }

    /// The shown picture is the last whole frame: stopping mid-frame (as a fixed-length
    /// `run_frame` does once the LCD has been toggled) must not mix two frames.
    #[test]
    fn front_buffer_holds_the_last_complete_frame() {
        let mut p = Ppu::new();
        p.lcdc = 0x91;
        p.vram[0..16].copy_from_slice(&[0xFF, 0x00].repeat(8)); // tile 0: colour 1
        p.bgp = 0x00; // colour 1 -> shade 0
        while !p.frame_ready { p.step(4); }
        p.frame_ready = false;
        p.bgp = 0x0C; // colour 1 -> shade 3
        while p.ly != 72 { p.step(4); }
        let last_line = (SCREEN_HEIGHT - 1) * SCREEN_WIDTH * 4;
        assert_eq!(p.framebuffer[0..4], PALETTE_COLORS[3]);
        assert_eq!(p.framebuffer[last_line..last_line + 4], PALETTE_COLORS[0]);
        assert!(p.front.chunks(4).all(|px| px == PALETTE_COLORS[0]));
        while !p.frame_ready { p.step(4); }
        assert!(p.front.chunks(4).all(|px| px == PALETTE_COLORS[3]));
    }

    /// DMG line 10 stepped one dot at a time through `step`; `at(p, dot)` runs before each dot of mode 3.
    fn run_line10(setup: impl Fn(&mut Ppu), at: impl Fn(&mut Ppu, u32)) -> Ppu {
        let mut p = Ppu::new();
        (p.lcdc, p.bgp, p.obp0, p.ly) = (0x91, 0xE4, 0xE4, 10); // LCD, BG on; tiles at $8000
        setup(&mut p);
        while p.ly == 10 {
            if p.mode == PpuMode::Drawing {
                let dot = p.mode_clock;
                at(&mut p, dot);
            }
            p.step(1);
        }
        p
    }

    fn shades(p: &Ppu, line: usize) -> Vec<u8> {
        let row = &p.framebuffer[line * SCREEN_WIDTH * 4..(line + 1) * SCREEN_WIDTH * 4];
        row.chunks(4).map(|c| PALETTE_COLORS.iter().position(|k| k[..] == *c).unwrap() as u8).collect()
    }

    /// A BGP write partway through mode 3 changes the pixels from where the FIFO is, not the whole line.
    #[test]
    fn mid_line_bgp_write() {
        let switch_at = |dot: u32| {
            let p = run_line10(|p| p.vram[0..16].fill(0xFF), |p, d| if d == dot { p.write_register(0xFF47, 0x1B) });
            let s = shades(&p, 10);
            let x = s.iter().position(|&v| v == 0).expect("the new shade shows");
            assert!(s[..x].iter().all(|&v| v == 3) && s[x..].iter().all(|&v| v == 0), "{s:?}");
            x
        };
        let x = switch_at(60);
        assert!((20..60).contains(&x), "switch at {x}");
        assert_eq!(switch_at(64), x + 4, "4 dots later, 4 pixels later");
    }

    #[test]
    fn scx_fine_scroll_discards_pixels() {
        // Tile 0: only its first column is dark.
        let p = run_line10(|p| { p.vram[0..16].fill(0x80); p.scx = 3; }, |_, _| {});
        let dark: Vec<usize> = shades(&p, 10).iter().enumerate().filter(|(_, &v)| v == 3).map(|(x, _)| x).collect();
        assert_eq!(dark, (0..20).map(|k| 8 * k + 5).collect::<Vec<_>>());
    }

    /// BG: tile 0 (light) from the $9800 map. Window: tile 1 (dark) from the $9C00 map.
    fn window_setup(p: &mut Ppu) {
        p.lcdc = 0xF1;
        p.wy = 10;
        p.vram[16..32].fill(0xFF);
        p.vram[0x1C00..0x2000].fill(1);
        p.wx = 50;
    }

    #[test]
    fn window_starts_at_wx_minus_7() {
        let s = shades(&run_line10(window_setup, |_, _| {}), 10);
        assert_eq!(s.iter().position(|&v| v == 3), Some(43));
        assert!(s[43..].iter().all(|&v| v == 3));
    }

    /// The window needs WY to have matched LY on an earlier line of the frame, not just WY <= LY.
    #[test]
    fn window_waits_for_wy_to_match_ly() {
        let s = shades(&run_line10(|p| { window_setup(p); p.wy = 0; }, |_, _| {}), 10);
        assert!(s.iter().all(|&v| v == 0), "WY never matched this frame: {s:?}");
        let s = shades(&run_line10(|p| { window_setup(p); p.wy = 0; p.window_was_active = true; }, |_, _| {}), 10);
        assert_eq!(s.iter().position(|&v| v == 3), Some(43));
    }

    /// Turned off, then on again before WX matches once more, the window restarts there on its next row.
    #[test]
    fn window_retriggers_after_lcdc5_toggle() {
        let setup = |p: &mut Ppu| {
            window_setup(p);
            p.vram[0x1C00..0x2000].fill(2); // tile 2: row 0 dark, row 1 light grey
            p.vram[32..35].fill(0xFF);
        };
        let p = run_line10(setup, |p, d| match d {
            90 => { p.write_register(0xFF40, 0xD1); p.write_register(0xFF4B, 100); }
            110 => p.write_register(0xFF40, 0xF1),
            _ => {}
        });
        let s = shades(&p, 10);
        assert!(s[43..60].iter().all(|&v| v == 3), "the window from x = 43, row 0: {s:?}");
        assert!(s[80..93].iter().all(|&v| v == 0), "BG while it is off: {s:?}");
        assert!(s[93..].iter().all(|&v| v == 1), "restarted at x = 93 on row 1: {s:?}");
        assert_eq!(p.window_line_counter, 2, "two rows used");
    }

    /// The first tile is fetched twice, but its tile number is read by the first fetch only.
    #[test]
    fn first_tile_number_read_once() {
        let p = run_line10(|p| {
            p.vram[16..32].fill(0xFF); // tile 1: dark
            p.vram[0x1820..0x1840].fill(1); // map row 1 (lines 8-15 at SCY 0): dark
        }, |p, d| if d == 10 { p.write_register(0xFF42, 8) }); // map row 2: light
        let s = shades(&p, 10);
        assert!(s[..8].iter().all(|&v| v == 3) && s[8..].iter().all(|&v| v == 0), "{s:?}");
    }

    #[test]
    fn mid_line_wx_write_moves_the_window() {
        let s = shades(&run_line10(window_setup, |p, d| if d == 20 { p.write_register(0xFF4B, 100) }), 10);
        assert_eq!(s.iter().position(|&v| v == 3), Some(93));
    }

    /// The layer trace records each pixel's BG tile as fetched: a mid-line SCX write moves the map
    /// column from the next fetch on, which the line-start SCX cannot place.
    #[test]
    fn trace_records_the_fetched_tile_per_pixel() {
        let p = run_line10(
            |p| {
                p.set_tracing(true);
                (0..32).for_each(|c| p.vram[0x1800 + 32 + c] = c as u8); // map row 1 (line 10): tile = column
            },
            |p, d| if d == 80 { p.write_register(0xFF43, 16) },
        );
        let tiles = &p.trace.as_ref().unwrap().building.tile[10 * SCREEN_WIDTH..11 * SCREEN_WIDTH];
        let switch = (0..SCREEN_WIDTH).find(|&x| tiles[x] as usize != x / 8).expect("the SCX write shows");
        assert!(switch % 8 == 0 && (40..120).contains(&switch), "switch at {switch}: {tiles:?}");
        assert!((switch..SCREEN_WIDTH).all(|x| tiles[x] as usize == (x + 16) / 8), "{tiles:?}");
    }

    /// WX matched again while the window runs: between two window tiles the LCD gets one colour-0
    /// pixel and the window goes on a pixel later; inside a tile nothing shows. The window compares
    /// WX one dot late, so a write lands one dot after the FIFO would first see it.
    #[test]
    fn wx_rematch_while_window_runs() {
        let at = |wx: u8| shades(&run_line10(window_setup, |p, d| if d == 64 { p.write_register(0xFF4B, wx) }), 10);
        let s = at(58); // x = 51: the window's second tile
        assert!(s[43..51].iter().all(|&v| v == 3) && s[51] == 0 && s[52..].iter().all(|&v| v == 3), "{s:?}");
        let s = at(61); // x = 54: inside it
        assert!(s[43..].iter().all(|&v| v == 3), "{s:?}");
    }

    /// Pan Docs' "Mode 3 length" of the current line with the registers as they are: 172, plus the
    /// SCX fine-scroll discard, plus 6 when the window shows on the line, plus each OBJ's fetch: 6
    /// dots, and for the first OBJ (left to right) on a BG/window tile, 5 minus the OBJ's offset in
    /// that tile (≥ 0). OBJs at OAM X 0 share a tile of their own: the first costs 11 whatever SCX.
    /// On a DMG, WX 0 with a fine scroll costs one dot more. The pixel FIFO must add up to it.
    fn pan_docs_len(p: &Ppu) -> u32 {
        let fine = (p.scx % 8) as i32;
        let window = p.lcdc & 0x20 != 0 && (p.cgb_mode || p.lcdc & 0x01 != 0)
            && (p.window_was_active || p.ly == p.wy) && p.wx <= 166;
        let mut len = 172 + fine as u32 + if window { 6 } else { 0 };
        if window && p.wx == 0 && fine > 0 && !p.cgb_mode { len += 1; }
        if p.lcdc & 0x02 == 0 { return len; }
        let (mut objs, n) = p.select_sprites(p.ly as usize);
        objs[..n].sort_by_key(|o| o.0); // fetched left to right
        let mut paid = 0u64; // tiles an OBJ already waited on: BG 0..=21, window 32..=53, X 0 63
        for &(x, ..) in &objs[..n] {
            if x >= 168 { continue; } // never reached
            // Position of the OBJ's leftmost pixel, + 8, in the BG (with the discard) or the window.
            let from_window = x as i32 + 7 - p.wx as i32;
            let (tile, offset) = if x == 0 {
                (63, 0) // off the left edge: a tile of its own, whatever the scroll
            } else if window && from_window >= 8 {
                (32 + from_window / 8, from_window % 8)
            } else {
                ((x as i32 + fine) / 8, (x as i32 + fine) % 8)
            };
            len += 6;
            if paid & 1 << tile == 0 {
                paid |= 1 << tile;
                len += (5 - offset).max(0) as u32;
            }
        }
        len
    }

    /// The FIFO's own mode-3 length agrees with Pan Docs for 0, 1 and 10 OBJs, DMG and CGB.
    #[test]
    fn obj_penalty_matches_formula() {
        let lines: [&[u8]; 5] = [&[], &[8], &[8, 16, 24, 32, 40, 48, 56, 64, 72, 80], &[0, 3, 11, 13, 50, 50, 51, 90, 160, 167], &[1; 10]];
        for cgb in [false, true] {
            for xs in lines {
                for scx in 0..8 {
                    let p = run_line10(|p| { p.cgb_mode = cgb; p.lcdc |= 0x02; objs_at(p, xs); p.scx = scx; }, |_, _| {});
                    assert_eq!(p.line.len, pan_docs_len(&p), "CGB {cgb}, OBJs at {xs:?}, SCX {scx}");
                    assert_eq!(p.mode3_len, p.line.len, "STAT's mode 3 is the FIFO's");
                }
            }
        }
    }

    /// OBJs turned off (or on) partway through mode 3 move HBlank: mode 3 ends where the FIFO does.
    #[test]
    fn mid_line_obj_disable_shortens_mode3() {
        let xs = [8, 24, 40, 56, 72, 88, 104, 120, 136, 152];
        let full = line_timing(|p| objs_at(p, &xs)).0;
        assert_eq!(full, 80 + 172 + 10 * 11);
        // mode 3's dot at which HBlank starts, and the FIFO's own length, with LCDC written at `at`.
        let hblank = |lcdc: u8, at: u32, start_objs: bool| {
            let mut p = Ppu::new();
            (p.lcdc, p.ly) = (if start_objs { 0x83 } else { 0x81 }, 10);
            objs_at(&mut p, &xs);
            let mut dot = 0;
            while p.mode != PpuMode::Drawing { p.step(1); }
            loop {
                if dot == at { p.write_register(0xFF40, lcdc); }
                dot += 1;
                if p.step(1).2 { break; }
            }
            // Mode 3 as the STAT register sees it, from its first dot.
            let stat_len = dot + MODE0_EARLY;
            while p.line.active { p.step(1); }
            (stat_len, p.line.len)
        };
        let (off, len) = hblank(0x81, 40, true);
        assert!(off < 172 + 10 * 11, "OBJs off at dot 40: mode 3 is {off} dots");
        assert_eq!(off, len, "STAT's mode 3 is the FIFO's");
        let (on, len) = hblank(0x83, 40, false);
        assert!(on > 172, "OBJs on at dot 40: mode 3 is {on} dots");
        assert_eq!(on, len);
        let (same, _) = hblank(0x83, 40, true);
        assert_eq!(same, 172 + 10 * 11, "a write that changes nothing");
    }

    #[test]
    fn mid_line_obp0_write() {
        // Ten dark OBJs across the line over a light BG; OBP0 turns colour 3 from shade 3 to shade 1.
        let setup = |p: &mut Ppu| {
            p.lcdc |= 0x02;
            p.vram[0..16].fill(0xFF);
            p.vram[0x1800..0x1C00].fill(1);
            objs_at(p, &[8, 24, 40, 56, 72, 88, 104, 120, 136, 152]);
        };
        let first_new = |dot: u32| {
            let s = shades(&run_line10(setup, |p, d| if d == dot { p.write_register(0xFF48, 0x40) }), 10);
            let x = s.iter().position(|&v| v == 1).expect("the new shade shows");
            assert!(s[..x].iter().all(|&v| v != 1) && s[x..].iter().all(|&v| v != 3), "{s:?}");
            assert!(s[..x].contains(&3), "the old shade shows first");
            x
        };
        assert!(first_new(100) < first_new(140));
    }

    fn probe(p: &Ppu) -> (bool, bool, u32, u32, u32, u8) {
        (p.line.active, p.frame_ready, p.line.len, p.mode3_len, pan_docs_len(p), p.ly)
    }

    /// Steps a frame from line 0 and checks, on every line, the FIFO's mode-3 length against
    /// Pan Docs and against the length STAT went by (`mode3_len`).
    fn assert_fifo_matches_formula(step: &mut dyn FnMut() -> (bool, bool, u32, u32, u32, u8), what: &str) {
        let (mut was_active, mut lines) = (false, 0);
        loop {
            let (active, frame_done, len, stat_len, pan_docs, ly) = step();
            if was_active && !active {
                assert_eq!(len, pan_docs, "{what}: line {ly}");
                assert_eq!(len, stat_len, "{what}: line {ly}, STAT");
                lines += 1;
            }
            was_active = active;
            if frame_done { break; }
        }
        assert_eq!(lines, SCREEN_HEIGHT, "{what}");
    }

    #[test]
    fn fifo_mode3_matches_formula() {
        // Synthetic frames: 40 OBJs spread over the lines and columns, the window on from line 20.
        for cgb in [false, true] {
            for (scx, wx) in [(0, 7), (3, 0), (5, 3), (7, 30), (1, 166), (2, 167), (6, 88)] {
                let mut p = Ppu::new();
                (p.lcdc, p.scx, p.wx, p.wy, p.cgb_mode) = (0xF3, scx, wx, 20, cgb);
                for i in 0..40 {
                    p.oam[i * 4..i * 4 + 2].copy_from_slice(&[(i * 7 % 160) as u8, (i * 37 % 170) as u8]);
                }
                let mut step = || {
                    p.step(4);
                    probe(&p)
                };
                assert_fifo_matches_formula(&mut step, &format!("CGB {cgb}, SCX {scx}, WX {wx}"));
            }
        }
        // Every line of a dmg-acid2 and a cgb-acid2 frame.
        for (name, cgb) in [("dmg-acid2.gb", false), ("cgb-acid2.gbc", true)] {
            let path = std::path::Path::new(env!("CARGO_MANIFEST_DIR")).join("test-roms").join(name);
            let Ok(rom) = std::fs::read(&path) else {
                assert!(std::env::var_os("CARTOUCHE_REQUIRE_ROMS").is_none(), "{} not found", path.display());
                return;
            };
            let mut gb = crate::gameboy::GameBoy::new(rom).unwrap();
            gb.skip_boot_rom();
            // The LD B,B breakpoint: the test image is up.
            while gb.cpu.halted || gb.bus.read_byte(gb.cpu.regs.pc) != 0x40 { gb.step_instruction().unwrap(); }
            assert!(gb.bus.ppu.lcdc & 0x80 != 0, "{name}: LCD on");
            assert_eq!(gb.bus.ppu.cgb_mode, cgb);
            while gb.bus.ppu.ly != 0 || gb.bus.ppu.mode != PpuMode::OamScan { gb.bus.cycle_tick(); }
            gb.bus.ppu.frame_ready = false;
            let mut step = || {
                gb.bus.cycle_tick();
                probe(&gb.bus.ppu)
            };
            assert_fifo_matches_formula(&mut step, name);
        }
    }

    /// CGB line 10 with BG palette 0 colour 3 red, then a BCPD write partway through mode 3 turns it
    /// blue: the pixels already out stay red, the later ones are blue.
    #[test]
    fn mid_line_bcpd_write() {
        let rgb = |p: &Ppu| -> Vec<[u8; 4]> {
            p.framebuffer[10 * SCREEN_WIDTH * 4..11 * SCREEN_WIDTH * 4].chunks(4).map(|c| c.try_into().unwrap()).collect()
        };
        let switch_at = |dot: u32| {
            let p = run_line10(|p| {
                p.cgb_mode = true;
                p.vram[0..16].fill(0xFF); // tile 0: colour 3
                p.bg_cram[6..8].copy_from_slice(&[0x1F, 0x00]); // red
                p.write_register(0xFF68, 6);
            }, |p, d| if d == dot { p.write_register(0xFF69, 0x00); p.write_register(0xFF68, 7); p.write_register(0xFF69, 0x7C) });
            let s = rgb(&p);
            let x = s.iter().position(|&c| c == [0, 0, 255, 255]).expect("blue shows");
            assert!(s[..x].iter().all(|&c| c == [255, 0, 0, 255]) && s[x..].iter().all(|&c| c == [0, 0, 255, 255]), "{s:?}");
            x
        };
        let x = switch_at(60);
        assert!((20..60).contains(&x), "switch at {x}");
        assert_eq!(switch_at(64), x + 4, "4 dots later, 4 pixels later");
    }

    /// CGB: an LCDC.4 write landing inside a tile data read gives the tile number ANDed with the
    /// byte at the new address. Tile $55 is colour 0 at $8000 and colour 3 at $8800, so a switch
    /// to $8800 caught in the low byte read shows 2,3,2,3... ($55 & $FF, then $FF); a DMG never does.
    #[test]
    fn cgb_tile_sel_switch_mid_fetch() {
        let patterns = |cgb: bool| -> Vec<Vec<u8>> {
            (16..80).map(|dot| {
                let p = run_line10(|p| {
                    p.cgb_mode = cgb;
                    p.vram[0x1800..0x1C00].fill(0x55);
                    p.vram[0x1550..0x1560].fill(0xFF); // tile $55 at $8800 ($9550); at $8000 all 0
                    for (c, rgb) in [0x7FFFu16, 0x001F, 0x03E0, 0x7C00].iter().enumerate() {
                        p.bg_cram[c * 2..c * 2 + 2].copy_from_slice(&rgb.to_le_bytes());
                    }
                }, |p, d| if d == dot { p.write_register(0xFF40, 0x81) });
                let ids: Vec<u8> = if cgb {
                    let row = &p.framebuffer[10 * SCREEN_WIDTH * 4..11 * SCREEN_WIDTH * 4];
                    row.chunks(4).map(|c| [[255, 255, 255], [255, 0, 0], [0, 255, 0], [0, 0, 255]].iter().position(|k| k[..] == c[..3]).unwrap() as u8).collect()
                } else {
                    shades(&p, 10)
                };
                ids.chunks(8).find(|t| t.iter().any(|&c| c != 0) && t.iter().any(|&c| c != 3)).map_or(vec![], |t| t.to_vec())
            }).collect()
        };
        let glitch = vec![2, 3, 2, 3, 2, 3, 2, 3];
        assert!(patterns(true).contains(&glitch), "{:?}", patterns(true));
        assert!(!patterns(false).contains(&glitch));
    }

    /// An 8x16 → 8x8 LCDC.2 write swept across an OBJ fetch: each row byte is read with the OBJ
    /// size of its dot, the high byte 2 dots after the low one. Line 10 is row 10 of an 8x16 OBJ
    /// (tile 3, row 2: colour 2) or row 2 of an 8x8 one (tile 2: colour 1); a write between the
    /// two reads mixes the 8x16 low byte with the 8x8 high byte, both 0. A DMG reads both one dot
    /// later than a CGB: its high byte on the dot the pixels resume (Mealybug
    /// `m3_lcdc_obj_size_change`, `m3_lcdc_obj_size_change_scx`).
    #[test]
    fn dmg_obj_size_switch_mid_fetch() {
        let colours = |cgb: bool| -> Vec<(u32, u8)> {
            (20..80).map(|dot| {
                let p = run_line10(|p| {
                    (p.cgb_mode, p.lcdc) = (cgb, 0x97);
                    p.oam[0..4].copy_from_slice(&[16, 16, 2, 0]); // rows 0-15 on lines 0-15, x 8-15
                    p.vram[0x24] = 0xFF; // tile 2, row 2: colour 1
                    p.vram[0x35] = 0xFF; // tile 3, row 2: colour 2
                    for (c, rgb) in [0x7FFFu16, 0x001F, 0x03E0, 0x7C00].iter().enumerate() {
                        p.bg_cram[c * 2..c * 2 + 2].copy_from_slice(&rgb.to_le_bytes());
                        p.obj_cram[c * 2..c * 2 + 2].copy_from_slice(&rgb.to_le_bytes());
                    }
                }, |p, d| if d == dot { p.write_register(0xFF40, 0x93) });
                let c = &p.framebuffer[(10 * SCREEN_WIDTH + 8) * 4..][..3];
                let id = if cgb {
                    [[255, 255, 255], [255, 0, 0], [0, 255, 0], [0, 0, 255]].iter().position(|k| k[..] == *c).unwrap() as u8
                } else {
                    shades(&p, 10)[8]
                };
                (dot, id)
            }).collect()
        };
        // The mode-3 dot of the write: a CGB's FIFO runs 2 dots ahead of a DMG's (`FIFO_LAG`).
        for (cgb, first) in [(false, 36), (true, 33)] {
            let c = colours(cgb);
            assert!(c.iter().all(|&(d, id)| id == if d < first { 1 } else if d < first + 2 { 0 } else { 2 }), "cgb {cgb}: {c:?}");
        }
    }

    /// CGB: an SCY write between a tile's two data reads. A CGB D latched the row with the tile
    /// number, so both bytes come from one row; a CGB C reads the row at each data fetch, so it
    /// can mix row 2's low byte ($00) with row 3's high byte ($FF): colour 2 (Mealybug
    /// `m3_scy_change2`, CGB C reference).
    #[test]
    fn cgb_c_latches_tile_row_at_row_fetch() {
        let colours = |rev: Revision| -> Vec<u8> {
            (16..80).flat_map(|dot| {
                let p = run_line10(|p| {
                    (p.cgb_mode, p.rev) = (true, rev);
                    p.vram[6..8].fill(0xFF); // tile 0, row 3: colour 3; row 2: colour 0
                    for (c, rgb) in [0x7FFFu16, 0x001F, 0x03E0, 0x7C00].iter().enumerate() {
                        p.bg_cram[c * 2..c * 2 + 2].copy_from_slice(&rgb.to_le_bytes());
                    }
                }, |p, d| if d == dot { p.write_register(0xFF42, 1) });
                let row = p.framebuffer[10 * SCREEN_WIDTH * 4..11 * SCREEN_WIDTH * 4].to_vec();
                row.chunks(4).map(|c| [[255, 255, 255], [255, 0, 0], [0, 255, 0], [0, 0, 255]].iter().position(|k| k[..] == c[..3]).unwrap() as u8).collect::<Vec<_>>()
            }).collect()
        };
        assert!(colours(Revision::CgbC).contains(&2), "CGB C mixes two rows");
        assert!(!colours(Revision::CgbD).contains(&2), "CGB D latches one row");
        assert!(!colours(Revision::Default).contains(&2));
    }

    /// CGB tile attributes: map entry 0 uses bank 1 and flips X and Y; its tile has one dark
    /// pixel at row 0, column 0 in bank 1 (and nothing in bank 0), so it shows at row 7, column 7.
    #[test]
    fn cgb_tile_attributes_flip_and_bank() {
        let p = run_line10(|p| {
            p.cgb_mode = true;
            p.scy = 0xFD; // line 10 + SCY = 7: map row 0, tile row 7
            p.vram[0x2000..0x2002].copy_from_slice(&[0x80, 0x80]); // bank 1, tile 0, row 0: colour 3 at column 0
            p.vram[0x2000 + 0x1800] = 0x68; // map entry 0: bank 1, X flip, Y flip
            p.bg_cram[6..8].copy_from_slice(&[0x1F, 0x00]); // palette 0 colour 3: red
        }, |_, _| {});
        let row = &p.framebuffer[10 * SCREEN_WIDTH * 4..11 * SCREEN_WIDTH * 4];
        let red: Vec<usize> = row.chunks(4).enumerate().filter(|(_, c)| *c == [255, 0, 0, 255]).map(|(x, _)| x).collect();
        assert_eq!(red, [7], "the flipped bank-1 pixel");
    }

    /// CGB: two overlapping OBJs, the one further right (X 12) first in OAM: it wins where both are
    /// opaque, although the DMG would give the dot to the one on the left (X 8).
    #[test]
    fn cgb_obj_priority_by_oam_index() {
        let run = |opri: u8| {
            let p = run_line10(|p| {
                (p.cgb_mode, p.lcdc, p.opri) = (true, 0x93, opri);
                p.vram[0..16].fill(0xFF); // tile 0: colour 3
                p.oam[0..8].copy_from_slice(&[10 + 16, 12, 0, 0x01, 10 + 16, 8, 0, 0x00]); // OBJ palettes 1, 0
                p.vram[0x1800..0x1C00].fill(1); // BG: tile 1, colour 0
                p.obj_cram[6..8].copy_from_slice(&[0x1F, 0x00]); // OBJ palette 0 colour 3: red
                p.obj_cram[14..16].copy_from_slice(&[0x00, 0x7C]); // OBJ palette 1 colour 3: blue
            }, |_, _| {});
            let px = |x: usize| <[u8; 4]>::try_from(&p.framebuffer[(10 * SCREEN_WIDTH + x) * 4..][..4]).unwrap();
            (px(3), px(4), px(11))
        };
        let (red, blue) = ([255, 0, 0, 255], [0, 0, 255, 255]);
        assert_eq!(run(0), (red, blue, blue), "by OAM index");
        assert_eq!(run(1), (red, red, blue), "OPRI bit 0: by X, as on a DMG");
    }
}
