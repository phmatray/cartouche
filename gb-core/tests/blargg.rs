//! Blargg gb-test-roms harness.
//!
//! A ROM's result is read from whichever channel reports first:
//! 1. the $A000 cart-RAM protocol ($A001-$A003 = DE B0 61, $A000 status, text at $A004),
//! 2. serial port text containing "Passed" / "Failed",
//! 3. on-screen text (Blargg's console stores ASCII codes as BG tile indices).
//! The ROMs live in test-roms/ (gitignored, never committed).

use std::path::Path;

use gb_core::gameboy::{GameBoy, Model, CYCLES_PER_FRAME};

/// 120 emulated seconds; the slowest suites (cpu_instrs, dmg_sound) finish in about a minute.
const TIMEOUT_FRAMES: u32 = 7200;

struct Report {
    passed: bool,
    how: String,
    serial: String,
    cart_text: String,
    screen: String,
}

impl std::fmt::Display for Report {
    fn fmt(&self, f: &mut std::fmt::Formatter) -> std::fmt::Result {
        write!(
            f,
            "{}\n--- $A004 text ---\n{}\n--- serial ---\n{}\n--- screen ---\n{}",
            self.how, self.cart_text, self.serial, self.screen
        )
    }
}

fn boot(rom_path: &str, model: Model) -> GameBoy {
    let path = Path::new(env!("CARGO_MANIFEST_DIR")).join(rom_path);
    let rom = std::fs::read(&path).unwrap_or_else(|e| panic!("cannot read {}: {e}", path.display()));
    let mut gb = GameBoy::with_model(rom, model).expect("Failed to create GameBoy");
    gb.skip_boot_rom();
    gb
}

/// Zero-terminated text from cart RAM at $A004, if the DE B0 61 signature is present.
fn cart_ram(gb: &GameBoy) -> Option<(u8, String)> {
    let cart = &gb.bus.cartridge;
    if (cart.read_ram(1), cart.read_ram(2), cart.read_ram(3)) != (0xDE, 0xB0, 0x61) {
        return None;
    }
    let text: Vec<u8> = (4..0x2000u16).map(|o| cart.read_ram(o)).take_while(|&b| b != 0).collect();
    Some((cart.read_ram(0), String::from_utf8_lossy(&text).into_owned()))
}

/// Decodes the visible BG tile map as text: tile index = ASCII code (bit 7 = inverse attribute).
fn screen_text(gb: &GameBoy) -> String {
    let ppu = &gb.bus.ppu;
    let map = if ppu.lcdc & 0x08 != 0 { 0x1C00 } else { 0x1800 };
    let top = ppu.scy as usize / 8;
    (0..18)
        .map(|r| {
            let row = (top + r) % 32;
            let line: String = (0..20)
                .map(|c| match ppu.vram[map + row * 32 + c] & 0x7F {
                    b @ 0x20..=0x7E => b as char,
                    _ => ' ',
                })
                .collect();
            line.trim_end().to_string()
        })
        .collect::<Vec<_>>()
        .join("\n")
        .trim()
        .to_string()
}

fn verdict(text: &str) -> Option<bool> {
    if text.contains("Passed") {
        Some(true)
    } else if text.contains("Failed") {
        Some(false)
    } else {
        None
    }
}

fn run_blargg(rom_path: &str, model: Model) -> Report {
    let mut gb = boot(rom_path, model);
    // Only trust a final $A000 status after seeing $80 ("running"): the signature is written
    // a few instructions before the status byte, which is 0 until then.
    let mut seen_running = false;
    let mut how = format!("timed out after {TIMEOUT_FRAMES} frames");
    let mut passed = false;

    'frames: for frame in 0..TIMEOUT_FRAMES {
        let mut cycles = 0;
        while cycles < CYCLES_PER_FRAME {
            match gb.step_instruction() {
                Ok(c) => cycles += c,
                Err(e) => {
                    how = format!("emulator error at frame {frame}: {e}");
                    break 'frames;
                }
            }
        }
        if let Some((status, _)) = cart_ram(&gb) {
            if status == 0x80 {
                seen_running = true;
            } else if seen_running {
                passed = status == 0;
                how = format!("$A000 result code {status} at frame {frame}");
                break;
            }
        }
        if let Some(p) = verdict(&String::from_utf8_lossy(gb.bus.serial_output())) {
            passed = p;
            how = format!("serial verdict at frame {frame}");
            break;
        }
        // Screen text is the last resort: when the ROM speaks the $A000 protocol, wait for its code.
        if seen_running {
            continue;
        }
        if let Some(p) = verdict(&screen_text(&gb)) {
            passed = p;
            how = format!("screen verdict at frame {frame}");
            break;
        }
    }

    Report {
        passed,
        how,
        serial: String::from_utf8_lossy(gb.bus.serial_output()).into_owned(),
        cart_text: cart_ram(&gb).map(|(_, t)| t).unwrap_or_default(),
        screen: screen_text(&gb),
    }
}

