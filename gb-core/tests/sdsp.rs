//! S-DSP (the SNES sound generator behind Super Game Boy sound): hand-built BRR data and register
//! setups, expected values written from the public documentation (fullsnes, Anomie's S-DSP doc).

use gb_core::sdsp::{decode_brr_block, Sdsp};

// ─── Registers and BRR decoding ───

#[test]
fn brr_filter0_shift12_decodes_to_the_nibbles_times_4096() {
    // AC2: header $C0 = shift 12, filter 0, no loop/end; nibbles 1,2,…,F,0 (4-bit signed).
    // Each sample is (n << 12) >> 1, then doubled into the 16-bit buffer: n × 4096.
    let block = [0xC0, 0x12, 0x34, 0x56, 0x78, 0x9A, 0xBC, 0xDE, 0xF0];
    let mut prev = [0, 0];
    let out = decode_brr_block(&block, &mut prev);
    assert_eq!(
        out,
        [
            4096, 8192, 12288, 16384, 20480, 24576, 28672, -32768, -28672, -24576, -20480, -16384,
            -12288, -8192, -4096, 0
        ]
    );
    assert_eq!(prev, [-4096, 0]); // the two last samples, oldest first
}

#[test]
fn brr_filter1_adds_fifteen_sixteenths_of_the_previous_sample() {
    // Header $04 = shift 0, filter 1; all nibbles 0. s = p1/2 + (-p1 >> 5), doubled.
    // p1 = 1000: 500 + (-32) = 468 → 936; then 468 + (-936 >> 5 = -30) = 438 → 876; …
    let block = [0x04, 0, 0, 0, 0, 0, 0, 0, 0];
    let mut prev = [0, 1000];
    let out = decode_brr_block(&block, &mut prev);
    assert_eq!(out[..3], [936, 876, 820]);
}

#[test]
fn brr_shift_above_12_keeps_only_the_sign() {
    // Shift 13-15: negative nibbles give -2048 (doubled: -4096), positive ones 0.
    let block = [0xD0, 0x7F, 0, 0, 0, 0, 0, 0, 0];
    let out = decode_brr_block(&block, &mut [0, 0]);
    assert_eq!(out[..3], [0, -4096, 0]);
}

#[test]
fn registers_read_back_and_endx_clears_on_write() {
    let mut dsp = Sdsp::new();
    dsp.write_reg(0x00, 0x7F); // voice 0 VOL(L)
    dsp.write_reg(0x5D, 0x12); // DIR
    dsp.write_reg(0xDD, 0x34); // $80-$FF are read-only mirrors of $00-$7F
    assert_eq!(dsp.read_reg(0x00), 0x7F);
    assert_eq!(dsp.read_reg(0x5D), 0x12);
    assert_eq!(dsp.read_reg(0xDD), 0x12);
    assert_eq!(dsp.read_reg(0x6C), 0xE0); // FLG powers up with reset, mute and echo-write-disable set
    dsp.write_reg(0x7C, 0xFF); // any write to ENDX clears it
    assert_eq!(dsp.read_reg(0x7C), 0);
}
