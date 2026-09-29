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
/// Dots the mode-2 STAT source stays high from a line's start: it rises with the line and falls
/// again early in mode 2, so a STAT write enabling it later in mode 2 raises nothing and the next
/// interrupt comes with the next line (gbmicrotest `oam_int_if_level_c/d`: a write landing in the
/// line's first M-cycle fires, one M-cycle later doesn't; `oam_int_nops_b`, `oam_int_halt_a/b`).
const MODE2_PULSE: u32 = 4;
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
    /// The OAM scan of the current line, as far as it got (`catch_up_scan`): the OBJs found
    /// in entries `0..scan_next`, and how many.
    pub(crate) scan: [Sprite; 10],
    pub(crate) scan_n: usize,
    pub(crate) scan_next: u8,
    /// An OAM DMA holds OAM: the scan reads $FF there (no OBJ on the line).
    pub(crate) oam_dma: bool,

    pub mode: PpuMode,
    pub mode_clock: u32,
    pub window_line_counter: u8,
    /// WY has matched LY on a line of this frame (`wy_ok`).
    pub(crate) wy_latch: bool,
    /// DMG, WX = 166: the window, due on the line's last pixel, starts the next line instead
    /// (`end_line`).
    pub(crate) win_carry: bool,
    /// The window starts on the line's last pixel (a CGB's WX 166, `predict_len`): the mode-0
    /// interrupt comes when mode 3 would have ended without it, 6 dots before STAT shows mode 0
    /// (SameBoy's `wx_166_interrupt_glitch`, MIT; Gambatte `window/m2int_wxA6_m0irq*_1/_2` on the
    /// CGB, beside `m2int_wxA6_m3stat_*`, whose mode 3 is 6 dots longer).
    pub(crate) m0_early: bool,
    /// Dots until a WY or LCDC write is compared (`wy_write`), 0: none due.
    pub(crate) wy_check_in: u8,
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
    /// The last STAT or LYC write raised that line (`stat_line_written`): the bus requests IF.1 at
    /// once and clears it.
    pub(crate) stat_write_irq: bool,
    /// The last STAT or LYC write lowered that line (`stat_line_written`).
    pub(crate) stat_write_drop: bool,
    /// The STAT line before the M-cycle just run (`step`): a DMG's LYC write in a line's first
    /// M-cycle lands before the line starts (`stat_line_written`).
    pub(crate) stat_line_before: bool,
    /// The STAT line rose in the M-cycle just run (`step`), and whether LY = LYC alone raised it.
    pub(crate) stat_edge_now: bool,
    pub(crate) stat_edge_lyc: bool,
    /// Double speed: an LYC write near a line's end compared LY = LYC as writes do; the line's own
    /// edge follows that view until the two agree again (`stat_line_written`).
    pub(crate) lyc_write_view: bool,

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
            scan: [(0, 0, 0, 0, 0); 10],
            scan_n: 0,
            scan_next: 0,
            oam_dma: false,
            mode: PpuMode::OamScan,
            mode_clock: 0,
            window_line_counter: 0,
            wy_latch: false,
            win_carry: false,
            wy_check_in: 0,
            m0_early: false,
            lcd_on_line0: false,
            mode3_len: MODE3_MAX,
            m_cycle_dots: 4,
            rev: Revision::Default,
            framebuffer: [0; FRAMEBUFFER_SIZE],
            front: vec![0; FRAMEBUFFER_SIZE],
            frame_ready: false,
            stat_irq_line: false,
            stat_write_irq: false,
            stat_write_drop: false,
            stat_line_before: false,
            stat_edge_now: false,
            stat_edge_lyc: false,
            lyc_write_view: false,
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
        if self.scan_next < 40 { self.catch_up_scan(); }
        self.oam[offset as usize] = value;
    }

    /// The CPU cannot reach OAM in modes 2 and 3 nor VRAM and CGB palette RAM (BCPD/OCPD) in
    /// mode 3 (reads $FF, writes are dropped; Pan Docs "LCD Color Palettes"). A read is blocked
    /// from the M-cycle before STAT shows the mode (the internal mode) until STAT shows mode 0; a
    /// write only while STAT shows it, except in the M-cycle mode 3 has begun but STAT still shows
    /// mode 2, which lets a write through. The line after the LCD turns on has no OAM scan and no
    /// lead. (gbmicrotest `poweron_oam_*`, `poweron_vram_*`, `oam_*_l0/l1_*`, `vram_*_l0/l1_*`.)
    /// A CGB differs at the edges, per speed and revision (Age oam-read, oam-write, vram-read).
    // ponytail: decided per access from the mode and its dot; precompute per-line edge dots if
    // this ever shows in the bench.
    pub fn cpu_locked(&self, addr: u16, write: bool) -> bool {
        if self.lcdc & 0x80 == 0 || !matches!(addr, 0x8000..=0x9FFF | 0xFE00..=0xFE9F | 0xFF69 | 0xFF6B) {
            return false;
        }
        // How many dots into mode 2/3 the lock shows. Single speed: VRAM from mode 3's 3rd dot,
        // OAM and the palettes from its 4th; double speed: OAM from mode 2's 2nd dot, the rest from
        // the 3rd. Only a PPU off the CPU's M-cycle grid (a CGB after a speed switch) tells these
        // from one M-cycle (Gambatte `vram_m3`, `oam_access`, `cgbpal_m3` `*_lcdoffset*`).
        let lag = match (self.m_cycle_dots, addr) {
            (4, 0x8000..=0x9FFF) => 3,
            (4, _) => 4,
            (_, 0xFE00..=0xFE9F) => 1,
            _ => 2,
        };
        let shown = match self.stat_mode(lag, lag) {
            2 if self.lcd_on_line0 && self.mode == PpuMode::Drawing => 0,
            m => m,
        };
        let internal = match self.mode {
            // In double speed a CGB B/C has no lead into mode 2; a CGB E has (Age oam-read's `EFF`).
            PpuMode::OamScan if self.m_cycle_dots == 2 && self.rev != Revision::CgbE => 0,
            PpuMode::OamScan if !self.lcd_on_line0 => 2,
            PpuMode::Drawing if !self.lcd_on_line0 => 3,
            _ => 0,
        };
        let from = if (0xFE00..=0xFE9F).contains(&addr) { 2 } else { 3 };
        if write {
            // A CGB drops OAM writes from the internal mode 2 on (in double speed, on the line
            // after the LCD turns on, from its second M-cycle of mode 3), a DMG only once STAT
            // shows it (Age oam-write).
            let lead = from == 2 && (self.cgb_mode || self.compat) && match self.mode {
                PpuMode::OamScan => !self.lcd_on_line0,
                PpuMode::Drawing => self.lcd_on_line0 && self.m_cycle_dots == 2 && self.mode_clock >= 2,
                _ => false,
            };
            (shown >= from || lead) && !(shown == 2 && self.mode == PpuMode::Drawing)
        } else {
            // A CGB E unlocks OAM one dot after STAT shows mode 0 in single speed (Age oam-read's `EFF`).
            let e_lag = from == 2 && self.rev == Revision::CgbE && self.m_cycle_dots == 4
                && self.mode == PpuMode::HBlank && self.mode_clock == 3;
            if from == 3 && (self.cgb_mode || self.compat) {
                // A CGB locks VRAM only once STAT shows mode 3, and in single speed the line after
                // the LCD turns on one M-cycle after that (Age vram-read).
                return shown == 3 && !(self.lcd_on_line0 && self.m_cycle_dots == 4 && self.mode_clock < 8);
            }
            shown >= from || internal >= from || e_lag
        }
    }

    /// The mode STAT shows: mode 2 or 3 `lag` dots after it starts, mode 1 `lag1` dots after,
    /// mode 0 after `MODE0_EARLY`.
    #[inline]
    fn stat_mode(&self, lag: u32, lag1: u32) -> u8 {
        let m = self.m_cycle_dots;
        let hb = 5 - m / 2;
        match self.mode {
            _ if self.lcdc & 0x80 == 0 => 0,
            PpuMode::HBlank if self.mode_clock < hb => 3, // see MODE0_EARLY
            // The first line after LCD on has no mode 2, and its mode 3 shows 4 dots late.
            PpuMode::OamScan if self.lcd_on_line0 => 0,
            PpuMode::Drawing if self.lcd_on_line0 && self.mode_clock < 4 => 0,
            PpuMode::Drawing if self.mode_clock < lag => 2,
            // Line 0 after VBlank: 0 like the other lines in single speed on a CGB B/C, still
            // 1 in double speed and on a CGB E, which has no mode-0 M-cycle there (Age stat-mode).
            PpuMode::OamScan if self.mode_clock < lag => if self.ly == 0 && (m == 2 || self.rev == Revision::CgbE) { 1 } else { 0 },
            PpuMode::VBlank if self.mode_clock < lag1 && self.ly == 144 => 0,
            mode => mode as u8,
        }
    }

    pub fn read_register(&self, addr: u16) -> u8 {
        match addr {
            0xFF40 => self.lcdc,
            0xFF41 => {
                // A new mode reads late: mode 2 or 3 a dot after it starts, mode 1 2 dots. On the
                // CPU's M-cycle grid, one M-cycle late (its STAT interrupt is requested one M-cycle
                // ahead of the hardware line, since the CPU samples IF before its opcode fetch);
                // off it (a CGB after a speed switch) the dots tell (Gambatte
                // `lcd_offset/*_m1stat_*`, `*_lyc99int_m2stat_count_*`, `*_m3stat_count_*`,
                // `speedchange2_ly44_m3_stat`).
                let mode_bits = self.stat_mode(1, 2);
                // With the LCD off the coincidence bit is frozen at its LCD-off value
                // (kept in stored bit 2). Bit 7 is unused and always reads 1.
                let lyc_flag = if self.lcdc & 0x80 == 0 { self.stat & 0x04 }
                    else if self.ly_compare(false, false) == Some(self.lyc) { 0x04 } else { 0 };
                0x80 | (self.stat & 0x78) | lyc_flag | mode_bits
            }
            0xFF42 => self.scy,
            0xFF43 => self.scx,
            0xFF44 => {
                // CGB: read on the dot before LY moves on, LY shows LY & (LY + 1) (the bits still
                // settling); a CGB B/C single speed also on the dot before that (Age lcd-align-ly).
                let left = match self.mode {
                    PpuMode::HBlank => (376 + MODE0_EARLY - self.mode3_len).wrapping_sub(self.mode_clock),
                    PpuMode::VBlank if (144..153).contains(&self.ly) => 456 - self.mode_clock,
                    _ => 0,
                };
                let glitch = left == 1 || left == 2 && self.m_cycle_dots == 4 && self.rev != Revision::CgbE;
                if glitch && (self.cgb_mode || self.compat) { self.ly & (self.ly + 1) } else { self.ly }
            }
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
                if self.scan_next < 40 {
                    // A Color's scan sees LCDC.2 set at either end of an entry's 2 dots: going 1 to 0
                    // reaches it half an M-cycle after going 0 to 1 does (Gambatte hwtests
                    // `sprites/late_sizechange_2`, `_sp01_2`, `_sp39_2`: the DMG drops the OBJ, the
                    // CGB still counts it; `late_sizechange2_*` pins the other way on both).
                    let late = (self.cgb_mode || self.compat) && self.lcdc & !value & 0x04 != 0;
                    self.catch_up_scan_by(if late { self.m_cycle_dots / 2 } else { 0 });
                }
                let was_enabled = self.lcdc & 0x80 != 0;
                let tile_sel = (self.lcdc ^ value) & 0x10 != 0;
                // A window carried to the next line (DMG, WX = 166) turned off and on again before it
                // starts moves to its next row, as it does within a line (`fifo_dot`; Gambatte
                // `wxA6_weoff_at_xposA6`: on again in HBlank, `wxA6_wy01_weoff_ly02_weon_ly60`: in mode 2).
                if self.win_carry && self.lcdc & 0x20 == 0 && value & 0x20 != 0 {
                    self.window_line_counter = self.window_line_counter.wrapping_add(1);
                }
                self.lcdc = value;
                self.wy_write();
                self.line.win_was_on |= value & 0x20 != 0;
                if tile_sel { self.tile_sel_switch(); }
                let is_enabled = self.lcdc & 0x80 != 0;
                if was_enabled && !is_enabled {
                    // Off in the M-cycle a line starts in: the write lands before the LY = LYC edge
                    // `step` raised at its end, which never comes (Gambatte `lycEnable/ff40_disable_1/_2`).
                    if self.stat_edge_now && self.mode_clock < self.m_cycle_dots
                        && matches!(self.mode, PpuMode::OamScan | PpuMode::VBlank)
                    {
                        self.stat_write_drop = true;
                    }
                    let lyc_flag = if self.ly_compare(false, false) == Some(self.lyc) { 0x04 } else { 0 };
                    self.stat = (self.stat & !0x04) | lyc_flag;
                    self.ly = 0;
                    self.mode = PpuMode::HBlank;
                    self.mode_clock = 0;
                    // The LY = LYC part of the STAT line holds with the frozen flag: turned back on with
                    // LY 0 = LYC, the flag and the line stay set, and no edge (Mooneye `stat_lyc_onoff`).
                    self.stat_irq_line = lyc_flag != 0 && self.stat & 0x40 != 0;
                    self.lcd_on_line0 = false;
                    self.line.active = false;
                    (self.wy_latch, self.win_carry, self.window_line_counter) = (false, false, 0);
                } else if !was_enabled && is_enabled {
                    // Line 0 restarts 4 dots in, without an OAM scan.
                    self.mode = PpuMode::OamScan;
                    self.mode_clock = 4;
                    self.lcd_on_line0 = true;
                    // LY 0 = LYC raises the line in the write's M-cycle (Mooneye `stat_lyc_onoff`).
                    self.stat_line_written(false, false);
                }
            }
            0xFF41 => {
                // DMG: the write acts as if every enable were set for its M-cycle (Pan Docs
                // "Spurious STAT interrupts"), so the line rises if a source is active as it lands:
                // HBlank once STAT reads mode 0 (gbmicrotest `stat_write_glitch_l1_a/b`, `_l143_a/b`),
                // VBlank, LY = LYC (`_l0_a`, `_l154_a`), and mode 2 only while its pulse lasts
                // (`MODE2_PULSE`: `_l0_b/c`, `_l1_c/d`, `_l154_b/c`). The line after LCD on has no
                // mode-0 source (`lyc1_int_nops_a`). A CGB, in either mode, doesn't glitch.
                let read = self.read_register(0xFF41);
                // With the LCD off only the frozen LY = LYC flag is a source (Gambatte
                // `lycEnable/lcdoff_lycirqen_*`).
                let glitch = !self.cgb_mode && !self.compat && if self.lcdc & 0x80 == 0 { read & 4 != 0 } else {
                    self.mode == PpuMode::HBlank && read & 3 == 0
                        || self.mode == PpuMode::VBlank
                        || read & 4 != 0
                        || (self.mode == PpuMode::OamScan && !self.lcd_on_line0) && self.mode_clock < MODE2_PULSE };
                let (old, was_high) = (self.stat, self.stat_irq_line);
                self.stat = (value & 0x78) | (self.stat & 0x07);
                self.stat_line_written(glitch, false);
                // A write in the M-cycle line 144 starts lands before the start on a DMG and in
                // CGB double speed (after it in CGB single speed): the sources it enables or
                // disables decide the line-144 edge `step` already took, and on a DMG the glitch
                // acts on line 143's end (Gambatte `m1/m1irq_m0disable_2`, `m1irq_m0enable_ds_1`,
                // `m1irq_m2disable_lycdisable_2/_ds_1`, `m1irq_m2enable_lyc_2/_ds_1`).
                let dmg = !(self.cgb_mode || self.compat);
                if self.lcdc & 0x80 != 0 && self.mode == PpuMode::VBlank && self.ly == 144 && self.mode_clock == 0
                    && (dmg || self.m_cycle_dots == 2)
                {
                    // Line 143's end: mode 0, mode 2 already rising for line 144, LY = LYC 143.
                    let before = |s: u8| s & 0x28 != 0 || s & 0x40 != 0 && self.lyc == 143;
                    let after = |s: u8| s & 0x30 != 0 || s & 0x40 != 0 && self.lyc == 144;
                    let edge = |s: u8| after(s) && (s & 0x28 == 0 || !before(s));
                    let (was, now) = (edge(old), !before(old) && (dmg || before(self.stat)) || edge(self.stat));
                    (self.stat_write_irq, self.stat_write_drop) = (now && !was, was && !now);
                }
                if self.lcdc & 0x80 != 0 && self.mode == PpuMode::OamScan && self.mode_clock == 0
                    && !self.lcd_on_line0 && (dmg || self.m_cycle_dots == 2)
                {
                    // A STAT write in a line's first M-cycle lands before the line starts on a
                    // DMG and in CGB double speed (after it in CGB single speed), as at line 144:
                    // before the start, mode 2 has risen 2 dots early (line 0: mode 1 still
                    // holds) and mode 0 has already fallen; LY = LYC compares the new line. A DMG
                    // glitches there. (Gambatte `m2enable/late_enable_after_lycint_2`,
                    // `late_enable_m0disable_2`, `lyc0/lyc1_late_m2enable_lycdisable_*`,
                    // `late_m1disable_ly0_2`, `m2_late_m1disable_ly0_ds_1`,
                    // `miscmstatirq/lycstatwirq_trigger_*`.)
                    // In double speed the write lands on the line's dot 0, where LY = LYC still
                    // compares the line before and mode 0 has fallen: a source it enables rises
                    // there (`lycEnable/late_ff41_enable_ds_1/_2`,
                    // `miscmstatirq/lycstatwirq_trigger_m0_late_ly44_lyc44_08_40_ds_3/_4`).
                    let lyc = self.lyc == self.ly;
                    let lyc_before = if dmg { lyc } else { self.lyc == self.ly.saturating_sub(1) };
                    let early = if self.ly == 0 { 0x10 } else { 0x20 };
                    let before = |s: u8| s & early != 0 || s & 0x40 != 0 && lyc_before;
                    let after = |s: u8| s & 0x20 != 0 || s & 0x40 != 0 && lyc;
                    let was = self.stat_edge_now;
                    let low = if dmg { !self.stat_line_before } else { !before(old) };
                    let now = low && (dmg || before(self.stat)) || !before(self.stat) && after(self.stat);
                    (self.stat_write_irq, self.stat_write_drop) = (now && !was, was && !now);
                }
                self.write_vs_mode0_edge(old, self.lyc, dmg, false, was_high);
            }
            0xFF42 => self.scy = value,
            0xFF43 => self.scx = value,
            0xFF44 => {}
            0xFF45 => {
                let (old, was_high) = (self.lyc, self.stat_irq_line);
                self.lyc = value;
                self.stat_line_written(false, true);
                self.write_vs_mode0_edge(self.stat, old, false, true, was_high);
            }
            0xFF47 => {
                self.line.bgp_old = Some((self.bgp, self.line.dot));
                self.bgp = value;
            }
            0xFF48 => self.obp0 = value,
            0xFF49 => self.obp1 = value,
            0xFF4A => {
                self.wy = value;
                self.wy_write();
            }
            0xFF4B => {
                // See `wx_seen`: the old WX is compared one dot more, except by a CGB in single speed
                // (Gambatte `window/late_wx_1/_2`, `_wx03`, `_wx0f`, `_ff_07`, `_ff_0f`: a CGB's
                // write in the M-cycle before the match moves it, a DMG's does not; `late_wx_ds_1/_2`).
                let late = (!(self.cgb_mode || self.compat) || self.m_cycle_dots == 2) as u32;
                (self.line.wx_old, self.line.wx_dot) = (self.wx, self.line.dot + late);
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

    /// WY compared with LY, with the LCD and the window on: a match holds for the rest of the frame
    /// (`wy_latch`). Compared as each line starts and when WY or LCDC is written (SameBoy's
    /// `wy_check`, MIT; Gambatte `window/late_enable_afterVblank_*`: LCDC.5 on at the end of WY's
    /// line still opens the window on the next, `enable_display_ly0_wemaster_*`: WY = LY while LCDC
    /// turns the LCD on, then WY moved off).
    pub(crate) fn wy_check(&mut self) {
        if self.lcdc & 0xA0 == 0xA0 && self.wy == self.ly { self.wy_latch = true; }
    }

    /// A line starts: WY is compared with its LY a few dots in, at once on a CGB in single speed
    /// except on line 0 (Gambatte `window/arg/late_wy_1toFF_*`, `late_wy_2toFF_*`, `late_wy_1/_2`,
    /// `late_wy_ds_*`: WY moved off LY in the line's first M-cycle closes the window on a DMG, not
    /// on a CGB, on line 0 on both; one M-cycle later it no longer does).
    fn wy_line_start(&mut self, line0: bool) {
        let at: u32 = match (self.cgb_mode || self.compat, self.m_cycle_dots == 2, line0) {
            (true, false, false) => 0,
            (true, true, false) => 1,
            (true, true, true) => 5,
            _ => 2,
        };
        match at.checked_sub(self.mode_clock) {
            Some(0) | None => self.wy_check(),
            Some(d) if self.wy_check_in == 0 || d < self.wy_check_in as u32 => self.wy_check_in = d as u8,
            _ => {}
        }
    }

    /// A WY or LCDC write is compared a few dots later: 3 on a DMG, an M-cycle on a CGB (in both
    /// modes). A write in a line's last M-cycle is compared with that line on a DMG, with the next
    /// on a CGB (Gambatte `window/late_enable_afterVblank_2/_4/_ds_2`); a DMG's WY written 2 dots
    /// before a WX match misses it, 4 dots before does not (`late_scx_late_wy_FFto4_ly4_wx20_2/_3`).
    fn wy_write(&mut self) {
        if !self.wy_latch {
            self.wy_check_in = if self.cgb_mode || self.compat { self.m_cycle_dots as u8 } else { 3 };
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
    #[inline(always)]
    pub fn step(&mut self, cycles: u32) -> (bool, bool, bool) {
        if self.wy_check_in == 0 { self.step_dots(cycles) } else { self.step_wy(cycles) }
    }

    /// `step` with a WY compare due (`wy_write`): at its dot, inside these dots or at their end.
    #[inline(never)]
    fn step_wy(&mut self, cycles: u32) -> (bool, bool, bool) {
        if self.lcdc & 0x80 == 0 {
            return (false, false, false);
        }
        let due = self.wy_check_in as u32;
        if due > cycles {
            self.wy_check_in -= cycles as u8;
            return self.step_dots(cycles);
        }
        self.wy_check_in = 0;
        let a = self.step_dots(due); // a line starting there may set the next compare due
        self.wy_check();
        if due == cycles { return a; }
        let edge = (self.stat_edge_now, self.stat_edge_lyc);
        let b = self.step(cycles - due);
        if edge.0 { (self.stat_edge_now, self.stat_edge_lyc) = edge; }
        (a.0 | b.0, a.1 | b.1, a.2 | b.2)
    }

    #[inline(always)]
    fn step_dots(&mut self, cycles: u32) -> (bool, bool, bool) {
        if self.lcdc & 0x80 == 0 {
            return (false, false, false);
        }

        let mut vblank_irq = false;
        let mut hblank_entry = false;
        let mut line_start = None; // Some(line 0)
        let mut prev_stat_line = self.stat_irq_line;
        self.stat_line_before = prev_stat_line;

        self.mode_clock += cycles;

        match self.mode {
            PpuMode::OamScan => {
                if self.mode_clock >= 80 {
                    self.mode_clock -= 80;
                    self.mode = PpuMode::Drawing;
                    (self.mode3_len, self.m0_early) = (MODE3_MAX, false);
                    self.start_line();
                }
            }
            PpuMode::Drawing => {
                if !self.line.active { self.start_line(); } // a state loaded in mode 3: redraw the line
                if self.scan_next < 40 { self.catch_up_scan(); }
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
                        // LY = LYC falls 2 dots before the line (`ly_compare`), mode 1 rises with
                        // it: with no mode-0 or mode-2 source to bridge them, that is a new edge
                        // (Gambatte `m1/lycint143_m1irq_*`, `lycint_m1intirq_*`).
                        if self.stat & 0x28 == 0 { prev_stat_line = false; }
                        self.frame_ready = true;
                        self.front.copy_from_slice(&self.framebuffer);
                        if let Some(t) = self.trace.as_deref_mut() {
                            t.finish_frame(&self.framebuffer, &self.oam, &self.bg_cram, &self.obj_cram, &self.vram, self.cgb_mode, self.compat);
                        }
                        self.window_line_counter = 0;
                        vblank_irq = true;
                    } else {
                        self.mode = PpuMode::OamScan;
                        line_start = Some(false);
                        (self.scan_n, self.scan_next) = (0, 0);
                    }
                }
            }
            PpuMode::VBlank => {
                // Line 153 shows LY = 153 for 4 dots only, then 0 (compared with LYC too); 5 on a
                // CGB E and in double speed (Age ly, lcd-align-ly).
                let shown = if self.m_cycle_dots == 2 || self.rev == Revision::CgbE { 5 } else { 4 };
                if self.ly == 153 && self.mode_clock >= shown {
                    self.ly = 0;
                }
                if self.mode_clock >= 456 {
                    self.mode_clock -= 456;
                    if self.ly == 0 {
                        self.mode = PpuMode::OamScan;
                        self.wy_latch = false; // a new frame
                        line_start = Some(true);
                        (self.scan_n, self.scan_next) = (0, 0);
                    } else {
                        self.ly += 1;
                    }
                }
            }
        }

        if let Some(line0) = line_start {
            self.wy_line_start(line0);
            // Mode 0's source falls as the line starts, and the comparator takes the new LY only
            // after it: LY = LYC for the new line is a new edge unless mode 2 bridges them
            // (Gambatte `lycEnable/ff41_disable_2/_3`: the mode-0 source held the line through
            // line 5's end, LYC = 6; `miscmstatirq/lycwirq_trigger_m0_late_ly44_lyc45_*`,
            // `lcdirq_precedence/*lycirq_ly44_lcdstat48/58`).
            if !line0 && self.stat & 0x28 == 0x08 { prev_stat_line = false; }
        }

        // Compute combined STAT interrupt signal and fire only on rising edge.
        // This prevents re-firing when the condition was already active (STAT blocking).
        if self.lyc_write_view && self.dots_left() > 3 && !(self.mode == PpuMode::VBlank && matches!(self.ly, 0 | 153) && self.mode_clock <= 7) {
            self.lyc_write_view = false;
        }
        let lead = Some(if self.m_cycle_dots == 4 { 2 } else if self.lyc_write_view { 3 } else { 0 });
        let new_stat_line = self.compute_stat_line(MODE2_PULSE, self.m_cycle_dots, lead);
        let stat_irq = new_stat_line && !prev_stat_line;
        self.stat_irq_line = new_stat_line;
        self.stat_edge_now = stat_irq;
        self.stat_edge_lyc = stat_irq && self.stat & 0x40 != 0 && {
            let stat = self.stat;
            self.stat &= !0x40;
            let other = self.compute_stat_line(MODE2_PULSE, self.m_cycle_dots, lead);
            self.stat = stat;
            !other
        };

        (vblank_irq, stat_irq, hblank_entry)
    }

    /// Dots since the mode-0 STAT interrupt line rose, when it rose in the M-cycle just run
    /// (HBlank's `mode_clock` starts at the edge). `None` otherwise.
    #[inline]
    fn mode0_edge_age(&self) -> Option<u32> {
        let rose = self.lcdc & 0x80 != 0 && self.mode == PpuMode::HBlank && self.stat & 0x08 != 0;
        let age = self.mode_clock.wrapping_sub(self.mode0_irq_delay());
        (rose && age < self.m_cycle_dots).then_some(age)
    }

    /// Mode 2 started in the M-cycle just run with its STAT source enabled: the STAT edge of that
    /// M-cycle, if any, is mode 2's (an LY = LYC match at the same line start is not told apart).
    pub(crate) fn mode2_edge_now(&self) -> bool {
        self.mode == PpuMode::OamScan && self.mode_clock < self.m_cycle_dots && self.stat & 0x20 != 0
    }

    /// The mode-0 interrupt rose in the first dot of the M-cycle just run, before the CPU's write
    /// in it (which comes after its read): an IF write there clears it, an IF read misses it.
    pub(crate) fn mode0_edge_first_dot(&self) -> bool {
        self.mode0_edge_age().is_some_and(|age| age + 1 == self.m_cycle_dots)
    }

    /// The mode-0 interrupt rose in the second half of the M-cycle just run, after a halted CPU
    /// sampled IF: HALT wakes one M-cycle later than a running CPU dispatches. With the edge at
    /// Pan Docs' mode-3 length (+2 dots on the line after LCD on), this gives the SCX groups the
    /// halted CPU sees on a normal line, 0 | 1-4 | 5-7 (Mooneye `hblank_ly_scx_timing-GS`, Age
    /// `halt-m0-interrupt`), and on the line after LCD on, 0-2 | 3-6 | 7 (gbmicrotest
    /// `int_hblank_halt_scx0..7`), where a running CPU sees 0 | 1-4 | 5-7 (`int_hblank_nops/incs_scx0..7`).
    /// A STAT or LYC write in the M-cycle mode 0's STAT source rises lands before that edge on a
    /// DMG, and on a CGB while the edge is under half an M-cycle old; after it otherwise
    /// (Gambatte `m0enable/disable_*`, `lycdisable_ff41_*`, `lycdisable_ff45_*`). Before it, the
    /// sources the write leaves decide the edge `step` took with the old ones: the STAT line
    /// before the M-cycle, then LY = LYC alone until mode 0, then with mode 0. A DMG STAT write
    /// glitches as mode 3 shows then (only LY = LYC counts). After it, the edge stays. An LYC
    /// write counts before the edge on a DMG only while it is under 3 dots old; on a CGB the old
    /// LYC holds the line through an edge 2 dots or less after the write, or already in its
    /// M-cycle (`lycdisable_ff45_*`, whose SCX moves the edge a dot at a time).
    fn write_vs_mode0_edge(&mut self, old_stat: u8, old_lyc: u8, glitch: bool, lyc_write: bool, was_high: bool) {
        let dmg = !(self.cgb_mode || self.compat);
        if lyc_write && !dmg && self.stat & 0x08 != 0 && was_high
            && (self.mode == PpuMode::Drawing && (self.mode3_len - MODE0_EARLY).saturating_sub(self.mode_clock) <= 2 || self.mode0_edge_now())
        {
            (self.stat_irq_line, self.stat_write_drop) = (true, false);
            return;
        }
        if !self.mode0_edge_now() { return; }
        let age = self.mode_clock.wrapping_sub(self.mode0_irq_delay());
        if dmg && lyc_write && age >= 3 { return; }
        if !dmg && age >= self.m_cycle_dots / 2 {
            self.stat_write_drop = false;
            return;
        }
        let ly = self.ly_compare(true, false);
        let pre = |stat: u8, lyc: u8| stat & 0x40 != 0 && ly == Some(lyc);
        let post = |stat: u8, lyc: u8| pre(stat, lyc) || stat & 0x08 != 0;
        let glitch = glitch && self.ly_compare(false, false) == Some(old_lyc);
        let was = post(old_stat, old_lyc) && !self.stat_line_before;
        let (pre_now, post_now) = (pre(self.stat, self.lyc), post(self.stat, self.lyc));
        let now = !self.stat_line_before && (glitch || pre_now) || !pre_now && post_now;
        (self.stat_write_irq, self.stat_write_drop) = (now && !was, was && !now);
        self.stat_irq_line = post_now;
    }

    pub(crate) fn mode0_edge_now(&self) -> bool {
        self.lcdc & 0x80 != 0 && self.mode == PpuMode::HBlank && self.mode_clock.wrapping_sub(self.mode0_irq_delay()) < self.m_cycle_dots
    }

    pub(crate) fn mode0_edge_late(&self) -> bool {
        self.mode0_edge_age().is_some_and(|age| age < self.m_cycle_dots / 2)
    }

    /// The M-cycle before a line's mode 2, for lines 1-144 (not line 0): the mode-2 STAT source
    /// rises there already, so a running CPU dispatches its interrupt one M-cycle before STAT reads
    /// mode 2 (gbmicrotest `int_oam_*`, `lcdon_to_oam_int_l*`, `line_144_oam_int_*`, Age stat-int,
    /// stat-mode-sprites, stat-mode-window; SameBoy: "1 T-cycle before STAT actually changes,
    /// except on line 0"). IF reads, IF writes and HALT see it at the M-cycle's end
    /// (`MemoryBus::if_hidden`).
    #[inline]
    pub(crate) fn mode2_early(&self) -> bool {
        self.mode2_early_by(self.m_cycle_dots)
    }

    #[inline]
    fn mode2_early_by(&self, left: u32) -> bool {
        match self.mode {
            PpuMode::HBlank => self.mode_clock + left >= 376 + MODE0_EARLY - self.mode3_len,
            _ => false,
        }
    }

    /// Dots from HBlank's start to its STAT source: 2 in double speed, where the mode-0 interrupt
    /// comes later against mode 3's end than in single speed (Age stat-int, double-speed rows, all
    /// SCX; SameBoy raises it a dot later in double speed).
    #[inline]
    fn mode0_irq_delay(&self) -> u32 {
        if self.m_cycle_dots == 2 { 2 } else { 0 }
    }

    /// A STAT, LYC or LCD-on write lands early in its M-cycle, before the STAT line is evaluated for it
    /// (`step` ran it already): evaluate it again now, so a source the write enables, or a match
    /// it makes, rises in that M-cycle (gbmicrotest `lyc1_write_timing_a..d`, `oam_int_if_level_c/d`).
    /// `forced`: the DMG STAT-write glitch holds the line high for it. The bus requests IF.1 on a
    /// rise (`stat_write_irq`), and on a fall withdraws the edge `step` raised late in that same
    /// M-cycle, which the write came before (`line_153_lyc_int_b`). `lyc_write`: an LYC write
    /// compares like the line's own edge (`ly_compare`'s `edge`), a STAT write with the flag.
    fn stat_line_written(&mut self, forced: bool, lyc_write: bool) {
        if self.lcdc & 0x80 == 0 {
            // LCD off: the LY = LYC flag is frozen (stored bit 2) and still drives the line, so
            // enabling its source raises it; an LYC write changes nothing (Gambatte
            // `lycEnable/lcdoff_lycirqen_1..4`: a DMG's STAT write glitches on the frozen flag).
            let actual = self.stat & 0x44 == 0x44;
            self.stat_write_irq = (forced || actual) && !self.stat_irq_line;
            self.stat_irq_line = actual;
            return;
        }
        // An LYC write compares against the next line (and sees its mode 2 rise) from 2 dots
        // before the line on a DMG, 4 on a CGB, 3 in double speed (Gambatte
        // `lycEnable/ff45_enable_weirdpoint_*`, `late_ff45_enable_*`, `m2enable/lyc1_m2irq_late_lyc255_*`).
        let lead = match (self.m_cycle_dots, self.cgb_mode || self.compat) {
            (2, _) => 3,
            (_, true) => 4,
            _ => 2,
        };
        // A STAT write sees mode 2's early rise 2 dots before the line, 1 in double speed
        // (`mode2_early`: an M-cycle for the line's own edge) (Gambatte
        // `m1/lyc143_late_m2enable_lycdisable_*`, `m2enable/late_enable_m0disable_*`,
        // `m2_late_m0disable_*`, `lyc1_m2irq_late_lycdisable_*`, `lyc1_late_m2enable_lycdisable_*`).
        let early = if lyc_write { lead } else if self.m_cycle_dots == 2 { 1 } else { 2 };
        // A write catches mode 2's pulse for 2 dots, 3 in double speed and on line 0, whose mode
        // 2 has no early rise (Gambatte `m2enable/late_enable_ly0_lcdoffset2_1/_2` against
        // `late_enable_lcdoffset2_1/_2`).
        let pulse = if self.ly == 0 { 3 } else { 4 - self.m_cycle_dots / 2 };
        let actual = self.compute_stat_line(pulse, early, lyc_write.then_some(lead));
        // In double speed the line's own edge then follows the write's view of LY = LYC for the
        // rest of the line's last 3 dots (line 153: to dot 7), where it would otherwise see the
        // old line (Gambatte `lycEnable/late_ff45_enable_ds_lcdoffset1_1/_2`,
        // `ff45_enable_weirdpoint_ds_lcdoffset1_*`, `lyc153_late_ff45_enable_ds_lcdoffset1_*`).
        if lyc_write && self.m_cycle_dots == 2 {
            self.lyc_write_view = true;
        }
        let line = forced || actual;
        // A DMG's LYC write in a line's first M-cycle (and a CGB's in double speed, on its first
        // dot) lands before the line starts: the line level it compares with is the one before
        // that M-cycle, unless a mode-0 source, which falls first, held it (Gambatte
        // `lycEnable/ff45_enable_weirdpoint_3/_ds_3`, `lyc153_late_ff45_enable_3/_ds_3`,
        // `lycwirq_trigger_ly00_stat50_*`; `miscmstatirq/lycwirq_trigger_m0_late_ly44_lyc45_*`).
        // So does a STAT write in the first M-cycle of a VBlank line after 144 (Gambatte
        // `m1/m1irq_enable_after_lyc144_2`, `miscmstatirq/m1statwirq_trigger_ly94_lyc94_40_50_2/_ds_1`:
        // mode 1 enabled there bridges the LY = LYC match of the line before).
        let before = (lyc_write && self.stat & 0x08 == 0 && matches!(self.mode, PpuMode::OamScan | PpuMode::VBlank)
                || !lyc_write && self.mode == PpuMode::VBlank && self.ly != 144)
            && self.mode_clock == 0 && (self.m_cycle_dots == 2 || !(self.cgb_mode || self.compat));
        // A CGB's STAT write in line 0's first M-cycle, in single speed, lands as mode 1 ends: a
        // source it enables there bridges mode 1 (Gambatte `miscmstatirq/lycstatwirq_trigger_ly00_10_50_1/_2`;
        // enabling mode 1 itself is too late, `m1/m1irq_late_enable_2`).
        let bridge = !lyc_write && (self.cgb_mode || self.compat) && self.m_cycle_dots == 4
            && self.mode == PpuMode::OamScan && self.ly == 0 && self.mode_clock == 0;
        // A CGB's LYC write in single speed lands between its M-cycle's third and fourth dots:
        // after the LY = LYC fall `step` takes 2 dots before a line on the CPU's grid, before it
        // off the grid, 1 dot before the line (Gambatte `lycEnable/ff45_enable_weirdpoint_lcdoffset1_1/_2`:
        // LYC 5 to 6 there keeps the line up; `ff45_enable_weirdpoint_3` on the grid).
        let cgb_fall = lyc_write && (self.cgb_mode || self.compat) && self.m_cycle_dots == 4
            && self.stat_line_before && !self.stat_irq_line && self.dots_left() == 1;
        let prev = if before || bridge || cgb_fall { self.stat_line_before } else { self.stat_irq_line };
        // A CGB's write never catches line 144's mode-2 pulse (Gambatte
        // `m1/ly143_late_m2enable_2/_ds_2`, `lyc143_late_m2enable_lycdisable_2`: on a DMG it does).
        let pulse144 = (self.cgb_mode || self.compat) && self.mode == PpuMode::VBlank && self.ly == 144 && self.stat & 0x20 != 0;
        self.stat_write_irq = line && !prev
            && !(pulse144 && !forced && !self.compute_stat_line(0, early, lyc_write.then_some(lead)));
        // A CGB's write in single speed lands after an LY = LYC edge `step` raised in its M-cycle
        // (2 dots before its end: a line's, or line 153's LY 0): lowering the line then doesn't
        // withdraw it (Gambatte `lycEnable/ff45_disable_2`, `ff41_disable_2`,
        // `lyc_ff45_disable2_2`, `lyc0_ff41_disable_2`, `lyc0_ff45_disable_2`).
        let cgb_after = (self.cgb_mode || self.compat) && self.m_cycle_dots == 4 && self.stat_edge_lyc;
        self.stat_write_drop = !line && self.stat_irq_line && !cgb_after;
        self.stat_irq_line = actual;
    }

    /// OR of all enabled STAT interrupt sources. Used for rising-edge detection. `pulse`: the dots
    /// mode 2's source counts from the line start (a write catches fewer); `early`: the dots before
    /// a line its mode-2 source has risen (`mode2_early`); `lyc_lead`: `ly_compare_lead`'s lead
    /// (`None`: the flag, as a STAT write sees it).
    #[inline]
    fn compute_stat_line(&self, pulse: u32, early: u32, lyc_lead: Option<u32>) -> bool {
        if self.stat & 0x78 == 0 { return false; } // no source enabled: every term below is false
        let hblank = (self.mode == PpuMode::HBlank && self.mode_clock >= self.mode0_irq_delay()
            || self.m0_early && self.mode == PpuMode::Drawing && self.mode_clock + 6 + MODE0_EARLY >= self.mode3_len)
            && self.stat & 0x08 != 0;
        let vblank = self.mode == PpuMode::VBlank  && self.stat & 0x10 != 0;
        // Mode 2 is a pulse at the line start, not a level (`MODE2_PULSE`). Line 144 has it too;
        // line 0 after LCD on doesn't. It rises
        // in the M-cycle before the line (`mode2_early`). A write enabling it catches it for 2
        // dots, 3 in double speed: on the CPU's M-cycle grid that is the line's first M-cycle, off
        // it (a CGB after a speed switch) no more (Gambatte `m2enable/late_enable_*lcdoffset*`).
        let oam    = ((self.mode == PpuMode::OamScan && !self.lcd_on_line0 || self.mode == PpuMode::VBlank && self.ly == 144)
            && self.mode_clock < pulse || self.mode2_early_by(early))
            && self.stat & 0x20 != 0;
        // No comparator blank at a line start: the interrupt is requested one M-cycle ahead of the
        // line (the CPU samples IF before its opcode fetch).
        let lyc    = self.stat & 0x40 != 0 && match lyc_lead {
            Some(lead) => self.ly_compare_lead(true, true, lead),
            None => self.ly_compare(true, false),
        } == Some(self.lyc);
        hblank || vblank || oam || lyc
    }

    /// The line LY=LYC compares against: none for the first M-cycle of a line (the comparator
    /// is updating), and on line 153 (whose LY reads 0 after its first M-cycle) 153 for one
    /// M-cycle, none for one, then 0 through line 0. `edge` (the line's own STAT edge and LYC
    /// writes, not STAT writes or reads): in single speed the comparator takes the next line 2
    /// dots before the line ends. On the CPU's M-cycle grid that is the M-cycle the line starts
    /// in; off it (a CGB after a speed switch) the interrupt comes one M-cycle earlier (Gambatte
    /// `lcd_offset/offset*_lyc98int_ly_count_*`, `vram_m3`/`oam_access`/`cgbpal_m3` `*_lcdoffset*`,
    /// `lycEnable/late_ff4[15]_enable_lcdoffset1_*`). Not in double speed (the `_ds` variants).
    #[inline]
    fn ly_compare(&self, irq: bool, edge: bool) -> Option<u8> {
        self.ly_compare_lead(irq, edge, if edge && self.m_cycle_dots == 4 { 2 } else { 0 })
    }

    /// Dots until the line ends, in HBlank and VBlank (0 in modes 2 and 3).
    #[inline]
    fn dots_left(&self) -> u32 {
        match self.mode {
            PpuMode::HBlank => (376 + MODE0_EARLY - self.mode3_len).wrapping_sub(self.mode_clock),
            PpuMode::VBlank => 456u32.wrapping_sub(self.mode_clock),
            _ => 0,
        }
    }

    #[inline]
    fn ly_compare_lead(&self, irq: bool, edge: bool, lead: u32) -> Option<u8> {
        let c = self.mode_clock;
        if irq && edge && lead > 0 {
            if (1..=lead).contains(&self.dots_left()) {
                return match (self.mode, self.ly) {
                    // A CGB's LYC write already sees 153 there; the line's own edge doesn't.
                    (PpuMode::VBlank, 152) => (lead > 2).then_some(153),
                    (PpuMode::VBlank, 0 | 153) => Some(0),
                    (_, ly) => Some(ly + 1),
                };
            }
        }
        // Line 153's edge sees 153 from the line's start, not an M-cycle later like its STAT
        // flag, for 6 dots (8 in double speed), then 0 (Gambatte `ly0/lycint152_lyc153irq_*`,
        // `lyc153int_m2irq_*`, `lycEnable/lyc153_late_*`, the `window/arg/late_wy_*` timed from it).
        // A CGB's LYC write sees 0 sooner: after 3 dots, 4 in double speed (Gambatte
        // `lycEnable/lyc153_late_ff45_enable_*`, whose writes step through the line's first dots).
        if irq && edge && matches!((self.mode, self.ly), (PpuMode::VBlank, 0 | 153)) {
            let shown = match lead { 4 => 3, 3 => 4, _ if self.m_cycle_dots == 4 => 5, _ => 7 };
            return if c <= shown { Some(153) } else { Some(0) };
        }
        // A STAT write's view of line 153 (`irq`, not `edge`): 153 from dot 4 to 11 on a DMG,
        // from its start to dot 7 on a CGB, from dot 2 to 8 in double speed (Gambatte
        // `lycEnable/lyc153_late_ff41_enable_*`, `lyc153_*m1disable_*`, `lyc0_m1disable_*`: mode 1
        // or LY = LYC turned on or off against the 153 and LY 0 matches).
        if irq && !edge && matches!((self.mode, self.ly), (PpuMode::VBlank, 0 | 153)) {
            let (from, to) = match (self.cgb_mode || self.compat, self.m_cycle_dots) {
                (false, _) => (4, 11),
                (true, 4) => (0, 7),
                _ => (2, 8),
            };
            return if c < from { None } else if c <= to { Some(153) } else { Some(0) };
        }
        match (self.mode, self.ly) {
            (PpuMode::VBlank, 0 | 153) if self.m_cycle_dots == 2 && !irq => match c { 0..=1 => None, 2..=9 => Some(153), _ => Some(0) },
            (PpuMode::VBlank, 0 | 153) => match c { 0..=3 => None, 4..=7 => Some(153), 8..=11 if !irq => None, _ => Some(0) },
            (PpuMode::OamScan, 0) => Some(0),
            (PpuMode::OamScan | PpuMode::VBlank, _) if c < self.m_cycle_dots && !irq => (self.m_cycle_dots == 2 && c == 0).then(|| self.ly - 1),
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

    /// The OAM scan reads entry i at dot 2i + 4 of the line (mode 2 is dots 0-79, so
    /// entry 39 is read in mode 3's first dots), with the OBJ height LCDC.2 has then, and sees no
    /// OBJ while an OAM DMA holds OAM. It runs lazily: up to the current dot when OAM, LCDC or the
    /// DMA is about to change, and on through mode 3's first steps. Gambatte hwtests
    /// `oamdma/late_spNN{x,y}_1/_2` (an OAM DMA starting an M-cycle before or after entry 0, 1, 2
    /// or 39 is read) and `sprites/late_sizechange[2]_spNN_1/_2` (LCDC.2 flipped around it), both
    /// models.
    pub(crate) fn catch_up_scan(&mut self) {
        self.catch_up_scan_by(0);
    }

    /// `catch_up_scan` as if `ahead` dots later.
    fn catch_up_scan_by(&mut self, ahead: u32) {
        let dot = ahead + match self.mode {
            _ if self.lcdc & 0x80 == 0 || self.lcd_on_line0 => { self.scan_next = 40; return; }
            PpuMode::OamScan => self.mode_clock,
            PpuMode::Drawing => 80 + self.mode_clock,
            _ => return,
        };
        let n = self.scan_n;
        self.scan_to((dot.saturating_sub(2) / 2).min(40) as usize);
        if self.mode == PpuMode::Drawing && self.line.active && self.scan_n != n { self.sync_line_sprites(); }
    }

    /// An OAM DMA takes OAM or gives it back: the scan runs up to now first.
    pub(crate) fn set_oam_dma(&mut self, on: bool) {
        if self.scan_next < 40 { self.catch_up_scan(); }
        self.oam_dma = on;
    }

    /// Scans OAM entries `scan_next..upto` for the current line.
    pub(crate) fn scan_to(&mut self, upto: usize) {
        let height: i16 = if self.lcdc & 0x04 != 0 { 16 } else { 8 };
        let line = self.ly as i16;
        for i in self.scan_next as usize..upto {
            let b = i * 4;
            let top = self.oam[b] as i16 - 16;
            if self.scan_n < 10 && !self.oam_dma && (top..top + height).contains(&line) {
                self.scan[self.scan_n] = (self.oam[b + 1], i, self.oam[b], self.oam[b + 2], self.oam[b + 3]);
                self.scan_n += 1;
            }
        }
        self.scan_next = self.scan_next.max(upto as u8);
    }

    /// The first 10 OBJs (OAM order) that overlap `line`, OAM read at once (Pan Docs' model).
    #[cfg(test)]
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

    /// Line 10's OAM scan, stopped at `dot` (mode 2's dots 0-79, then mode 3's).
    fn scan_at(p: &mut Ppu, dot: u32) {
        (p.mode, p.mode_clock) = if dot < 80 { (PpuMode::OamScan, dot) } else { (PpuMode::Drawing, dot - 80) };
    }

    fn line10_scan(lcdc: u8) -> Ppu {
        let mut p = Ppu::new();
        (p.lcdc, p.ly, p.scan_n, p.scan_next) = (lcdc, 10, 0, 0);
        p
    }

    /// Entry 0 is read at dot 4: an OAM write at dot 0 is seen, one at dot 4 is not.
    #[test]
    fn oam_write_mid_scan_is_seen_per_entry() {
        for (dot, seen) in [(0, 1), (4, 0)] {
            let mut p = line10_scan(0x83);
            scan_at(&mut p, dot);
            p.write_oam(0, 16 + 10); // entry 0 onto line 10
            scan_at(&mut p, 90);
            p.catch_up_scan();
            assert_eq!(p.scan_n, seen, "write at dot {dot}");
        }
    }

    /// Entry 39 is read at dot 82, in mode 3: LCDC.2 set at dot 80 makes it 16 tall, at dot 84 too late.
    #[test]
    fn size_change_mid_scan_per_entry() {
        for (dot, seen) in [(80, 1), (84, 0)] {
            let mut p = line10_scan(0x83);
            p.oam[39 * 4] = 16 + 2; // rows 2-9 (8 tall) or 2-17 (16 tall)
            scan_at(&mut p, dot);
            p.write_register(0xFF40, 0x87);
            scan_at(&mut p, 90);
            p.catch_up_scan();
            assert_eq!(p.scan_n, seen, "LCDC.2 set at dot {dot}");
        }
    }

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

    /// Line 0 after LCD on has no OAM scan, so no mode-2 edge: the only one is line 1's, in line
    /// 0's last M-cycle (`mode2_early`).
    #[test]
    fn lcd_on_line_0_has_no_mode2_stat_edge() {
        let mut p = Ppu::new();
        p.write_register(0xFF41, 0x20); // mode 2 interrupt
        p.write_register(0xFF40, 0x80);
        while p.ly == 0 {
            let fired = p.step(4).1;
            assert_eq!(fired, p.ly == 0 && p.mode2_early(), "line 0 after LCD on skips the OAM scan; line 1 has one");
        }
    }

    /// The mode-2 source is a pulse: STAT bit 5 written in a line's first M-cycle raises the
    /// interrupt, written one M-cycle later it raises nothing until the next line (gbmicrotest
    /// `oam_int_if_level_c/d`).
    /// A DMG STAT write raises the STAT line when a source is active, whatever the value written
    /// (gbmicrotest `stat_write_glitch_*`): in HBlank once STAT reads 0, not in mode 3 or after the
    /// mode-2 pulse. A CGB never does.
    #[test]
    fn dmg_stat_write_glitch_raises_if() {
        let write_at = |cgb: bool, mode: PpuMode, clk: u32| {
            let mut p = Ppu::new();
            (p.lcdc, p.ly, p.lyc, p.cgb_mode) = (0x81, 10, 0, cgb); // LYC 0: no coincidence
            while p.mode != mode { p.step(1); }
            while p.mode_clock < clk { p.step(1); }
            p.write_register(0xFF41, 0x00);
            p.stat_write_irq
        };
        assert!(write_at(false, PpuMode::HBlank, 4), "HBlank, STAT reads 0");
        assert!(!write_at(false, PpuMode::HBlank, 2), "HBlank, STAT still reads 3");
        assert!(!write_at(false, PpuMode::Drawing, 40), "mode 3");
        assert!(write_at(false, PpuMode::OamScan, 0), "mode 2's pulse");
        assert!(!write_at(false, PpuMode::OamScan, 4), "mode 2 after its pulse");
        assert!(!write_at(true, PpuMode::HBlank, 4), "no glitch on a CGB");
    }

    /// A LYC write that makes LY = LYC raises the line in the write's own M-cycle, not the next
    /// one (gbmicrotest `lyc1_write_timing_a..d`). Across LCD off and on the LY = LYC part of the line
    /// holds with the frozen flag: back on with LY 0 = LYC, no new edge; with the flag clear, an
    /// edge at once (Mooneye `stat_lyc_onoff`).
    #[test]
    fn lyc_write_takes_effect_after_delay() {
        let mut p = Ppu::new();
        (p.lcdc, p.ly, p.mode, p.mode_clock, p.stat, p.lyc) = (0x81, 10, PpuMode::Drawing, 40, 0x40, 0xFF);
        p.write_register(0xFF45, 10);
        assert!(p.stat_write_irq, "LYC = LY: the line rises with the write");
        p.write_register(0xFF45, 11);
        assert!(!p.stat_write_irq && p.stat_write_drop, "and falls with the next one");

        for (held, edge) in [(true, false), (false, true)] {
            let mut p = Ppu::new();
            (p.lcdc, p.ly, p.mode, p.mode_clock, p.stat) = (0x81, 0x90, PpuMode::VBlank, 100, 0x40);
            p.lyc = if held { 0x90 } else { 0 };
            p.stat_irq_line = held;
            p.write_register(0xFF40, 0x00);
            p.write_register(0xFF45, 0);
            p.write_register(0xFF40, 0x80);
            assert_eq!(p.stat_write_irq, edge, "flag held through LCD off: {held}");
        }
    }

    #[test]
    fn mode2_stat_source_is_a_pulse() {
        for (m_cycle, fires) in [(0, true), (1, false), (20, false)] {
            let mut p = Ppu::new();
            // A CGB: the same pulse, without the DMG STAT-write glitch.
            (p.lcdc, p.ly, p.mode, p.mode_clock, p.cgb_mode) = (0x81, 9, PpuMode::HBlank, 0, true);
            while p.ly == 9 { p.step(4); }
            for _ in 0..m_cycle { p.step(4); }
            p.write_register(0xFF41, 0x20);
            assert_eq!(p.stat_write_irq, fires, "STAT written in M-cycle {m_cycle} of mode 2");
            let mut next_line = false;
            while !next_line { next_line = p.step(4).1; }
            assert_eq!((p.ly, p.mode), (10, PpuMode::HBlank), "then in the M-cycle before the next line");
        }
    }

    /// Line 0 after LCD on reads mode 0 until mode 3, but its mode-0 interrupt comes only at its
    /// HBlank (gbmicrotest `hblank_int_l0`, `int_hblank_incs/nops_scx*`: 61 M-cycles or more after LCD on).
    #[test]
    fn lcd_on_line_0_mode0_irq_only_at_hblank() {
        let mut p = Ppu::new();
        p.write_register(0xFF41, 0x08); // mode 0 interrupt
        p.write_register(0xFF40, 0x80);
        let mut m = 1;
        while !p.step(4).1 { m += 1; }
        assert_eq!((p.mode, m), (PpuMode::HBlank, 62), "the first edge is its HBlank's");
    }

    /// Line 0 after LCD on: mode 3 ends 2 dots later than on other lines, SCX extension included,
    /// and shows 4 dots in, 3 dots later than other lines (Age stat-mode; on the CPU's M-cycle grid
    /// the same M-cycle in single speed).
    #[test]
    fn lcd_on_line_0_mode3_timing() {
        for m_cycle_dots in [4, 2] {
            let shows_late = 3;
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

    /// LY as read on each dot around its increments (Age ly, lcd-align-ly): the last three dots of
    /// line 1 (a CGB reads 1 & 2 = 0 on the last one, a CGB B/C single speed on the last two), and
    /// how many dots line 153 shows 153 (5 on a CGB E and in double speed).
    #[test]
    fn ly_increments_per_model() {
        for (cgb, rev, m_cycle_dots, last3, shows_153) in [
            (false, Revision::Default, 4, [1, 1, 1], 4),
            (true, Revision::Default, 4, [1, 0, 0], 4),
            (true, Revision::CgbC, 4, [1, 0, 0], 4),
            (true, Revision::CgbE, 4, [1, 1, 0], 5),
            (true, Revision::CgbC, 2, [1, 1, 0], 5),
            (true, Revision::CgbE, 2, [1, 1, 0], 5),
        ] {
            let mut p = Ppu::new();
            (p.lcdc, p.ly, p.cgb_mode, p.rev, p.m_cycle_dots) = (0x81, 1, cgb, rev, m_cycle_dots);
            let mut reads = vec![];
            while p.ly == 1 {
                reads.push(p.read_register(0xFF44));
                p.step(1);
            }
            assert_eq!(p.read_register(0xFF44), 2);
            assert_eq!(reads[reads.len() - 3..], last3, "{cgb} {rev:?} {m_cycle_dots}");
            while !(p.ly == 153 && p.mode == PpuMode::VBlank) { p.step(1); }
            let mut n = 0;
            while p.read_register(0xFF44) == 153 { n += 1; p.step(1); }
            assert_eq!(n, shows_153, "{cgb} {rev:?} {m_cycle_dots}");
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

    /// A STAT write disabling mode 0 in the M-cycle its edge came lands before the edge on a DMG
    /// (the edge goes), on a CGB only while the edge is under 2 dots old (Gambatte
    /// `m0enable/disable_scx*_1/_2`).
    #[test]
    fn late_ff41_enable_vs_mode0_edge() {
        for (cgb, age, kept) in [(false, 3, false), (true, 1, false), (true, 2, true), (true, 3, true)] {
            let mut p = Ppu::new();
            (p.lcdc, p.ly, p.mode, p.mode3_len, p.stat, p.cgb_mode) = (0x81, 10, PpuMode::Drawing, 172, 0x08, cgb);
            p.mode_clock = 172 - MODE0_EARLY - 4 + age;
            p.start_line();
            p.mode3_len = 172;
            let (_, irq, _) = p.step(4);
            assert!(irq && p.mode == PpuMode::HBlank && p.mode_clock == age, "CGB {cgb}, age {age}");
            p.write_register(0xFF41, 0);
            assert_eq!(!p.stat_write_drop, kept, "CGB {cgb}, the edge {age} dots old");
        }
    }

    /// A DMG STAT write in a line's first M-cycle lands before the line: enabling mode 2 there
    /// (with mode 0 falling) keeps the line up, where a CGB takes a new edge (Gambatte
    /// `m2enable/late_enable_m0disable_2`).
    #[test]
    fn stat_write_at_line_start() {
        for (cgb, edge) in [(false, false), (true, true)] {
            let mut p = Ppu::new();
            (p.lcdc, p.ly, p.mode, p.mode3_len, p.stat, p.cgb_mode) = (0x81, 1, PpuMode::HBlank, 172, 0x08, cgb);
            p.mode_clock = 376 + MODE0_EARLY - 172 - 8;
            p.step(4);
            p.step(4);
            assert_eq!((p.ly, p.mode, p.mode_clock), (2, PpuMode::OamScan, 0));
            p.write_register(0xFF41, 0x20);
            assert_eq!(p.stat_write_irq, edge, "CGB {cgb}");
        }
    }

    /// LY = LYC 153 raises its edge in the M-cycle line 153 starts, while STAT's flag shows it an
    /// M-cycle later, in both speeds (Gambatte `ly0/lycint152_lyc153irq_*`, `lycint152_lyc153flag_*`).
    #[test]
    fn lyc_sees_153_then_0() {
        for m in [4, 2] {
            let mut p = Ppu::new();
            (p.lcdc, p.ly, p.mode, p.mode_clock, p.m_cycle_dots, p.stat, p.lyc) = (0x81, 152, PpuMode::VBlank, 456 - m, m, 0x40, 153);
            let (_, irq, _) = p.step(m);
            assert!(irq && p.ly == 153 && p.mode_clock == 0, "{m} dots per M-cycle: the edge comes with line 153");
            assert_eq!(p.read_register(0xFF41) & 4, 0, "{m} dots per M-cycle: the flag comes later");
            while p.mode_clock < 4 { p.step(m); }
            assert_eq!(p.read_register(0xFF41) & 4, 4, "{m} dots per M-cycle");
        }
    }

    /// An LYC write that moves a match to the next line near a line's end keeps the STAT line up
    /// when it lands after the comparator took the next line: 4 dots before it on a CGB, 2 on a
    /// DMG (Gambatte `lycEnable/ff45_enable_weirdpoint_*`).
    #[test]
    fn ff45_write_weird_point() {
        for (cgb, left, edge) in [(true, 4, false), (true, 8, true), (false, 4, true), (false, 2, false)] {
            let mut p = Ppu::new();
            (p.lcdc, p.ly, p.mode, p.mode3_len, p.lyc, p.stat, p.cgb_mode) = (0x81, 5, PpuMode::HBlank, 172, 5, 0x40, cgb);
            p.mode_clock = 376 + MODE0_EARLY - 172 - left;
            p.stat_irq_line = true;
            p.write_register(0xFF45, 6);
            let mut irq = p.stat_write_irq;
            while p.ly == 5 { irq |= p.step(2).1; }
            irq |= p.step(2).1;
            assert_eq!(irq, edge, "CGB {cgb}, written {left} dots before line 6");
        }
    }

    /// LY = LYC 143 falls just before line 144, where mode 1 rises: with the LYC and mode-1
    /// sources alone that is a new STAT edge; a mode-0 source bridges them (Gambatte
    /// `m1/lycint143_m1irq_*`, `m1irq_m0disable_*`).
    #[test]
    fn lyc143_and_mode1_or_at_vblank() {
        for (stat, edge) in [(0x50, true), (0x58, false)] {
            let mut p = Ppu::new();
            (p.lcdc, p.ly, p.mode, p.mode3_len, p.lyc, p.stat) = (0x81, 143, PpuMode::HBlank, 172, 143, stat);
            p.mode_clock = 376 + MODE0_EARLY - 172 - 4;
            p.stat_irq_line = true;
            let (_, irq, _) = p.step(4);
            assert_eq!((p.ly, irq), (144, edge), "STAT {stat:02X}");
        }
    }

    /// The LY = LYC edge of a line comes 2 dots before it in single speed, at it in double speed:
    /// with the PPU off the CPU's M-cycle grid, one M-cycle earlier (Gambatte
    /// `lcd_offset/offset*_lyc98int_ly_count_*`, the `_ds` variants).
    #[test]
    fn lyc_edge_leads_the_line_by_2_dots_in_single_speed() {
        for (m_cycle_dots, lead) in [(4, 2), (2, 0)] {
            for left in 0..m_cycle_dots + 2 {
                let mut p = Ppu::new();
                (p.lcdc, p.ly, p.lyc, p.stat, p.m_cycle_dots) = (0x81, 10, 11, 0x40, m_cycle_dots);
                (p.mode, p.mode3_len) = (PpuMode::HBlank, 172);
                p.mode_clock = 376 + MODE0_EARLY - 172 - left - m_cycle_dots;
                let (_, irq, _) = p.step(m_cycle_dots);
                assert_eq!(irq, left <= lead, "{m_cycle_dots} dots per M-cycle, {left} dots before the line");
            }
        }
    }

    /// M-cycles from the one raising line 8's mode-2 interrupt to the first STAT read of mode 0,
    /// with an OBJ at X 8 or the window at WX 7 (SCX 0), in single and double speed. Age
    /// stat-mode-sprites and stat-mode-window read STAT this many M-cycles after the interrupt
    /// (5 of dispatch, the handler's, a NOP run, and the read's 3rd M-cycle).
    #[test]
    fn stat_mode_end_with_objs_and_window_ds() {
        for (ds, window, first_mode0) in [(false, false, 67), (false, true, 66), (true, false, 134), (true, true, 131)] {
            let mut p = Ppu::new();
            let m = if ds { 2 } else { 4 };
            (p.m_cycle_dots, p.cgb_mode, p.stat) = (m, ds, 0x20);
            if window {
                (p.lcdc, p.wy, p.wx) = (0xA0, 8, 7); // no OBJ: a CGB fetches it with LCDC.1 off too
            } else {
                p.lcdc = 0x82;
                p.oam[0..2].copy_from_slice(&[24, 8]); // row 0 on line 8, X 8
            }
            (p.ly, p.mode, p.mode_clock) = (7, PpuMode::OamScan, 40);
            while !p.step(m).1 {}
            assert_eq!((p.ly, p.mode), (7, PpuMode::HBlank), "the interrupt comes in line 7's last M-cycle");
            let (mut k, mut drawing) = (0, false);
            loop {
                p.step(m);
                k += 1;
                let mode = p.read_register(0xFF41) & 3;
                if drawing && mode == 0 { break; }
                drawing |= mode == 3;
            }
            assert_eq!(k, first_mode0, "double speed {ds}, window {window}");
        }
    }

    /// Steps line 10 dot by dot from its start: (dot where mode 3's length runs out, dots until LY moves on).
    fn line_timing(setup: impl Fn(&mut Ppu)) -> (u32, u32) {
        let mut p = Ppu::new();
        p.lcdc = 0x83; // LCD, BG, OBJ on
        p.ly = 10;
        setup(&mut p);
        p.wy_check(); // as the line starts
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

    /// A CGB pays for the OBJs on the line with LCDC.1 off too, in both speeds; a DMG does not
    /// (Gambatte `oamdma/late_sp*_ds_*`, `sprites/late_disable_ds_*`).
    #[test]
    fn cgb_fetches_objs_with_lcdc1_off() {
        for (cgb, ds) in [(true, false), (true, true), (false, false)] {
            let len = line_timing(|p| {
                objs_at(p, &[8]);
                p.lcdc &= !0x02;
                (p.cgb_mode, p.m_cycle_dots) = (cgb, if ds { 2 } else { 4 });
            }).0;
            assert_eq!(len, 80 + 172 + if cgb { 11 } else { 0 }, "cgb {cgb}, double speed {ds}");
        }
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
        p.wy_check(); // as the line starts
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

    /// Non-CGB mode: a CGB B/C shows a BGP write one pixel later than a CGB E (Age m3-bg-bgp,
    /// ncmBC vs ncmE references).
    #[test]
    fn cgb_bc_shows_bgp_write_a_pixel_later() {
        let switch_x = |rev: Revision| {
            let p = run_line10(|p| {
                (p.compat, p.rev) = (true, rev);
                p.vram[0..16].fill(0xFF);
                p.bg_cram[6..8].copy_from_slice(&0x001Fu16.to_le_bytes()); // shade 3: red, the others black
            }, |p, d| if d == 60 { p.write_register(0xFF47, 0x1B) });
            let row = &p.framebuffer[10 * SCREEN_WIDTH * 4..11 * SCREEN_WIDTH * 4];
            row.chunks(4).position(|c| c != &row[..4]).expect("the new shade shows")
        };
        assert_eq!(switch_x(Revision::CgbC), switch_x(Revision::CgbE) + 1);
    }

    /// A mid-line SCX write moves the next tile fetch by all of SCX, fine bits too: the map column
    /// is (SCX + x + 8) / 8 (SameBoy; Age m3-bg-scx). SCX 15 reaches a map column 8 pixels before
    /// SCX 8 does, though both have coarse bits 1.
    #[test]
    fn mid_line_scx_write_moves_the_next_tile_by_its_fine_bits() {
        let black_from = |scx: u8| {
            let p = run_line10(|p| {
                p.vram[16..32].fill(0xFF); // tile 1: colour 3
                for col in 12..32 { p.vram[0x1800 + 32 + col] = 1; } // map row 1 (line 10), columns 12+
            }, |p, d| if d == 60 { p.write_register(0xFF43, scx) });
            shades(&p, 10).iter().position(|&v| v == 3).expect("black shows")
        };
        assert_eq!(black_from(15) + 8, black_from(8));
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
        let s = shades(&run_line10(|p| { window_setup(p); p.wy = 0; p.wy_latch = true; }, |_, _| {}), 10);
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
            86 => { p.write_register(0xFF40, 0xD1); p.write_register(0xFF4B, 100); }
            106 => p.write_register(0xFF40, 0xF1),
            _ => {}
        });
        let s = shades(&p, 10);
        assert!(s[43..60].iter().all(|&v| v == 3), "the window from x = 43, row 0: {s:?}");
        assert!(s[80..93].iter().all(|&v| v == 0), "BG while it is off: {s:?}");
        assert!(s[93..].iter().all(|&v| v == 1), "restarted at x = 93 on row 1: {s:?}");
        assert_eq!(p.window_line_counter, 2, "two rows used");
    }

    /// WY written in mode 3 is compared 3 dots later on a DMG, 4 (an M-cycle) on a CGB: the window
    /// opens on this line if that compare comes before its WX match (x = 43 here), else not before
    /// WY matches again.
    #[test]
    fn late_wy_write_triggers_per_compare_dot() {
        // The last mode-3 dot a WY = LY write still opens the window at x = 43, written through the
        // bus or compared at once.
        let last_write = |cgb: bool, at_once: bool| {
            let shows = |d: u32| {
                let p = run_line10(|p| { window_setup(p); (p.wy, p.cgb_mode) = (0xFF, cgb); }, |p, dot| if dot == d {
                    if at_once { p.wy = 10; p.wy_check() } else { p.write_register(0xFF4A, 10) }
                });
                p.line.win_x == 43 && p.window_line_counter == 1
            };
            let last = (0..100).rev().find(|&d| shows(d)).expect("an early write opens it");
            assert!(shows(0) && !shows(last + 1));
            last
        };
        assert_eq!(last_write(false, false), last_write(false, true) - 3, "DMG: 3 dots");
        assert_eq!(last_write(true, false), last_write(true, true) - 4, "CGB: an M-cycle");
    }

    /// A WX write reaches the window's match one dot later on a DMG than on a CGB in single speed.
    #[test]
    fn cgb_wx_write_reaches_the_match_at_once() {
        // The last mode-3 dot a WX 50 → 255 write still keeps the window from x = 43.
        let last_write = |cgb: bool| {
            let shows = |d: u32| {
                let p = run_line10(|p| { window_setup(p); p.cgb_mode = cgb; }, |p, dot| if dot == d { p.write_register(0xFF4B, 0xFF) });
                p.line.window_triggered
            };
            assert!(!shows(0));
            (0..100).find(|&d| shows(d)).expect("a late write leaves it") - 1
        };
        // A CGB's FIFO matches 2 dots ahead of a DMG's (`FIFO_LAG`), less the dot a DMG's write waits.
        assert_eq!(last_write(false) - last_write(true), 1);
    }

    /// DMG, WX = 166: no window on WY's line, but its last pixel uses a window row, and the next
    /// line is the window from x = 0, on its second column (Gambatte `window/on_screen/wxA6_*`).
    #[test]
    fn wx_a6_triggers_on_the_last_pixel() {
        let mut p = Ppu::new();
        window_setup(&mut p);
        (p.bgp, p.ly, p.wx) = (0xE4, 10, 166);
        p.vram[0x1C01] = 0; // window column 1: light, the rest dark
        p.wy_check();
        while p.ly < 12 { p.step(1); }
        assert!(shades(&p, 10).iter().all(|&v| v == 0), "WY's line is BG");
        let s = shades(&p, 11);
        assert!(s[..8].iter().all(|&v| v == 0) && s[8..].iter().all(|&v| v == 3), "the window's column 1 first: {s:?}");
        assert_eq!(p.window_line_counter, 2, "a row on each line");
        // A CGB starts it on each line's last pixel: nothing is carried to the next line.
        let mut p = Ppu::new();
        window_setup(&mut p);
        (p.cgb_mode, p.ly, p.wx) = (true, 10, 166);
        p.wy_check();
        while p.ly < 11 { p.step(1); }
        assert!(!p.win_carry);
        while p.ly < 12 { p.step(1); }
        assert_eq!(p.window_line_counter, 2);
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

    /// DMG, LCDC.5 off the whole line: once the window drew earlier in the frame, a WX match on a
    /// tile boundary ((WX & 7) == 7 - (SCX & 7)) gives one colour-0 pixel and the BG goes on a pixel
    /// later, 160 pixels in the same mode-3 length; never while the window has not drawn (logic
    /// captures in SameBoy issue #278).
    #[test]
    fn window_off_pixel_after_the_window_drew() {
        let setup = |drew: u8| move |p: &mut Ppu| {
            p.lcdc = 0xD1; // window off
            p.vram[0..16].fill(0x80); // tile 0: its first column dark
            (p.wx, p.wy_latch, p.window_line_counter) = (95, true, drew);
        };
        let dark = |drew: u8| -> Vec<usize> {
            shades(&run_line10(setup(drew), |_, _| {}), 10).iter().enumerate().filter(|(_, &v)| v == 3).map(|(x, _)| x).collect()
        };
        let shifted: Vec<usize> = (0..11).map(|k| 8 * k).chain((11..20).map(|k| 8 * k + 1)).collect();
        assert_eq!(dark(3), shifted, "x = 88 colour 0, the BG one pixel right from there");
        assert_eq!(dark(0), (0..20).map(|k| 8 * k).collect::<Vec<_>>(), "the window never drew");
        assert_eq!(line_timing(setup(3)).0, 80 + 172, "mode 3 as long as without the pixel");
    }

    /// DMG, WX 2-6: LCDC.5 turned off during the window's first tile leaves that tile with its
    /// 7 - WX pixels dropped, WX + 1 window pixels, and no second tile (Mealybug
    /// `m3_lcdc_win_en_change_multiple_wx`, lines 2-6). Returns the window widths seen for
    /// writes swept across the line start.
    #[test]
    fn wx_0_6_window_off_in_first_tile() {
        for wx in 2..=6u8 {
            let widths: Vec<usize> = (0..40).map(|dot| {
                let s = shades(&run_line10(|p| { window_setup(p); p.wx = wx; }, |p, d| if d == dot { p.write_register(0xFF40, 0xD1) }), 10);
                s.iter().take_while(|&&v| v == 3).count()
            }).collect();
            assert!(widths.contains(&(wx as usize + 1)), "WX {wx}: {widths:?}");
            assert!(!widths.contains(&8), "WX {wx}: never a whole first tile: {widths:?}");
        }
    }

    /// Pan Docs' "Mode 3 length" of the current line with the registers as they are: 172, plus the
    /// SCX fine-scroll discard, plus 6 when the window shows on the line, plus each OBJ's fetch: 6
    /// dots, and for the first OBJ (left to right) on a BG/window tile, 5 minus the OBJ's offset in
    /// that tile (≥ 0). OBJs at OAM X 0 share a tile of their own: the first costs 11 whatever SCX.
    /// WX 0 with a fine scroll costs one dot more. The pixel FIFO must add up to it.
    fn pan_docs_len(p: &Ppu) -> u32 {
        let fine = (p.scx % 8) as i32;
        // A DMG never matches WX 166 in mode 3 (Age stat-mode-window).
        let window = p.lcdc & 0x20 != 0 && (p.wy_latch || p.ly == p.wy)
            && p.wx <= if p.cgb_mode || p.compat { 166 } else { 165 };
        let mut len = 172 + fine as u32 + if window { 6 } else { 0 };
        if window && p.wx == 0 && fine > 0 { len += 1; }
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

    /// LCDC.1 turned off for 8 dots, swept across the fetch of an OBJ at X 16, with a BGP write at
    /// a fixed dot showing how far the pixels are. Returns, per write dot: whether the OBJ shows and
    /// the x the new BGP starts at.
    fn obj_en_pulse(cgb: bool) -> Vec<(u32, bool, usize)> {
        (8..48).map(|dot| {
            let p = run_line10(|p| {
                (p.cgb_mode, p.lcdc) = (cgb, 0x93);
                p.oam[0..4].copy_from_slice(&[26, 16, 1, 0]); // row 0 on line 10, x 8-15
                p.vram[16..18].fill(0xFF); // tile 1, row 0: colour 3
                for (c, rgb) in [0x7FFFu16, 0x001F, 0x03E0, 0x7C00].iter().enumerate() {
                    p.bg_cram[c * 2..c * 2 + 2].copy_from_slice(&rgb.to_le_bytes());
                    p.obj_cram[c * 2..c * 2 + 2].copy_from_slice(&rgb.to_le_bytes());
                }
            }, |p, d| match d {
                _ if d == dot => p.write_register(0xFF40, 0x91),
                _ if d == dot + 8 => p.write_register(0xFF40, 0x93),
                116 => { p.write_register(0xFF47, 0xFF); p.bg_cram[0..2].copy_from_slice(&0x001Fu16.to_le_bytes()); }
                _ => {}
            });
            let row: Vec<[u8; 3]> = p.framebuffer[10 * SCREEN_WIDTH * 4..11 * SCREEN_WIDTH * 4].chunks(4).map(|c| [c[0], c[1], c[2]]).collect();
            let white = [row[0][0], row[0][1], row[0][2]];
            let obj = row[8] != white;
            (dot, obj, (16..160).find(|&x| row[x] != white).unwrap())
        }).collect()
    }

    /// DMG: OBJs turned off while an OBJ is being fetched stop the fetch (the OBJ is not drawn) and
    /// the pixels resume at once, one dot further ahead than the write for the fetch dot already
    /// begun. A CGB fetches the OBJ anyway (Mealybug `m3_lcdc_obj_en_change_variant`, SameBoy).
    #[test]
    fn dmg_obj_disable_aborts_obj_fetch() {
        // Fetched: the new BGP from x 90 (11 dots of OBJ penalty); OBJs off at the match: from 101.
        let dmg = obj_en_pulse(false);
        let aborted: Vec<usize> = dmg.iter().filter(|r| (23..=32).contains(&r.0)).map(|r| r.2).collect();
        // Off while the OBJ waits for the tile (5 dots), then during its fetch (6): each dot later
        // saves one dot less, and the fetch gives back the dot it had begun.
        assert_eq!(aborted, [100, 99, 98, 97, 96, 96, 95, 94, 93, 92], "{dmg:?}");
        assert!(dmg.iter().all(|r| (23..=32).contains(&r.0) != (r.2 == 90 || r.2 == 101)), "{dmg:?}");
        let cgb = obj_en_pulse(true);
        assert!(cgb.iter().all(|r| r.2 == 90 || r.2 == 101), "a CGB never stops an OBJ fetch: {cgb:?}");
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
        for (cgb, first) in [(false, 32), (true, 29)] {
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

    /// CGB: LCDC.4 set on the dot a tile data read lands on gives that read the high byte of the
    /// last OBJ row fetched ($A5 here: colours 1,0,1,0,0,1,0,1 as a low byte). The BG tile is blank
    /// at $8800 and at $8000; the OBJ (X 8, tile 1) is fetched before the first pixel.
    #[test]
    fn cgb_tile_sel_set_takes_last_obj_row() {
        let patterns = |cgb: bool, obj: bool| -> Vec<Vec<u8>> {
            (16..80).map(|dot| {
                let p = run_line10(|p| {
                    (p.cgb_mode, p.lcdc) = (cgb, 0x83);
                    if obj { p.oam[0..4].copy_from_slice(&[10 + 16, 8, 1, 0]); }
                    p.vram[0x11] = 0xA5; // tile 1, row 0: high byte
                    for (c, rgb) in [0x7FFFu16, 0x001F, 0x03E0, 0x7C00].iter().enumerate() {
                        p.bg_cram[c * 2..c * 2 + 2].copy_from_slice(&rgb.to_le_bytes());
                    }
                }, |p, d| if d == dot { p.write_register(0xFF40, 0x93) });
                let ids: Vec<u8> = if cgb {
                    let row = &p.framebuffer[10 * SCREEN_WIDTH * 4..11 * SCREEN_WIDTH * 4];
                    row.chunks(4).map(|c| [[255, 255, 255], [255, 0, 0], [0, 255, 0], [0, 0, 255]].iter().position(|k| k[..] == c[..3]).unwrap_or(9) as u8).collect()
                } else {
                    shades(&p, 10)
                };
                ids[8..].chunks(8).find(|t| t.iter().any(|&c| c != 0)).map_or(vec![], |t| t.to_vec())
            }).collect()
        };
        let obj_row = vec![1, 0, 1, 0, 0, 1, 0, 1];
        assert!(patterns(true, true).contains(&obj_row), "{:?}", patterns(true, true));
        assert!(!patterns(true, false).contains(&obj_row), "no OBJ fetched: the tile number rule");
        assert!(!patterns(false, true).contains(&obj_row), "a DMG reads plainly");
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
