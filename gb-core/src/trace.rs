//! Per-frame PPU trace: what was drawn, layer by layer, and the exact motion between two frames.
//!
//! Off by default (`Ppu::set_tracing`); normal play pays one `is_some()` test per scanline and
//! per opaque sprite pixel. When on, every rendered scanline records the registers it used and
//! the BG, window and OBJ planes, and VBlank entry closes the frame (VRAM/OAM/palette snapshot).
//!
//! Buffers of a finished frame (`Tracer::done`), all row-major 160x144:
//! - `final_`: RGBA, the picture exactly as shown (copied at VBlank, so never torn).
//! - `bg`: RGBA, the background plane over the whole line, even where the window or OBJs cover it.
//! - `win`: RGBA, the window plane; alpha 0 where the window does not cover the pixel.
//! - `obj`: RGBA, the frontmost opaque OBJ pixel (the one that claims the dot, even when it then
//!   loses to the BG); alpha 0 where no OBJ is opaque.
//! - `info`: 4 bytes per pixel: `[layer, slot, ids, attr]`
//!   - layer: where the shown pixel came from, `LAYER_BG` / `LAYER_WIN` / `LAYER_OBJ`
//!   - slot: OAM index (0..40) of the claiming OBJ, `NO_OBJ` when none
//!   - ids: bits 0-1 BG/window colour id, bit 2 CGB BG-to-OBJ tile priority, bits 4-5 OBJ colour id
//!   - attr: OAM attribute byte of the claiming OBJ
//! - `meta`: `META_LEN` bytes. Header (`HEADER_LEN`): "CTRC", version, cgb, rendered line count,
//!   0, frame number (u32 LE). Then one `LINE_LEN` record per scanline (see [`line`]), then the
//!   VBlank snapshot: OAM (160), BG CRAM (64), OBJ CRAM (64), VRAM (16 KiB: bank 0 then bank 1;
//!   tiles at 0x0000-0x17FF, maps at 0x1800/0x1C00, CGB map attributes at the same offsets in bank 1).
//!   The BG/window map base and tile-data mode of each line come from its LCDC bits 3, 6 and 4.

use crate::ppu::{FRAMEBUFFER_SIZE, SCREEN_HEIGHT as H, SCREEN_WIDTH as W};

pub const PIXELS: usize = W * H;
pub const HEADER_LEN: usize = 32;
pub const LINE_LEN: usize = 64;
pub const LINES_OFF: usize = HEADER_LEN;
pub const OAM_OFF: usize = LINES_OFF + H * LINE_LEN;
pub const BG_CRAM_OFF: usize = OAM_OFF + 0xA0;
pub const OBJ_CRAM_OFF: usize = BG_CRAM_OFF + 64;
pub const VRAM_OFF: usize = OBJ_CRAM_OFF + 64;
pub const META_LEN: usize = VRAM_OFF + 0x4000;
pub const VERSION: u8 = 1;

pub const LAYER_BG: u8 = 0;
pub const LAYER_WIN: u8 = 1;
pub const LAYER_OBJ: u8 = 2;
pub const NO_OBJ: u8 = 0xFF;
/// Motion component of a pixel whose source in the previous frame is unknown.
pub const MV_UNKNOWN: i8 = i8::MIN;

/// Motion field modes: the shown pixel, or one plane at every pixel.
pub const MV_FINAL: u8 = 0;
pub const MV_BG: u8 = 1;
pub const MV_WIN: u8 = 2;
pub const MV_OBJ: u8 = 3;

