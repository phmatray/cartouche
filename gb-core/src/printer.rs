//! Game Boy Printer on the serial port (the console clocks every byte; the printer answers).
//!
//! A packet is `88 33 | command | compression | length (u16 LE) | data | checksum (u16 LE) | 00 00`.
//! The checksum is the 16-bit sum of the command, compression, length and data bytes as sent. The
//! printer answers 0x00 to every byte except the last two: 0x81 (it is there) and its status byte:
//! the status from *before* the command ran (Pan Docs: DATA answers 00, PRINT 08), except STATUS
//! ($0F), which answers the live one, and a checksum error, reported on the packet that had it.
//! Commands: 1 INIT, 2 PRINT (sheets, margins, palette, exposure), 4 DATA (up to 0x280 bytes: two
//! rows of 20 tiles, RLE-compressed when compression is 1), 8 BREAK, 0x0F STATUS.
//! Outside a packet it answers 0xFF, like an unplugged cable, so games that probe the link for a
//! second console never mistake it for one.

use std::collections::VecDeque;

pub const WIDTH: usize = 160;
const BUFFER_MAX: usize = 0x2000;
/// A packet left unfinished this long (100 ms, in M-cycles) is dropped: the next byte starts over.
const PACKET_TIMEOUT: u32 = 104_858;
/// Printing time per pixel row, in CPU M-cycles (about 8 ms: a 144-row picture takes ~1.2 s).
const ROW_CYCLES: u32 = 8_400;

pub const STATUS_CHECKSUM: u8 = 0x01;
pub const STATUS_BUSY: u8 = 0x02;
pub const STATUS_FULL: u8 = 0x04;
pub const STATUS_UNPROCESSED: u8 = 0x08;

#[derive(Default)]
pub struct Printer {
    /// Bytes of the current packet received so far (0 = waiting for 0x88).
    pos: usize,
    command: u8,
    compressed: bool,
    len: usize,
    data: Vec<u8>,
    sum: u16,
    checksum: u16,
    status: u8,
    /// Decompressed tile data waiting for a PRINT.
    buffer: Vec<u8>,
    busy: u32,
    /// The status byte this packet answers with (fixed once its checksum is in).
    reply: u8,
    /// M-cycles since the last byte, while a packet is part-way.
    quiet: u32,
    /// Finished prints: `[margins, exposure, shade, shade, ...]`, 160 shades (0 white - 3 black) per row.
    /// A feed with nothing to print (empty buffer, or 0 sheets) is a job with no rows.
    pub jobs: VecDeque<Vec<u8>>,
}

impl Printer {
    pub fn new() -> Self {
        Self::default()
    }

    pub fn status(&self) -> u8 {
        self.status
    }

    /// One byte clocked by the console; returns the byte the printer shifts back.
    pub fn exchange(&mut self, byte: u8) -> u8 {
        let p = self.pos;
        self.pos += 1;
        self.quiet = 0;
        let body = 6 + self.len; // magic + header + data
        match p {
            0 => return if byte == 0x88 { 0x00 } else { self.pos = 0; 0xFF },
            1 => if byte != 0x33 { self.pos = 0; },
            2 => { self.command = byte; self.sum = byte as u16; self.data.clear(); }
            3 => { self.compressed = byte & 1 != 0; self.add(byte); }
            4 => { self.len = byte as usize; self.add(byte); }
            5 => { self.len |= (byte as usize) << 8; self.add(byte); }
            _ if p < body => { self.data.push(byte); self.add(byte); }
            _ if p == body => self.checksum = byte as u16,
            _ if p == body + 1 => {
                self.checksum |= (byte as u16) << 8;
                let before = self.status;
                self.run();
                self.reply = if self.command == 0x0F { self.status } else { before & !STATUS_CHECKSUM | self.status & STATUS_CHECKSUM };
            }
            _ if p == body + 2 => return 0x81,
            _ => {
                self.pos = 0;
                let s = self.reply;
                // A finished print reports "done" once, then the printer is idle again.
                if s & (STATUS_BUSY | STATUS_FULL) == STATUS_FULL && self.status & STATUS_BUSY == 0 { self.status &= !STATUS_FULL; }
                return s;
            }
        }
        0x00
    }

    fn add(&mut self, byte: u8) {
        self.sum = self.sum.wrapping_add(byte as u16);
    }

