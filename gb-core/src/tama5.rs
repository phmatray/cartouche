//! Bandai TAMA5 (cartridge type 0xFD): every access goes through two addresses, A001 (select a
//! register) and A000 (write its low nibble, or read it), as worked out on the gbdev forum's
//! "TAMA5" thread (endrift, skaman): registers 0/1 are the ROM bank, 4/5 the byte to write, 6/7 an
//! address and command that run when 7 is written, C/D the byte read back, A the ready flag.
//! Address 00-1F writes the 32 bytes of RAM, 20-3F reads them.
//!
//! ponytail: the clock (a TC8521 behind the TAMA6 microcontroller) has no public protocol; Cartouche
//! reaches its 13 digit registers with command 8 (write register `7` with the nibble in `4`) and
//! A (read it into C). The alarm and buzzer are not emulated.

use crate::cartridge::now_ms;

/// The `.sav` footer: 13 clock digits as u32 LE, then the unix seconds they were taken at (u64 LE).
pub const FOOTER_LEN: usize = 13 * 4 + 8;

pub struct Tama5 {
    select: u8,
    regs: [u8; 16],
    out: u8,
    /// Wall clock (ms since epoch) at which the clock read 2000-01-01 00:00:00.
    base_ms: f64,
}

const DAY: u64 = 86400;

fn month_days(y: u64, m: u64) -> u64 {
    match m {
        2 if y % 4 == 0 => 29,
        2 => 28,
        4 | 6 | 9 | 11 => 30,
        _ => 31,
    }
}

/// Seconds since 2000-01-01 as the TC8521's digits: seconds, minutes, hours (ones then tens),
/// day of the week (0 = Sunday), day, month, year (ones then tens, 2000-2099).
fn digits(t: u64) -> [u8; 13] {
    let mut days = t / DAY;
    let dow = (days + 6) % 7; // 2000-01-01 was a Saturday
    let mut y = 0;
    while days >= 365 + (y % 4 == 0) as u64 {
        days -= 365 + (y % 4 == 0) as u64;
        y = (y + 1) % 100;
    }
    let mut m = 1;
    while days >= month_days(y, m) {
        days -= month_days(y, m);
        m += 1;
    }
    let (s, mi, h, d) = (t % 60, t / 60 % 60, t / 3600 % 24, days + 1);
    [s % 10, s / 10, mi % 10, mi / 10, h % 10, h / 10, dow, d % 10, d / 10, m % 10, m / 10, y % 10, y / 10].map(|v| v as u8)
}

/// The inverse of `digits`, out-of-range fields clamped; the day of the week is derived, not read.
fn seconds(d: &[u8; 13]) -> u64 {
    let n = |i: usize| (d[i] & 0xF) as u64 + 10 * (d[i + 1] & 0xF) as u64;
    let (y, m) = (n(11).min(99), n(9).clamp(1, 12));
    let day = n(7).clamp(1, month_days(y, m));
    let days = (0..y).map(|y| 365 + (y % 4 == 0) as u64).sum::<u64>() + (1..m).map(|m| month_days(y, m)).sum::<u64>() + day - 1;
    days * DAY + n(4).min(23) * 3600 + n(2).min(59) * 60 + n(0).min(59)
}

impl Tama5 {
    pub fn new() -> Self {
        Tama5 { select: 0, regs: [0; 16], out: 0, base_ms: now_ms() }
    }

    fn now(&self) -> u64 {
        ((now_ms() - self.base_ms) / 1000.0).max(0.0) as u64
    }

    pub fn rom_bank(&self) -> usize {
        (self.regs[0] | (self.regs[1] & 1) << 4) as usize
    }

    /// A write to A000 (odd `offset`: A001).
    pub fn write(&mut self, offset: u16, v: u8, ram: &mut [u8]) {
        if offset & 1 != 0 {
            self.select = v & 0x0F;
            return;
        }
        self.regs[self.select as usize] = v & 0x0F;
        if self.select != 7 { return; }
        let (cmd, lo) = (self.regs[6], self.regs[7]);
        let at = ((cmd & 1) << 4 | lo) as usize;
        match cmd {
            0 | 1 => { if let Some(b) = ram.get_mut(at) { *b = self.regs[4] | self.regs[5] << 4; } }
            2 | 3 => self.out = ram.get(at).copied().unwrap_or(0xFF),
            8 if lo < 13 => {
                let mut d = digits(self.now());
                d[lo as usize] = self.regs[4];
                self.base_ms = now_ms() - seconds(&d) as f64 * 1000.0;
            }
            0xA if lo < 13 => self.out = digits(self.now())[lo as usize],
            _ => {}
        }
    }

    /// A read of A000 (odd `offset`: A001, which reads nothing). The high nibble floats (0xF).
    pub fn read(&self, offset: u16) -> u8 {
        if offset & 1 != 0 { return 0xFF; }
        match self.select {
            0xA => 0xF1, // ready
            0xC => 0xF0 | self.out & 0x0F,
            0xD => 0xF0 | self.out >> 4,
            _ => 0xF0,
        }
    }

    pub fn export_footer(&self) -> Vec<u8> {
        let mut out: Vec<u8> = digits(self.now()).iter().flat_map(|&d| (d as u32).to_le_bytes()).collect();
        out.extend_from_slice(&((now_ms() / 1000.0) as u64).to_le_bytes());
        out
    }

    /// Restores the footer; the clock goes on by the wall time elapsed since it was written.
    pub fn import_footer(&mut self, f: &[u8]) {
        let d: [u8; 13] = std::array::from_fn(|i| f[i * 4]);
        let saved_at = u64::from_le_bytes(f[52..60].try_into().unwrap()) as f64;
        self.base_ms = (saved_at - seconds(&d) as f64) * 1000.0;
    }

    /// Register state for save states: selected register, the 16 nibbles, the byte read back.
    pub fn export_state(&self) -> Vec<u8> {
        let mut out = vec![self.select];
        out.extend_from_slice(&self.regs);
        out.push(self.out);
        out
    }

    /// Anything shorter than `export_state` (a state from before the block) is power-on.
    pub fn import_state(&mut self, d: &[u8]) {
        let d = d.first_chunk::<18>().copied().unwrap_or([0; 18]);
        self.select = d[0] & 0x0F;
        for (r, v) in self.regs.iter_mut().zip(&d[1..17]) { *r = v & 0x0F; }
        self.out = d[17];
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn tama5_digits_round_trip_through_the_calendar() {
        for t in [0, 59 * DAY + 3723, 366 * DAY, 36524 * DAY + 86399] {
            assert_eq!(seconds(&digits(t)), t);
        }
        // 2000-02-29 (a leap day), 01:02:03, a Tuesday.
        assert_eq!(digits(59 * DAY + 3723), [3, 0, 2, 0, 1, 0, 2, 9, 2, 2, 0, 0, 0]);
    }
}