/// Offsets inside a scanline record.
pub mod line {
    pub const LCDC: usize = 0;
    pub const SCX: usize = 1;
    pub const SCY: usize = 2;
    pub const WX: usize = 3;
    pub const WY: usize = 4;
    /// Window line drawn here (the internal window line counter), 0xFF when no window pixel.
    pub const WIN_LINE: usize = 5;
    /// First screen x of the window, max(WX - 7, 0).
    pub const WIN_X: usize = 6;
    pub const BGP: usize = 7;
    pub const OBP0: usize = 8;
    pub const OBP1: usize = 9;
    /// bit 0 rendered, bit 1 CGB, bit 2 CPU-selected VRAM bank.
    pub const FLAGS: usize = 10;
    /// Number of OBJs selected on this line (0..=10), followed by that many
    /// 5-byte records `[slot, y, x, tile, attr]` in OAM order (raw OAM values).
    pub const NSPR: usize = 11;
    pub const SPRITES: usize = 12;
}
pub const LINE_RENDERED: u8 = 1;
pub const LINE_CGB: u8 = 2;

pub struct FrameTrace {
    pub meta: Vec<u8>,
    pub final_: Vec<u8>,
    pub bg: Vec<u8>,
    pub win: Vec<u8>,
    pub obj: Vec<u8>,
    pub info: Vec<u8>,
}

impl Default for FrameTrace {
    fn default() -> Self {
        Self {
            meta: vec![0; META_LEN],
            final_: vec![0; FRAMEBUFFER_SIZE],
            bg: vec![0; FRAMEBUFFER_SIZE],
            win: vec![0; FRAMEBUFFER_SIZE],
            obj: vec![0; FRAMEBUFFER_SIZE],
            info: vec![0; PIXELS * 4],
        }
    }
}

impl FrameTrace {
    pub fn line(&self, y: usize) -> &[u8] {
        &self.meta[LINES_OFF + y * LINE_LEN..LINES_OFF + (y + 1) * LINE_LEN]
    }

    pub fn line_mut(&mut self, y: usize) -> &mut [u8] {
        &mut self.meta[LINES_OFF + y * LINE_LEN..LINES_OFF + (y + 1) * LINE_LEN]
    }

    pub fn frame(&self) -> u32 {
        u32::from_le_bytes(self.meta[8..12].try_into().unwrap())
    }

    pub fn is_cgb(&self) -> bool {
        self.meta[5] != 0
    }

    pub fn rendered(&self, y: usize) -> bool {
        self.line(y)[line::FLAGS] & LINE_RENDERED != 0
    }

    /// `[slot, y, x, tile, attr]` of the OBJs selected on line `y`.
    pub fn sprites(&self, y: usize) -> impl Iterator<Item = &[u8]> {
        let l = self.line(y);
        l[line::SPRITES..line::SPRITES + 5 * l[line::NSPR] as usize].chunks(5)
    }

    /// Rebuilds the picture from the planes and the priority rules alone (window over BG,
    /// OBJ over both unless the OBJ or CGB tile priority says otherwise), and returns
    /// `(rgba, winning layer per pixel)`. On rendered lines it must equal `final_` / `info[0]`.
    pub fn composite(&self) -> (Vec<u8>, Vec<u8>) {
        let mut out = self.final_.clone();
        let mut layers = vec![LAYER_BG; PIXELS];
        let cgb = self.is_cgb();
        for y in (0..H).filter(|&y| self.rendered(y)) {
            let bg_on = self.line(y)[line::LCDC] & 0x01 != 0;
            for x in 0..W {
                let i = y * W + x;
                let p = i * 4;
                let (mut src, mut layer) = if self.win[p + 3] != 0 { (&self.win, LAYER_WIN) } else { (&self.bg, LAYER_BG) };
                let [_, slot, ids, attr] = self.info[p..p + 4] else { unreachable!() };
                if slot != NO_OBJ {
                    let under_opaque = ids & 0x03 != 0;
                    let behind = attr & 0x80 != 0;
                    let obj_wins = if cgb {
                        !bg_on || !under_opaque || (ids & 0x04 == 0 && !behind)
                    } else {
                        !under_opaque || !behind
                    };
                    if obj_wins {
                        (src, layer) = (&self.obj, LAYER_OBJ);
                    }
                }
                out[p..p + 4].copy_from_slice(&src[p..p + 4]);
                layers[i] = layer;
            }
        }
        (out, layers)
    }
}