macro_rules! blargg {
    ($($name:ident: $model:ident $path:expr;)*) => {$(
        #[test]
        fn $name() {
            let report = run_blargg($path, Model::$model);
            println!("=== {} ===\n{}", stringify!($name), report);
            assert!(report.passed, "{} did not pass: {}", $path, report);
        }
    )*};
}

blargg! {
    cpu_01_special: Dmg "test-roms/cpu_instrs/individual/01-special.gb";
    cpu_02_interrupts: Dmg "test-roms/cpu_instrs/individual/02-interrupts.gb";
    cpu_03_op_sp_hl: Dmg "test-roms/cpu_instrs/individual/03-op sp,hl.gb";
    cpu_04_op_r_imm: Dmg "test-roms/cpu_instrs/individual/04-op r,imm.gb";
    cpu_05_op_rp: Dmg "test-roms/cpu_instrs/individual/05-op rp.gb";
    cpu_06_ld_r_r: Dmg "test-roms/cpu_instrs/individual/06-ld r,r.gb";
    cpu_07_jr_jp_call_ret_rst: Dmg "test-roms/cpu_instrs/individual/07-jr,jp,call,ret,rst.gb";
    cpu_08_misc_instrs: Dmg "test-roms/cpu_instrs/individual/08-misc instrs.gb";
    cpu_09_op_r_r: Dmg "test-roms/cpu_instrs/individual/09-op r,r.gb";
    cpu_10_bit_ops: Dmg "test-roms/cpu_instrs/individual/10-bit ops.gb";
    cpu_11_op_a_hl: Dmg "test-roms/cpu_instrs/individual/11-op a,(hl).gb";
    cpu_instrs: Dmg "test-roms/cpu_instrs/cpu_instrs.gb";
    // The copy bundled with the web app, in the mode the app picks for it (its header asks for CGB).
    bundled_cpu_instrs: Auto "../gb-web/public/roms/cpu_instrs.gb";

    instr_timing: Dmg "test-roms/instr_timing/instr_timing.gb";

    mem_timing_01_read: Dmg "test-roms/mem_timing/individual/01-read_timing.gb";
    mem_timing_02_write: Dmg "test-roms/mem_timing/individual/02-write_timing.gb";
    mem_timing_03_modify: Dmg "test-roms/mem_timing/individual/03-modify_timing.gb";
    mem_timing: Dmg "test-roms/mem_timing/mem_timing.gb";

    mem_timing2_01_read: Dmg "test-roms/mem_timing-2/rom_singles/01-read_timing.gb";
    mem_timing2_02_write: Dmg "test-roms/mem_timing-2/rom_singles/02-write_timing.gb";
    mem_timing2_03_modify: Dmg "test-roms/mem_timing-2/rom_singles/03-modify_timing.gb";
    mem_timing2: Dmg "test-roms/mem_timing-2/mem_timing.gb";

    halt_bug: Dmg "test-roms/halt_bug.gb";

    interrupt_time: Auto "test-roms/interrupt_time/interrupt_time.gb";

    dmg_sound_01_registers: Dmg "test-roms/dmg_sound/rom_singles/01-registers.gb";
    dmg_sound_02_len_ctr: Dmg "test-roms/dmg_sound/rom_singles/02-len ctr.gb";
    dmg_sound_03_trigger: Dmg "test-roms/dmg_sound/rom_singles/03-trigger.gb";
    dmg_sound_04_sweep: Dmg "test-roms/dmg_sound/rom_singles/04-sweep.gb";
    dmg_sound_05_sweep_details: Dmg "test-roms/dmg_sound/rom_singles/05-sweep details.gb";
    dmg_sound_06_overflow_on_trigger: Dmg "test-roms/dmg_sound/rom_singles/06-overflow on trigger.gb";
    dmg_sound_07_len_sweep_period_sync: Dmg "test-roms/dmg_sound/rom_singles/07-len sweep period sync.gb";
    dmg_sound_08_len_ctr_during_power: Dmg "test-roms/dmg_sound/rom_singles/08-len ctr during power.gb";
    dmg_sound_09_wave_read_while_on: Dmg "test-roms/dmg_sound/rom_singles/09-wave read while on.gb";
    dmg_sound_10_wave_trigger_while_on: Dmg "test-roms/dmg_sound/rom_singles/10-wave trigger while on.gb";
    dmg_sound_11_regs_after_power: Dmg "test-roms/dmg_sound/rom_singles/11-regs after power.gb";
    dmg_sound_12_wave_write_while_on: Dmg "test-roms/dmg_sound/rom_singles/12-wave write while on.gb";
    dmg_sound: Dmg "test-roms/dmg_sound/dmg_sound.gb";

    cgb_sound_01_registers: Auto "test-roms/cgb_sound/rom_singles/01-registers.gb";
    cgb_sound_02_len_ctr: Auto "test-roms/cgb_sound/rom_singles/02-len ctr.gb";
    cgb_sound_03_trigger: Auto "test-roms/cgb_sound/rom_singles/03-trigger.gb";
    cgb_sound_04_sweep: Auto "test-roms/cgb_sound/rom_singles/04-sweep.gb";
    cgb_sound_05_sweep_details: Auto "test-roms/cgb_sound/rom_singles/05-sweep details.gb";
    cgb_sound_06_overflow_on_trigger: Auto "test-roms/cgb_sound/rom_singles/06-overflow on trigger.gb";
    cgb_sound_07_len_sweep_period_sync: Auto "test-roms/cgb_sound/rom_singles/07-len sweep period sync.gb";
    cgb_sound_08_len_ctr_during_power: Auto "test-roms/cgb_sound/rom_singles/08-len ctr during power.gb";
    cgb_sound_09_wave_read_while_on: Auto "test-roms/cgb_sound/rom_singles/09-wave read while on.gb";
    cgb_sound_10_wave_trigger_while_on: Auto "test-roms/cgb_sound/rom_singles/10-wave trigger while on.gb";
    cgb_sound_11_regs_after_power: Auto "test-roms/cgb_sound/rom_singles/11-regs after power.gb";
    cgb_sound_12_wave: Auto "test-roms/cgb_sound/rom_singles/12-wave.gb";
    cgb_sound: Auto "test-roms/cgb_sound/cgb_sound.gb";

    oam_bug_1_lcd_sync: Dmg "test-roms/oam_bug/rom_singles/1-lcd_sync.gb";
    oam_bug_2_causes: Dmg "test-roms/oam_bug/rom_singles/2-causes.gb";
    oam_bug_3_non_causes: Dmg "test-roms/oam_bug/rom_singles/3-non_causes.gb";
    oam_bug_4_scanline_timing: Dmg "test-roms/oam_bug/rom_singles/4-scanline_timing.gb";
    oam_bug_5_timing_bug: Dmg "test-roms/oam_bug/rom_singles/5-timing_bug.gb";
    oam_bug_6_timing_no_bug: Dmg "test-roms/oam_bug/rom_singles/6-timing_no_bug.gb";
    // 7-timing_effect: see oam_bug_7_timing_effect_via_combined below.
    oam_bug_8_instr_effect: Dmg "test-roms/oam_bug/rom_singles/8-instr_effect.gb";
}

