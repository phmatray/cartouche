//! Pocket camera cartridge (type $FC): the capture unit of its mapper and the M64282FP sensor.
//!
//! Follows the community documentation (Pan Docs' camera chapter, AntonioND's research): RAM bank
//! values with bit 4 set map the registers at $A000-$A07F. $A000 bit 0 starts a capture and reads 1
//! while it runs; bits 1-2 pick the 1-D filter; $A001-$A005 are sensor registers (N/VH/gain,
//! exposure, edge ratio/invert, offset); $A006-$A035 are the 4x4 dithering matrix, three thresholds
//! per cell. A finished capture lands in RAM bank 0 at $0100 as 14 x 16 tiles (128 x 112 pixels).
//! The picture itself comes from the host: `set_input` takes a 128 x 112 grayscale frame (0 = black).

pub const WIDTH: usize = 128;
pub const HEIGHT: usize = 112;
pub const REG_COUNT: usize = 0x36;
/// Offset of the picture in cartridge RAM, and its size (14 x 16 tiles of 16 bytes).
pub const PICTURE_AT: usize = 0x100;
pub const PICTURE_LEN: usize = WIDTH * HEIGHT / 4;

const EDGE_RATIO: [f32; 8] = [0.50, 0.75, 1.00, 1.25, 2.00, 3.00, 4.00, 5.00];

pub struct Camera {
    pub regs: [u8; REG_COUNT],
    /// M-cycles left in the running capture (0 = idle).
    busy: u32,
    input: Vec<u8>,
}

impl Camera {
    pub fn new() -> Self {
        Self { regs: [0; REG_COUNT], busy: 0, input: vec![0x80; WIDTH * HEIGHT] }
    }

    pub fn busy(&self) -> bool {
        self.busy > 0
    }

    /// The sensor's view: 128 x 112 luminance bytes, row by row. Other sizes are ignored.
    pub fn set_input(&mut self, frame: &[u8]) {
        if frame.len() == self.input.len() {
            self.input.copy_from_slice(frame);
        }
    }

    /// Only $A000 reads back (its low 3 bits, bit 0 = busy); the other registers read 0.
    pub fn read(&self, reg: usize) -> u8 {
        if reg == 0 { (self.regs[0] & 0x06) | self.busy() as u8 } else { 0 }
    }

    pub fn write(&mut self, reg: usize, value: u8) {
        if reg >= REG_COUNT { return; }
        if reg == 0 {
            self.regs[0] = value & 0x07;
            if value & 1 != 0 && self.busy == 0 {
                // Capture length in M-cycles (Pan Docs): 32446 + (N ? 0 : 512) + 16 x exposure.
                let n = self.regs[1] & 0x80 != 0;
                let exposure = u16::from_be_bytes([self.regs[2], self.regs[3]]) as u32;
                self.busy = 32446 + if n { 0 } else { 512 } + 16 * exposure;
            }
        } else {
            self.regs[reg] = value;
        }
    }

    /// Advances the capture by `m_cycles`; returns the finished picture (tile data) once it completes.
    pub fn tick(&mut self, m_cycles: u32) -> Option<Vec<u8>> {
        if self.busy == 0 { return None; }
        self.busy = self.busy.saturating_sub(m_cycles);
        if self.busy > 0 { return None; }
        self.regs[0] &= !1;
        Some(process(&self.regs, &self.input))
    }
}

/// The sensor and controller pipeline: exposure, invert, edge enhancement / 1-D filter, then the
/// controller's dithering matrix and conversion to 2bpp tiles.
// ponytail: the analogue stages (gain, offset voltage, zero calibration) are not modelled; exposure
// scaling stands in for them, as in the reference implementations. Add them if a game depends on it.
pub fn process(regs: &[u8; REG_COUNT], input: &[u8]) -> Vec<u8> {
    let (w, h) = (WIDTH as i32, HEIGHT as i32);
    let exposure = u16::from_be_bytes([regs[2], regs[3]]) as i32;
    let invert = regs[4] & 0x08 != 0;
    let at = |buf: &[i32], x: i32, y: i32| buf[(y.clamp(0, h - 1) * w + x.clamp(0, w - 1)) as usize];

    // The sensor's output rises from the reference level (128: no light) with light x exposure.
    // Calibrated so the camera ROM's default exposure ($1000, its middle "brightness") spreads a
    // full-range picture across its dithering thresholds ($8C-$E7): black 128, white 240.
    let mut px: Vec<i32> = input.iter().map(|&v| {
        let light = if invert { 255 - v as i32 } else { v as i32 };
        (light * exposure * 112 / (0x1000 * 255)).min(127)
    }).collect();

    let n = regs[1] >> 7 & 1;
    let vh = regs[1] >> 5 & 3;
    let e3 = regs[4] >> 7 & 1;
    let alpha = EDGE_RATIO[(regs[4] >> 4 & 7) as usize];
    let (p_bits, m_bits) = match regs[0] >> 1 & 3 { 0 => (0, 1), 1 => (1, 0), _ => (1, 2) };
    // 1-D filter: each pixel with the one below it, added (P) or subtracted (M).
    let filter_1d = |buf: &[i32]| -> Vec<i32> {
        (0..h).flat_map(|y| (0..w).map(move |x| (x, y))).map(|(x, y)| {
            let (p, s) = (at(buf, x, y), at(buf, x, y + 1));
            let mut v = 0;
            if p_bits & 1 != 0 { v += p; }
            if p_bits & 2 != 0 { v += s; }
            if m_bits & 1 != 0 { v -= p; }
            if m_bits & 2 != 0 { v -= s; }
            v.clamp(-128, 127)
        }).collect()
    };
    let enhance = |buf: &[i32], two_d: bool| -> Vec<i32> {
        (0..h).flat_map(|y| (0..w).map(move |x| (x, y))).map(|(x, y)| {
            let p = at(buf, x, y);
            let edge = if two_d {
                4 * p - at(buf, x - 1, y) - at(buf, x + 1, y) - at(buf, x, y - 1) - at(buf, x, y + 1)
            } else {
                2 * p - at(buf, x - 1, y) - at(buf, x + 1, y)
            };
            (p + (edge as f32 * alpha) as i32).clamp(-128, 127)
        }).collect()
    };
    px = match n << 3 | vh << 1 | e3 {
        0x0 => filter_1d(&px),
        0x2 => filter_1d(&enhance(&px, false)),
        0xE => enhance(&px, true),
        _ => px, // no filtering
    };

    // Controller: 4x4 matrix of three thresholds each, then 2bpp tiles (3 = darkest).
    let mut out = vec![0u8; PICTURE_LEN];
    for y in 0..HEIGHT {
        for x in 0..WIDTH {
            let v = (px[y * WIDTH + x] + 128) as u8;
            let m = 6 + ((y & 3) * 4 + (x & 3)) * 3;
            let level = if v < regs[m] { 0 } else if v < regs[m + 1] { 1 } else if v < regs[m + 2] { 2 } else { 3 };
            let color = 3 - level;
            let tile = (y / 8) * 16 + x / 8;
            let at = tile * 16 + (y & 7) * 2;
            let bit = 0x80 >> (x & 7);
            if color & 1 != 0 { out[at] |= bit; }
            if color & 2 != 0 { out[at + 1] |= bit; }
        }
    }
    out
}