/// Keeps the frame being drawn, the last finished one and the one before it (for motion).
#[derive(Default)]
pub struct Tracer {
    pub building: FrameTrace,
    pub done: FrameTrace,
    pub prev: FrameTrace,
    /// Frames finished since tracing started (the frame number of `done`).
    pub frames: u32,
    /// Last motion field, `(dx, dy)` per pixel: the pixel was at `(x + dx, y + dy)` in `prev`.
    pub motion: Vec<i8>,
}

impl Tracer {
    /// VBlank entry: snapshot the frame-level state, publish `building` as `done`.
    pub(crate) fn finish_frame(&mut self, fb: &[u8], oam: &[u8], bg_cram: &[u8], obj_cram: &[u8], vram: &[u8], cgb: bool) {
        self.frames = self.frames.wrapping_add(1);
        let b = &mut self.building;
        b.final_.copy_from_slice(fb);
        let rendered = (0..H).filter(|&y| b.rendered(y)).count() as u8;
        let m = &mut b.meta;
        m[..HEADER_LEN].fill(0);
        m[..4].copy_from_slice(b"CTRC");
        m[4] = VERSION;
        m[5] = cgb as u8;
        m[6] = rendered;
        m[8..12].copy_from_slice(&self.frames.to_le_bytes());
        m[OAM_OFF..BG_CRAM_OFF].copy_from_slice(oam);
        m[BG_CRAM_OFF..OBJ_CRAM_OFF].copy_from_slice(bg_cram);
        m[OBJ_CRAM_OFF..VRAM_OFF].copy_from_slice(obj_cram);
        m[VRAM_OFF..META_LEN].copy_from_slice(vram);
        std::mem::swap(&mut self.prev, &mut self.done);
        std::mem::swap(&mut self.done, &mut self.building);
        for y in 0..H {
            self.building.line_mut(y)[line::FLAGS] = 0;
        }
    }

    /// Fills `self.motion` for `done` against `prev`; see [`motion_field`].
    pub fn compute_motion(&mut self, mode: u8) {
        self.motion.resize(PIXELS * 2, 0);
        motion_field(&self.prev, &self.done, mode, &mut self.motion);
    }
}

/// Nearest line of `prev` (to `y`) satisfying `pred`.
fn nearest_line(prev: &FrameTrace, y: usize, pred: impl Fn(usize, &[u8]) -> bool) -> Option<usize> {
    (0..H)
        .filter(|&py| prev.rendered(py) && pred(py, prev.line(py)))
        .min_by_key(|&py| py.abs_diff(y))
}

fn clamp_i8(v: i32) -> Option<i8> {
    i8::try_from(v).ok().filter(|&v| v != MV_UNKNOWN)
}