/// The combined oam_bug.gb must pass and report every subtest as ok.
#[test]
fn oam_bug() {
    let report = run_blargg("test-roms/oam_bug/oam_bug.gb", Model::Dmg);
    println!("=== oam_bug ===\n{report}");
    assert!(report.passed, "oam_bug.gb did not pass: {report}");
    for n in 1..=8 {
        assert!(report.cart_text.contains(&format!("{n:02}:ok")), "subtest {n:02} not ok: {report}");
    }
}

/// `rom_singles/7-timing_effect.gb` cannot finish, on hardware either: it prints an OAM dump for
/// each of the 19 corrupting timings (17 + 19 x 515 = 9802 characters) to the $A004 text log, and
/// `write_text_out` in source/common/shell.s has no bound check. Its header declares 8 KB of cart
/// RAM, so after 8188 characters the log runs into $C000, where `copy_to_wram_then_run` placed the
/// program, and the ROM restarts over and over. The same test code runs as subtest 07 of the
/// combined ROM, whose CRC of that printed output must match the hardware value.
#[test]
fn oam_bug_7_timing_effect_via_combined() {
    let report = run_blargg("test-roms/oam_bug/oam_bug.gb", Model::Dmg);
    assert!(report.cart_text.contains("07:ok"), "subtest 07 not ok: {report}");
}

/// Sanity check of the verdict parser.
#[test]
fn verdict_decoding() {
    assert_eq!(verdict("01:ok\n\nPassed all tests"), Some(true));
    assert_eq!(verdict("Failed #3"), Some(false));
    assert_eq!(verdict("01:ok 02:"), None);
}