#[cfg(test)]
mod tests {
    use super::*;

    /// A matrix with the same three thresholds in every cell.
    fn regs(t: [u8; 3]) -> [u8; REG_COUNT] {
        let mut r = [0u8; REG_COUNT];
        for c in 0..16 { r[6 + c * 3..9 + c * 3].copy_from_slice(&t); }
        r[0] = 0x02; // P = 1, M = 0: the 1-D filter passes the pixel through
        r[2] = 0x10; // exposure $1000: black 128, white 240
        r
    }

    fn color_at(tiles: &[u8], x: usize, y: usize) -> u8 {
        let at = ((y / 8) * 16 + x / 8) * 16 + (y & 7) * 2;
        let bit = 7 - (x & 7);
        (tiles[at] >> bit & 1) | (tiles[at + 1] >> bit & 1) << 1
    }

    #[test]
    fn capture_sets_busy_for_the_documented_length_then_writes_tiles() {
        let mut cam = Camera::new();
        cam.regs[1] = 0x80; // N = 1: no extra 512 cycles
        cam.regs[2] = 0x00;
        cam.regs[3] = 0x10;
        cam.write(0, 0x03);
        assert_eq!(cam.read(0), 0x03);
        assert_eq!(cam.read(1), 0, "sensor registers read back as 0");
        let total = 32446 + 16 * 0x10;
        assert!(cam.tick(total - 1).is_none());
        assert_eq!(cam.read(0) & 1, 1);
        let pic = cam.tick(1).expect("capture finishes");
        assert_eq!(pic.len(), 0xE00);
        assert_eq!(cam.read(0), 0x02, "busy clears, filter bits stay");
    }

    #[test]
    fn dithering_matrix_quantizes_to_four_levels() {
        let r = regs([0x90, 0xB0, 0xD0]);
        // Light on the left, dark on the right.
        let input: Vec<u8> = (0..WIDTH * HEIGHT).map(|i| if i % WIDTH < 64 { 255 } else { 0 }).collect();
        let tiles = process(&r, &input);
        assert_eq!(color_at(&tiles, 10, 50), 0, "bright pixel is white (colour 0)");
        assert_eq!(color_at(&tiles, 100, 50), 3, "dark pixel is black (colour 3)");
        let mid = process(&r, &vec![0x80; WIDTH * HEIGHT]);
        assert_eq!(color_at(&mid, 3, 3), 1, "mid grey (184) falls between thresholds 2 and 3");
    }

    #[test]
    fn invert_bit_and_exposure_change_the_picture() {
        let mut r = regs([0x90, 0xB0, 0xD0]);
        let white = vec![255u8; WIDTH * HEIGHT];
        assert_eq!(color_at(&process(&r, &white), 0, 0), 0);
        r[4] = 0x08;
        assert_eq!(color_at(&process(&r, &white), 0, 0), 3, "inverted");
        r[4] = 0;
        r[2] = 0; r[3] = 0; // no exposure: no light
        assert_eq!(color_at(&process(&r, &white), 0, 0), 3, "unexposed is black");
    }

    #[test]
    fn edge_enhancement_sharpens_a_step() {
        let mut r = regs([0xA8, 0xB8, 0xC8]);
        r[1] = 0xE0; // N = 1, VH = 3
        r[4] = 0x20; // E3 = 0, ratio 1.0: mode 0xE, 2-D enhancement
        // Darker left half (177 after exposure), lighter right half (191).
        let input: Vec<u8> = (0..WIDTH * HEIGHT).map(|i| if i % WIDTH < 64 { 0x70 } else { 0x90 }).collect();
        let flat = { let mut f = r; f[1] = 0; process(&f, &input) };
        let sharp = process(&r, &input);
        // Away from the edge nothing changes; at the edge the dark side darkens and the light side lightens.
        assert_eq!(color_at(&flat, 10, 40), color_at(&sharp, 10, 40));
        assert_eq!((color_at(&flat, 63, 40), color_at(&sharp, 63, 40)), (2, 3));
        assert_eq!((color_at(&flat, 64, 40), color_at(&sharp, 64, 40)), (1, 0));
    }
}