/// Exact motion from the emulator state, `(dx, dy)` per pixel into `out` (len `2 * PIXELS`):
/// the content at `(x, y)` in `cur` was at `(x + dx, y + dy)` in `prev`, or `MV_UNKNOWN`.
/// - BG: the line of `prev` (same BG map) that showed the same BG row `SCY + y`, nearest to `y`;
///   `dx` = SCX(cur) - SCX(prev), wrapped to -128..127. Exact under per-line raster scrolling.
///   A row that scrolled in from off screen gets this line's ΔSCY/ΔSCX (pointing off screen).
/// - Window: the line of `prev` (same window map) that drew the same window line; `dx` = ΔWX.
/// - OBJ: the same OAM slot showing the same tile in `prev` (8x16 pairs compare tile & 0xFE);
///   failing that, the closest OBJ with the same tile and attributes (games re-shuffle slots).
///
/// `mode` picks the shown pixel's layer (`MV_FINAL`) or one plane at every pixel.
pub fn motion_field(prev: &FrameTrace, cur: &FrameTrace, mode: u8, out: &mut [i8]) {
    out.fill(MV_UNKNOWN);
    // Every OBJ seen in prev, once: (slot, y, x, tile, attr).
    let mut prev_objs: Vec<[u8; 5]> = Vec::new();
    for y in (0..H).filter(|&y| prev.rendered(y)) {
        let tall = prev.line(y)[line::LCDC] & 0x04 != 0;
        for s in prev.sprites(y) {
            let mut s: [u8; 5] = s.try_into().unwrap();
            if tall { s[3] &= 0xFE; }
            if !prev_objs.contains(&s) { prev_objs.push(s); }
        }
    }
    for y in (0..H).filter(|&y| cur.rendered(y)) {
        let l = cur.line(y);
        let bg_row = l[line::SCY].wrapping_add(y as u8);
        let same_bg_map = |p: &[u8]| (p[line::LCDC] ^ l[line::LCDC]) & 0x08 == 0;
        let bg = nearest_line(prev, y, |py, p| same_bg_map(p) && p[line::SCY].wrapping_add(py as u8) == bg_row)
            .map(|py| (py as i32, prev.line(py)))
            // The row was off screen in prev (it scrolled in): extrapolate from this line's scroll.
            .or_else(|| {
                let p = prev.line(y);
                (prev.rendered(y) && same_bg_map(p))
                    .then(|| (y as i32 + l[line::SCY].wrapping_sub(p[line::SCY]) as i8 as i32, p))
            })
            .and_then(|(py, p)| {
                let dx = l[line::SCX].wrapping_sub(p[line::SCX]) as i8;
                Some((dx, clamp_i8(py - y as i32)?)).filter(|&(dx, _)| dx != MV_UNKNOWN)
            });
        let win_line = l[line::WIN_LINE];
        let win = (win_line != 0xFF)
            .then(|| nearest_line(prev, y, |_, p| p[line::WIN_LINE] == win_line && (p[line::LCDC] ^ l[line::LCDC]) & 0x40 == 0))
            .flatten()
            .and_then(|py| {
                let dx = prev.line(py)[line::WIN_X] as i32 - l[line::WIN_X] as i32;
                Some((clamp_i8(dx)?, clamp_i8(py as i32 - y as i32)?))
            });
        let tall = l[line::LCDC] & 0x04 != 0;
        let obj_mv = |slot: u8| -> Option<(i8, i8)> {
            let c = cur.sprites(y).find(|s| s[0] == slot)?;
            let tile = if tall { c[3] & 0xFE } else { c[3] };
            let p = prev_objs.iter().find(|p| p[0] == slot && p[3] == tile).or_else(|| {
                prev_objs
                    .iter()
                    .filter(|p| p[3] == tile && p[4] == c[4])
                    .min_by_key(|p| (p[1] as i32 - c[1] as i32).abs() + (p[2] as i32 - c[2] as i32).abs())
            })?;
            Some((clamp_i8(p[2] as i32 - c[2] as i32)?, clamp_i8(p[1] as i32 - c[1] as i32)?))
        };
        for x in 0..W {
            let i = y * W + x;
            let in_win = cur.win[i * 4 + 3] != 0;
            let [layer, slot, ..] = cur.info[i * 4..i * 4 + 4] else { unreachable!() };
            let mv = match (mode, layer) {
                (MV_BG, _) | (MV_FINAL, LAYER_BG) => bg,
                (MV_WIN, _) | (MV_FINAL, LAYER_WIN) => win.filter(|_| in_win),
                (MV_OBJ, _) | (MV_FINAL, _) => (slot != NO_OBJ).then(|| obj_mv(slot)).flatten(),
                _ => None,
            };
            if let Some((dx, dy)) = mv {
                out[i * 2] = dx;
                out[i * 2 + 1] = dy;
            }
        }
    }
}
