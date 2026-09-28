//! Helpers shared by the screenshot tests (acid2.rs, conformance.rs).

use std::path::Path;

use gb_core::ppu::PALETTE_COLORS;

/// A PNG as RGB pixels (greyscale expanded), row by row.
pub fn load_png_rgb(path: &Path) -> Vec<[u8; 3]> {
    let file = std::fs::File::open(path).unwrap_or_else(|e| panic!("open {}: {e}", path.display()));
    let mut decoder = png::Decoder::new(std::io::BufReader::new(file));
    decoder.set_transformations(png::Transformations::normalize_to_color8());
    let mut reader = decoder.read_info().unwrap();
    let mut buf = vec![0; reader.output_buffer_size().expect("reference fits in memory")];
    let info = reader.next_frame(&mut buf).unwrap();
    let px = |p: &[u8]| -> [u8; 3] {
        match info.color_type {
            png::ColorType::Grayscale | png::ColorType::GrayscaleAlpha => [p[0]; 3],
            _ => [p[0], p[1], p[2]],
        }
    };
    let step = info.color_type.samples();
    buf[..info.buffer_size()].chunks(step).map(px).collect()
}

/// DMG shades (the core's green palette) mapped to the reference greys; unknown colours map to red.
pub fn dmg_to_grey(p: &[u8]) -> [u8; 3] {
    const GREYS: [u8; 4] = [0xFF, 0xAA, 0x55, 0x00];
    match PALETTE_COLORS.iter().position(|c| c[..3] == p[..3]) {
        Some(i) => [GREYS[i]; 3],
        None => [0xFF, 0, 0],
    }
}

/// The core expands RGB555 with x*255/31; recover the 5-bit value and use the standard
/// (x<<3)|(x>>2) expansion the reference images are made with.
pub fn cgb_to_rgb(p: &[u8]) -> [u8; 3] {
    let expand = |v: u8| {
        let x = ((v as u16 * 31 + 127) / 255) as u8;
        (x << 3) | (x >> 2)
    };
    [expand(p[0]), expand(p[1]), expand(p[2])]
}
