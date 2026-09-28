//! SPC700 (the SNES audio CPU behind Super Game Boy sound): hand-assembled programs in audio RAM,
//! expected values written from the public documentation (fullsnes, Anomie's SPC700 doc).

use gb_core::spc700::{DspBus, Spc700};

/// Records every S-DSP register access; reads answer `0x40 | reg`.
#[derive(Default)]
struct Dsp {
    writes: Vec<(u8, u8)>,
    reads: Vec<u8>,
}

impl DspBus for Dsp {
    fn read(&mut self, reg: u8) -> u8 {
        self.reads.push(reg);
        0x40 | reg
    }
    fn write(&mut self, reg: u8, value: u8) {
        self.writes.push((reg, value));
    }
}

// ─── Memory map, ports, DSP, timers ───

#[test]
fn dsp_register_write_reaches_the_bus_once() {
    // AC3: $F2 = $4C (KON), $F3 = $01.
    let (mut spc, mut dsp) = (Spc700::new(), Dsp::default());
    spc.write(0xF2, 0x4C, &mut dsp);
    spc.write(0xF3, 0x01, &mut dsp);
    assert_eq!(dsp.writes, vec![(0x4C, 0x01)]);
    assert_eq!(spc.read(0xF2, &mut dsp), 0x4C);
}

#[test]
fn dsp_read_masks_the_address_and_high_writes_are_dropped() {
    let (mut spc, mut dsp) = (Spc700::new(), Dsp::default());
    spc.write(0xF2, 0x8C, &mut dsp);
    assert_eq!(spc.read(0xF3, &mut dsp), 0x4C); // read of $8C mirrors $0C
    assert_eq!(dsp.reads, vec![0x0C]);
    spc.write(0xF3, 0x55, &mut dsp); // $80-$FF are read-only
    assert!(dsp.writes.is_empty());
}

#[test]
fn ports_are_split_between_the_two_sides() {
    let (mut spc, mut dsp) = (Spc700::new(), Dsp::default());
    spc.ports_in = [1, 2, 3, 4];
    assert_eq!(spc.read(0xF5, &mut dsp), 2);
    spc.write(0xF6, 0x99, &mut dsp);
    assert_eq!(spc.ports_out, [0, 0, 0x99, 0]);
    assert_eq!(spc.read(0xF6, &mut dsp), 3); // the SPC700 reads the other side
    // $F1 bit 4 clears input ports 0-1, bit 5 ports 2-3.
    spc.write(0xF1, 0x10, &mut dsp);
    assert_eq!(spc.ports_in, [0, 0, 3, 4]);
    spc.write(0xF1, 0x20, &mut dsp);
    assert_eq!(spc.ports_in, [0, 0, 0, 0]);
}

#[test]
fn no_ipl_rom_top_page_is_ram() {
    let (mut spc, mut dsp) = (Spc700::new(), Dsp::default());
    spc.write(0xF1, 0x80, &mut dsp); // IPL enable bit: ignored
    spc.write(0xFFC0, 0x12, &mut dsp);
    assert_eq!(spc.read(0xFFC0, &mut dsp), 0x12);
    spc.write(0x1234, 0x56, &mut dsp);
    assert_eq!(spc.aram[0x1234], 0x56);
}

#[test]
fn timer_0_counts_at_8khz() {
    let (mut spc, mut dsp) = (Spc700::new(), Dsp::default());
    spc.write(0xFA, 4, &mut dsp); // target 4 → one output tick per 4 × 128 cycles
    spc.write(0xF1, 0x01, &mut dsp);
    spc.tick_timers(128 * 4 * 3 + 127);
    assert_eq!(spc.read(0xFD, &mut dsp), 3);
    assert_eq!(spc.read(0xFD, &mut dsp), 0, "counter clears on read");
}

#[test]
fn timer_2_counts_at_64khz_and_wraps_at_4_bits() {
    let (mut spc, mut dsp) = (Spc700::new(), Dsp::default());
    spc.write(0xFC, 1, &mut dsp);
    spc.write(0xF1, 0x04, &mut dsp);
    spc.tick_timers(16 * 17);
    assert_eq!(spc.read(0xFF, &mut dsp), 1); // 17 & 15
}

#[test]
fn timer_target_0_means_256_and_disabled_timers_hold() {
    let (mut spc, mut dsp) = (Spc700::new(), Dsp::default());
    spc.write(0xFB, 0, &mut dsp);
    spc.write(0xF1, 0x02, &mut dsp);
    spc.tick_timers(128 * 255);
    assert_eq!(spc.read(0xFE, &mut dsp), 0);
    spc.tick_timers(128);
    assert_eq!(spc.read(0xFE, &mut dsp), 1);
    spc.tick_timers(128 * 512); // timer 0 never enabled
    assert_eq!(spc.read(0xFD, &mut dsp), 0);
}
