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

// ─── Voices ───

/// Audio RAM with the sample directory at $0200 (DIR = 2): source 0 starts and loops at $0300.
fn aram_with(blocks: &[[u8; 9]]) -> Box<[u8; 0x10000]> {
    let mut aram: Box<[u8; 0x10000]> = vec![0; 0x10000].into_boxed_slice().try_into().unwrap();
    aram[0x200..0x204].copy_from_slice(&[0x00, 0x03, 0x00, 0x03]);
    for (i, b) in blocks.iter().enumerate() {
        aram[0x300 + i * 9..][..9].copy_from_slice(b);
    }
    aram
}

/// Shift 8, filter 0; the second block ends and loops.
const BLOCK_A: [u8; 9] = [0x80, 0x13, 0x57, 0x7F, 0xDB, 0x97, 0x53, 0x10, 0xF2];
const BLOCK_B: [u8; 9] = [0x83, 0x24, 0x68, 0xAC, 0xE0, 0x21, 0x43, 0x65, 0x87];

/// Voice 0: VOL 7F/40, pitch $1000, source 0, ADSR attack 15 (sustain level 7, no decay), main
/// volume 7F, DIR 2, FLG = echo writes off; then the given extra writes.
fn voice0(extra: &[(u8, u8)]) -> Sdsp {
    let mut dsp = Sdsp::new();
    #[rustfmt::skip]
    let setup = [
        (0x00, 0x7F), (0x01, 0x40), (0x02, 0x00), (0x03, 0x10), (0x04, 0), (0x05, 0x8F),
        (0x06, 0xE0), (0x0C, 0x7F), (0x1C, 0x7F), (0x5D, 0x02), (0x6C, 0x20),
    ];
    for &(r, v) in setup.iter().chain(extra) {
        dsp.write_reg(r, v);
    }
    dsp
}

#[test]
fn voice_plays_the_sample_at_the_source_rate_through_its_envelope() {
    // AC3. KON is read on the first sample; the voice spends 5 samples starting (silent, BRR
    // buffer filling), then the attack (rate 31: +$400 per sample) gives env $400, then $7FF. At
    // pitch $1000 the Gaussian window steps one source sample per output sample, fraction 0:
    // (g[255]·s0 >> 11) + (g[511]·s1 >> 11) + (g[256]·s2 >> 11) + (g[0]·s3 >> 11) with the kernel
    // g = 366, 1305, 369, 0; then × env >> 11, × VOL >> 7, × MVOL >> 7.
    let mut aram = aram_with(&[BLOCK_A, BLOCK_B]);
    let mut dsp = voice0(&[(0x4C, 0x01)]);
    let out: Vec<_> = (0..32).map(|_| dsp.sample(&mut aram)).collect();
    #[rustfmt::skip]
    let expected = [
        (0, 0), (0, 0), (0, 0), (0, 0), (0, 0), (0, 0), (376, 189), (1252, 631), (1660, 837),
        (1389, 700), (12, 6), (-757, -381), (-1260, -635), (-1034, -521), (1030, 519), (1250, 630),
        (748, 377), (292, 147), (-2, -1), (-72, -36), (364, 183), (588, 296), (1000, 504),
        (776, 391), (-1288, -649), (-1508, -760), (-1008, -508), (-504, -254), (0, 0), (364, 183),
        (428, 216), (818, 412),
    ];
    assert_eq!(out, expected);
    assert_eq!(dsp.read_reg(0x08), 0x7F); // ENVX = env >> 4
    assert_eq!(dsp.read_reg(0x7C), 0x01); // ENDX: block B's end flag was passed (and looped)
}

#[test]
fn brr_end_without_loop_silences_the_voice_and_sets_endx() {
    let mut aram = aram_with(&[[0xC1, 0x77, 0x77, 0x77, 0x77, 0x77, 0x77, 0x77, 0x77]]);
    let mut dsp = voice0(&[(0x4C, 0x01)]);
    for _ in 0..32 {
        assert_eq!(dsp.sample(&mut aram), (0, 0));
    }
    assert_eq!(dsp.read_reg(0x08), 0);
    assert_eq!(dsp.read_reg(0x7C), 0x01);
}

#[test]
fn kon_and_kof_on_the_same_sample_stay_silent() {
    let mut aram = aram_with(&[BLOCK_A, BLOCK_B]);
    let mut dsp = voice0(&[(0x5C, 0x01), (0x4C, 0x01)]);
    for _ in 0..32 {
        assert_eq!(dsp.sample(&mut aram), (0, 0));
    }
}

#[test]
fn flg_mute_silences_the_output_but_not_the_voice() {
    let mut aram = aram_with(&[BLOCK_A, BLOCK_B]);
    let mut dsp = voice0(&[(0x6C, 0x60), (0x4C, 0x01)]);
    for _ in 0..8 {
        assert_eq!(dsp.sample(&mut aram), (0, 0));
    }
    assert_ne!(dsp.read_reg(0x09), 0); // OUTX still follows the voice
}