    fn run(&mut self) {
        if self.sum != self.checksum {
            self.status |= STATUS_CHECKSUM;
            return;
        }
        self.status &= !STATUS_CHECKSUM;
        match self.command {
            0x01 => { self.buffer.clear(); self.status = 0; }
            0x02 if self.data.len() >= 4 && self.status & STATUS_BUSY == 0 => {
                let [sheets, margins, palette, exposure] = [self.data[0], self.data[1], self.data[2], self.data[3]];
                // 0 sheets: a paper feed only (Pan Docs).
                let rows = if sheets == 0 { 0 } else { self.buffer.len() / (WIDTH / 8 * 16) * 8 };
                let mut job = vec![margins, exposure];
                if rows > 0 {
                    job.extend(decode(&self.buffer, palette));
                    self.busy = rows as u32 * ROW_CYCLES;
                    self.status = STATUS_BUSY | STATUS_FULL;
                }
                self.jobs.push_back(job);
                self.buffer.clear();
            }
            0x04 => {
                let data = if self.compressed { decompress(&self.data) } else { std::mem::take(&mut self.data) };
                let room = BUFFER_MAX - self.buffer.len();
                self.buffer.extend_from_slice(&data[..data.len().min(room)]);
                if !self.buffer.is_empty() { self.status |= STATUS_UNPROCESSED; }
            }
            0x08 => { self.buffer.clear(); self.status = 0; self.busy = 0; }
            _ => {}
        }
    }

    /// Advances printing; `m_cycles` of CPU time.
    pub fn tick(&mut self, m_cycles: u32) {
        if self.pos > 0 {
            self.quiet += m_cycles;
            if self.quiet >= PACKET_TIMEOUT { self.pos = 0; }
        }
        if self.busy == 0 { return; }
        self.busy = self.busy.saturating_sub(m_cycles);
        if self.busy == 0 { self.status &= !STATUS_BUSY; }
    }
}

/// RLE as the printer takes it: a control byte `c` with bit 7 set repeats the next byte
/// `(c & 0x7F) + 2` times; otherwise the next `c + 1` bytes are copied as they are.
pub fn decompress(src: &[u8]) -> Vec<u8> {
    let mut out = Vec::with_capacity(0x280);
    let mut i = 0;
    while i < src.len() {
        let c = src[i];
        i += 1;
        if c & 0x80 != 0 {
            let Some(&b) = src.get(i) else { break };
            out.extend(std::iter::repeat(b).take((c & 0x7F) as usize + 2));
            i += 1;
        } else {
            let end = (i + c as usize + 1).min(src.len());
            out.extend_from_slice(&src[i..end]);
            i = end;
        }
    }
    out
}

/// Tile rows of 20 tiles (2bpp) to one shade (0 white - 3 black) per pixel through `palette`
/// (a BGP-style byte; 0 means the default 0xE4).
pub fn decode(tiles: &[u8], palette: u8) -> Vec<u8> {
    let palette = if palette == 0 { 0xE4 } else { palette };
    let tile_rows = tiles.len() / (WIDTH / 8 * 16);
    let mut out = vec![0u8; tile_rows * 8 * WIDTH];
    for (t, tile) in tiles.chunks_exact(16).take(tile_rows * 20).enumerate() {
        let (tx, ty) = (t % 20, t / 20);
        for y in 0..8 {
            let (lo, hi) = (tile[y * 2], tile[y * 2 + 1]);
            for x in 0..8 {
                let c = (lo >> (7 - x) & 1) | (hi >> (7 - x) & 1) << 1;
                out[(ty * 8 + y) * WIDTH + tx * 8 + x] = palette >> (c * 2) & 3;
            }
        }
    }
    out
}

#[cfg(test)]
mod tests {
    use super::*;

    /// A well-formed packet, with the two trailing bytes; returns what the printer answered.
    fn send(p: &mut Printer, command: u8, compressed: bool, data: &[u8]) -> Vec<u8> {
        packet(p, command, compressed, data, None)
    }

    fn packet(p: &mut Printer, command: u8, compressed: bool, data: &[u8], bad_sum: Option<u16>) -> Vec<u8> {
        let len = (data.len() as u16).to_le_bytes();
        let mut bytes = vec![0x88, 0x33, command, compressed as u8, len[0], len[1]];
        bytes.extend_from_slice(data);
        let sum = bytes[2..].iter().fold(0u16, |s, &b| s.wrapping_add(b as u16));
        bytes.extend_from_slice(&bad_sum.unwrap_or(sum).to_le_bytes());
        bytes.extend_from_slice(&[0, 0]);
        bytes.into_iter().map(|b| p.exchange(b)).collect()
    }

    #[test]
    fn answers_alive_and_status_at_the_end_of_a_packet() {
        let mut p = Printer::new();
        let r = send(&mut p, 0x01, false, &[]);
        assert!(r[..r.len() - 2].iter().all(|&b| b == 0));
        assert_eq!(&r[r.len() - 2..], &[0x81, 0x00]);
    }

    #[test]
    fn idle_bytes_look_like_an_unplugged_cable() {
        let mut p = Printer::new();
        assert_eq!(p.exchange(0x00), 0xFF);
        assert_eq!(p.exchange(0x12), 0xFF);
        assert_eq!(p.exchange(0x88), 0x00);
        assert_eq!(p.exchange(0x00), 0x00, "no magic: back to idle");
        assert_eq!(p.exchange(0x00), 0xFF);
    }

    #[test]
    fn bad_checksum_sets_the_status_bit_and_drops_the_command() {
        let mut p = Printer::new();
        let r = packet(&mut p, 0x04, false, &[1, 2, 3], Some(0x1234));
        assert_eq!(*r.last().unwrap() & STATUS_CHECKSUM, STATUS_CHECKSUM);
        assert!(p.buffer.is_empty());
        let r = send(&mut p, 0x0F, false, &[]);
        assert_eq!(*r.last().unwrap() & STATUS_CHECKSUM, 0, "cleared by the next good packet");
    }

    #[test]
    fn rle_decompression() {
        // 3 literal bytes, then 0xAA x 5, then one literal.
        let src = [0x02, 1, 2, 3, 0x83, 0xAA, 0x00, 9];
        assert_eq!(decompress(&src), vec![1, 2, 3, 0xAA, 0xAA, 0xAA, 0xAA, 0xAA, 9]);
    }

    #[test]
    fn print_job_decodes_tiles_with_the_palette_and_reports_busy_then_done() {
        let mut p = Printer::new();
        send(&mut p, 0x01, false, &[]);
        // One band (40 tiles): every tile row 0 is colour 3, the others colour 1.
        let mut band = Vec::new();
        for _ in 0..40 { band.extend_from_slice(&[0xFF, 0xFF]); band.extend_from_slice(&[0xFF, 0x00].repeat(7)); }
        // Sent compressed: each tile is literal 2 bytes, then a run of 14 alternating... keep it
        // simple: a run of 0xFF x 2 then 7 literal pairs.
        let mut rle = Vec::new();
        for _ in 0..40 { rle.extend_from_slice(&[0x80, 0xFF, 13]); rle.extend_from_slice(&[0xFF, 0x00].repeat(7)); }
        assert_eq!(decompress(&rle), band);
        // Each packet answers the status from before it ran (Pan Docs: DATA 00, then 08, PRINT 08).
        let r = send(&mut p, 0x04, true, &rle);
        assert_eq!(*r.last().unwrap(), 0);
        assert_eq!(*send(&mut p, 0x04, false, &[]).last().unwrap(), STATUS_UNPROCESSED); // end of data
        assert_eq!(*send(&mut p, 0x0F, false, &[]).last().unwrap(), STATUS_UNPROCESSED);
        let r = send(&mut p, 0x02, false, &[1, 0x13, 0xE4, 0x40]);
        assert_eq!(*r.last().unwrap(), STATUS_UNPROCESSED);
        assert_eq!(*send(&mut p, 0x0F, false, &[]).last().unwrap(), STATUS_BUSY | STATUS_FULL);

        let job = p.jobs.pop_front().expect("a print");
        assert_eq!(&job[..2], &[0x13, 0x40]);
        let px = &job[2..];
        assert_eq!(px.len(), WIDTH * 16);
        assert_eq!(px[0], 3);
        assert_eq!(px[WIDTH], 1);
        assert_eq!(px[8 * WIDTH + 159], 3);

        p.tick(16 * ROW_CYCLES - 1);
        assert_eq!(*send(&mut p, 0x0F, false, &[]).last().unwrap(), STATUS_BUSY | STATUS_FULL);
        p.tick(1);
        assert_eq!(*send(&mut p, 0x0F, false, &[]).last().unwrap(), STATUS_FULL, "done, reported once");
        assert_eq!(*send(&mut p, 0x0F, false, &[]).last().unwrap(), 0);
    }

    #[test]
    fn a_feed_without_data_or_with_zero_sheets_is_a_job_with_no_rows() {
        let mut p = Printer::new();
        send(&mut p, 0x01, false, &[]);
        send(&mut p, 0x02, false, &[1, 0x03, 0xE4, 0x40]); // empty buffer
        send(&mut p, 0x04, false, &[0; 0x280]);
        send(&mut p, 0x02, false, &[0, 0x10, 0xE4, 0x40]); // 0 sheets
        assert_eq!(p.jobs.pop_front().unwrap(), vec![0x03, 0x40]);
        assert_eq!(p.jobs.pop_front().unwrap(), vec![0x10, 0x40]);
        assert_eq!(*send(&mut p, 0x0F, false, &[]).last().unwrap() & STATUS_BUSY, 0, "nothing printed");
    }

    #[test]
    fn an_abandoned_packet_times_out_after_100_ms() {
        let mut p = Printer::new();
        for b in [0x88, 0x33, 0x04, 0x00, 0x80, 0x02, 1, 2] { p.exchange(b); } // DATA, cut off
        p.tick(PACKET_TIMEOUT);
        let r = send(&mut p, 0x0F, false, &[]);
        assert_eq!(&r[r.len() - 2..], &[0x81, 0x00], "the next packet is heard as a packet");
    }

    #[test]
    fn palette_remaps_shades_and_zero_means_default() {
        let tile_row: Vec<u8> = [0x00, 0x00].repeat(8 * 20); // colour 0 everywhere
        assert!(decode(&tile_row, 0x00).iter().all(|&s| s == 0));
        assert!(decode(&tile_row, 0x03).iter().all(|&s| s == 3), "colour 0 printed black");
    }
}
