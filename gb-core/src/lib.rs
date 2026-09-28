pub mod apu;
pub mod boot_rom;
pub mod camera;
pub mod cartridge;
pub mod cheats;
pub mod cpu;
pub mod debug;
pub mod disasm;
pub mod error;
pub mod flash;
pub mod gameboy;
pub mod gbs;
pub mod interrupts;
pub mod joypad;
pub mod mbc7;
pub mod memory;
pub mod ppu;
pub mod printer;
pub mod registers;
pub mod sdsp;
pub mod serial;
pub mod sgb;
pub mod spc700;
pub mod tama5;
pub mod timer;
pub mod trace;

use wasm_bindgen::prelude::*;

use crate::gameboy::GameBoy;
use crate::joypad::JoypadButton;
use crate::ppu::FRAMEBUFFER_SIZE;

#[wasm_bindgen]
pub struct Emulator {
    gb: Option<GameBoy>,
    last_error: Option<String>,
}

#[wasm_bindgen]
impl Emulator {
    #[wasm_bindgen(constructor)]
    pub fn new() -> Emulator {
        Emulator {
            gb: None,
            last_error: None,
        }
    }

    /// Starts from the post-boot state, each cartridge on its own console.
    pub fn load_rom(&mut self, rom_data: &[u8]) -> bool {
        self.load_rom_with(rom_data, false, 0, 0)
    }

    /// `colorize`: run a DMG-only cartridge on a Game Boy Color, `palette` 0 automatic or 1-12
    /// (see `GameBoy::with_boot`); `animation`: the start-up animation, 0 none, 1 Registration,
    /// 2 Insert, 3 Shelf pick (`true` still reads as 1, `false` as 0).
    pub fn load_rom_with(&mut self, rom_data: &[u8], colorize: bool, palette: u8, animation: u8) -> bool {
        match GameBoy::with_boot(rom_data.to_vec(), colorize, palette, animation) {
            Ok(gb) => {
                self.gb = Some(gb);
                self.last_error = None;
                true
            }
            Err(e) => {
                self.last_error = Some(e.to_string());
                false
            }
        }
    }

    /// Plays `track` (0-based) of a GBS music file, wrapped in a synthetic cartridge (`gbs::to_rom`)
    /// on a fresh machine. Changing track = calling this again.
    pub fn load_gbs(&mut self, data: &[u8], track: u8) -> bool {
        match gbs::to_rom(data, track) {
            Ok(rom) => self.load_rom_with(&rom, false, 0, 0),
            Err(e) => {
                self.last_error = Some(e.to_string());
                false
            }
        }
    }

    /// A Super Game Boy (palettes, border, multiplayer) for a cartridge with SGB support; any
    /// other cartridge starts as with `load_rom_with(rom, false, 0, animation)`.
    pub fn load_rom_sgb(&mut self, rom_data: &[u8], animation: u8) -> bool {
        match GameBoy::with_sgb(rom_data.to_vec(), animation) {
            Ok(gb) => {
                self.gb = Some(gb);
                self.last_error = None;
                true
            }
            Err(e) => {
                self.last_error = Some(e.to_string());
                false
            }
        }
    }

    /// Super Game Boy border, `sgb::BORDER_WIDTH` x `BORDER_HEIGHT` RGBA (the Game Boy's picture goes
    /// at `GAME_X`, `GAME_Y` on top of it). Null until the game sent one (`sgb_border_version` 0).
    pub fn sgb_border_ptr(&self) -> *const u8 {
        self.sgb().filter(|s| s.has_border).map_or(std::ptr::null(), |s| s.border.as_ptr())
    }

    /// Bumped whenever the border is redrawn; 0: no border.
    pub fn sgb_border_version(&self) -> u32 {
        self.sgb().filter(|s| s.has_border).map_or(0, |s| s.border_version.max(1))
    }

    /// The game plays its music on the Super Game Boy's SNES sound chip, which isn't emulated:
    /// silent here, or nearly, where the Game Boy plays its own (known about 10 s after it starts).
    pub fn sgb_snes_music(&self) -> bool {
        self.sgb().is_some_and(|s| s.snes_music())
    }

    /// Buttons of Super Game Boy players 2-4 (`player` 1-3), read once the game asks for them (MLT_REQ).
    pub fn press_button_player(&mut self, player: u8, button: JoypadButton) {
        self.set_player_button(player, button, true);
    }

    pub fn release_button_player(&mut self, player: u8, button: JoypadButton) {
        self.set_player_button(player, button, false);
    }

    pub fn run_frame(&mut self) -> bool {
        if let Some(gb) = &mut self.gb {
            match gb.run_frame() {
                Ok(()) => true,
                Err(e) => {
                    self.last_error = Some(e.to_string());
                    false
                }
            }
        } else {
            self.last_error = Some("No ROM loaded".to_string());
            false
        }
    }

    /// Runs one frame on this console and `other`, joined by a link cable (both must belong to
    /// the same WASM instance, e.g. one worker). On error, `get_error()` names the player.
    pub fn run_frame_linked(&mut self, other: &mut Emulator) -> bool {
        let (Some(a), Some(b)) = (&mut self.gb, &mut other.gb) else {
            self.last_error = Some("No ROM loaded".to_string());
            return false;
        };
        match crate::gameboy::run_linked_frame(a, b) {
            Ok(()) => true,
            Err((player, e)) => {
                self.last_error = Some(format!("P{}: {e}", player + 1));
                false
            }
        }
    }

    pub fn step(&mut self) -> u32 {
        if let Some(gb) = &mut self.gb {
            let stepped = gb.step_instruction();
            gb.resume_here();
            match stepped {
                Ok(cycles) => cycles,
                Err(e) => {
                    self.last_error = Some(e.to_string());
                    0
                }
            }
        } else {
            0
        }
    }

    /// `run_frame` stops before the instruction at `addr` (see `debug_break_reason`).
    pub fn debug_add_breakpoint(&mut self, addr: u16) {
        if let Some(gb) = &mut self.gb {
            gb.debugger_mut().breakpoints.insert(addr);
        }
    }

    pub fn debug_remove_breakpoint(&mut self, addr: u16) {
        if let Some(d) = self.gb.as_mut().and_then(|gb| gb.debugger.as_mut()) {
            d.breakpoints.remove(&addr);
        }
    }

    /// Drops every breakpoint and the debugger itself: `run_frame` is back to full speed.
    pub fn debug_clear(&mut self) {
        if let Some(gb) = &mut self.gb {
            gb.debugger = None;
        }
    }

    /// Why the last `run_frame` / `debug_step_frame` stopped ("breakpoint $0150", "frame"),
    /// once; `None` when it ran to the end of the frame.
    pub fn debug_break_reason(&mut self) -> Option<String> {
        self.gb.as_mut()?.take_break().map(|b| b.describe())
    }

    /// `count` instructions from `addr`, one per line as `ADDR|BYTES|TEXT` ("0150|3E 01|LD A, $01").
    /// Reads only, so it changes no machine state.
    pub fn disassemble(&self, addr: u16, count: u16) -> String {
        let Some(gb) = &self.gb else { return String::new() };
        let mut out = Vec::with_capacity(count as usize);
        let mut at = addr;
        for _ in 0..count {
            let (text, len) = crate::disasm::disassemble_one(&gb.bus, at);
            let bytes: Vec<String> = (0..len as u16).map(|i| format!("{:02X}", gb.bus.read_byte(at.wrapping_add(i)))).collect();
            out.push(format!("{at:04X}|{}|{text}", bytes.join(" ")));
            at = at.wrapping_add(len as u16);
        }
        out.join("\n")
    }

    /// Runs a `CALL`/`RST` to its return (bounded by the frame), otherwise one step.
    pub fn debug_step_over(&mut self) -> bool {
        let Some(gb) = &mut self.gb else { return false };
        match gb.step_over() {
            Ok(()) => true,
            Err(e) => {
                self.last_error = Some(e.to_string());
                false
            }
        }
    }

    /// Runs to the next VBlank and stops there (reason "frame").
    pub fn debug_step_frame(&mut self) -> bool {
        let Some(gb) = &mut self.gb else { return false };
        match gb.step_frame() {
            Ok(()) => true,
            Err(e) => {
                self.last_error = Some(e.to_string());
                false
            }
        }
    }

    pub fn framebuffer_ptr(&self) -> *const u8 {
        if let Some(gb) = &self.gb {
            gb.screen().as_ptr()
        } else {
            std::ptr::null()
        }
    }

    pub fn framebuffer_len(&self) -> usize {
        FRAMEBUFFER_SIZE
    }

    pub fn frame_ready(&self) -> bool {
        self.gb
            .as_ref()
            .map_or(false, |gb| gb.bus.ppu.frame_ready)
    }

    pub fn press_button(&mut self, button: JoypadButton) {
        if let Some(gb) = &mut self.gb {
            if gb.bus.joypad.set_button(button, true) {
                gb.bus.interrupts.request(crate::interrupts::JOYPAD_BIT);
            }
        }
    }

    pub fn release_button(&mut self, button: JoypadButton) {
        if let Some(gb) = &mut self.gb {
            gb.bus.joypad.set_button(button, false);
            // No interrupt on release
        }
    }

    pub fn get_error(&self) -> Option<String> {
        self.last_error.clone()
    }

    // Debug accessors
    pub fn get_pc(&self) -> u16 {
        self.gb.as_ref().map_or(0, |gb| gb.cpu.regs.pc)
    }

    pub fn get_sp(&self) -> u16 {
        self.gb.as_ref().map_or(0, |gb| gb.cpu.regs.sp)
    }

    pub fn get_af(&self) -> u16 {
        self.gb.as_ref().map_or(0, |gb| gb.cpu.regs.af())
    }

    pub fn get_bc(&self) -> u16 {
        self.gb.as_ref().map_or(0, |gb| gb.cpu.regs.bc())
    }

    pub fn get_de(&self) -> u16 {
        self.gb.as_ref().map_or(0, |gb| gb.cpu.regs.de())
    }

    pub fn get_hl(&self) -> u16 {
        self.gb.as_ref().map_or(0, |gb| gb.cpu.regs.hl())
    }

    pub fn read_memory(&self, addr: u16) -> u8 {
        self.gb.as_ref().map_or(0, |gb| gb.bus.read_byte(addr))
    }

    /// A byte at a RetroAchievements address (see `MemoryBus::read_ra`).
    pub fn read_memory_ra(&self, addr: u32) -> u8 {
        self.gb.as_ref().map_or(0, |gb| gb.bus.read_ra(addr))
    }

    pub fn is_rom_loaded(&self) -> bool {
        self.gb.is_some()
    }

    /// True when the picture is in colour: a Game Boy Color cartridge (header byte 0x143, bit 7),
    /// or an original Game Boy one colourised by the Game Boy Color.
    pub fn is_cgb(&self) -> bool {
        self.gb.as_ref().map_or(false, |gb| gb.in_colour())
    }

    /// 0 original Game Boy, 1 Game Boy Color, 2 original Game Boy cartridge on a Game Boy Color.
    pub fn console(&self) -> u8 {
        self.gb.as_ref().map_or(255, |gb| gb.console as u8)
    }

    /// The console a save state was made on (as `console()`), 255 when it is not a state.
    /// `load_state` refuses a state from another console.
    pub fn state_console(&self, data: &[u8]) -> u8 {
        self.gb.as_ref().and_then(|gb| gb.state_console(data)).map_or(255, |c| c as u8)
    }

    /// The palette an original Game Boy cartridge is colourised with: 0 automatic, 1-12 (see
    /// `load_rom_with`); a loaded state brings back its own.
    pub fn palette(&self) -> u8 {
        self.gb.as_ref().map_or(0, |gb| gb.palette)
    }

    /// The start-up animation is playing.
    pub fn booting(&self) -> bool {
        self.gb.as_ref().map_or(false, |gb| gb.bus.boot_rom_active)
    }

    /// Skips the rest of the start-up animation.
    pub fn finish_boot(&mut self) -> bool {
        let Some(gb) = &mut self.gb else { return false };
        match gb.finish_boot() {
            Ok(()) => true,
            Err(e) => {
                self.last_error = Some(e.to_string());
                false
            }
        }
    }

    pub fn has_battery_ram(&self) -> bool {
        self.gb.as_ref().map_or(false, |gb| gb.bus.cartridge.has_battery())
    }

    pub fn export_sram(&self) -> Vec<u8> {
        self.gb.as_ref().map_or(Vec::new(), |gb| gb.bus.cartridge.export_sram())
    }

    pub fn import_sram(&mut self, data: &[u8]) {
        if let Some(gb) = &mut self.gb {
            gb.bus.cartridge.import_sram(data);
        }
    }

    // Audio buffer exports
    pub fn audio_buffer_ptr(&self) -> *const f32 {
        self.gb.as_ref()
            .map_or(std::ptr::null(), |gb| gb.bus.apu.buffer_ptr())
    }

    pub fn audio_buffer_len(&self) -> usize {
        self.gb.as_ref()
            .map_or(0, |gb| gb.bus.apu.buffer_len())
    }

    pub fn drain_audio(&mut self) -> usize {
        if let Some(gb) = &mut self.gb {
            gb.bus.apu.drain_samples()
        } else {
            0
        }
    }

    pub fn clear_audio_buffer(&mut self) {
        if let Some(gb) = &mut self.gb {
            gb.bus.apu.clear_samples();
        }
    }

    pub fn set_channel_muted(&mut self, channel: u8, muted: bool) {
        if let Some(gb) = &mut self.gb {
            gb.bus.apu.set_channel_muted(channel, muted);
        }
    }

    pub fn save_state(&self) -> Vec<u8> {
        self.gb.as_ref().map_or(Vec::new(), |gb| gb.save_state())
    }

    /// A deterministic session (lockstep link): the cartridge clock starts at `epoch_seconds` (unix
    /// time) and only advances with emulated time. Nothing without a ROM.
    pub fn set_emulated_clock(&mut self, epoch_seconds: f64) {
        if let Some(gb) = &mut self.gb { gb.set_emulated_clock(epoch_seconds); }
    }

    /// FNV-1a hash of `save_state()`: two consoles in step have the same one. 0 without a ROM.
    pub fn state_hash(&self) -> u32 {
        self.gb.as_ref().map_or(0, |gb| gb.state_hash())
    }

    pub fn load_state(&mut self, data: &[u8]) -> bool {
        if let Some(gb) = &mut self.gb {
            gb.load_state(data)
        } else {
            false
        }
    }

    /// After `load_state`: the state's thumbnail, shown and drawn over by the next frame.
    pub fn set_screen(&mut self, frame: &[u8]) {
        if let Some(gb) = &mut self.gb { gb.set_screen(frame); }
    }

    /// Get a copy of the current framebuffer for save state thumbnails
    pub fn framebuffer_snapshot(&self) -> Vec<u8> {
        self.gb.as_ref()
            .map_or(Vec::new(), |gb| gb.screen().to_vec())
    }

    pub fn serial_output_ptr(&self) -> *const u8 {
        self.gb.as_ref()
            .map_or(std::ptr::null(), |gb| gb.bus.serial_output().as_ptr())
    }

    pub fn serial_output_len(&self) -> usize {
        self.gb.as_ref()
            .map_or(0, |gb| gb.bus.serial_output().len())
    }

    pub fn clear_serial_output(&mut self) {
        if let Some(gb) = &mut self.gb {
            gb.bus.clear_serial_output();
        }
    }

    /// True while an internal-clock transfer is in progress.
    pub fn serial_needs_transfer(&self) -> bool {
        self.gb.as_ref().map_or(false, |gb| gb.bus.serial.needs_transfer())
    }

    /// The byte currently being sent over the serial link.
    pub fn serial_get_byte(&self) -> u8 {
        self.gb.as_ref().map_or(0xFF, |gb| gb.bus.serial.get_byte())
    }

    /// Byte shifted in from a link-cable partner during the running transfer
    /// (`run_frame_linked` does this itself for two local consoles).
    pub fn serial_receive_byte(&mut self, byte: u8) {
        if let Some(gb) = &mut self.gb {
            gb.bus.serial.receive_byte(byte);
        }
    }

    // Peripherals: pocket camera, printer, rumble.

    /// True when the cartridge is a pocket camera (type 0xFC): feed it with `camera_set_frame`.
    pub fn has_camera(&self) -> bool {
        self.gb.as_ref().map_or(false, |gb| gb.bus.cartridge.camera.is_some())
    }

    /// The camera sensor's view: 128 x 112 grayscale bytes (0 = black), row by row.
    pub fn camera_set_frame(&mut self, frame: &[u8]) {
        if let Some(cam) = self.gb.as_mut().and_then(|gb| gb.bus.cartridge.camera.as_mut()) {
            cam.set_input(frame);
        }
    }

    /// Replaces the active cheat codes (Game Genie / GameShark, one per line; "" clears them).
    /// All or nothing: on the first bad code nothing changes and `get_error()` says `"<code>: <reason>"`.
    pub fn set_cheats(&mut self, codes: &str) -> bool {
        let Some(gb) = &mut self.gb else {
            self.last_error = Some("No ROM loaded".to_string());
            return false;
        };
        let mut list = Vec::new();
        for code in codes.lines().map(str::trim).filter(|c| !c.is_empty()) {
            let parsed = crate::cheats::parse(code).and_then(|c| match c {
                crate::cheats::Cheat::Ram { bank: Some(_), .. } if !gb.bus.cgb_mode => {
                    Err("bank codes need a Game Boy Color game".to_string())
                }
                c => Ok(c),
            });
            match parsed {
                Ok(c) => list.push(c),
                Err(e) => {
                    self.last_error = Some(format!("{code}: {e}"));
                    return false;
                }
            }
        }
        gb.bus.cheats.set(list);
        self.last_error = None;
        true
    }

    /// Plug a Game Boy Printer into the serial port (solo play; never on a linked console).
    pub fn set_printer_connected(&mut self, on: bool) {
        if let Some(gb) = &mut self.gb {
            if on != gb.bus.serial.printer.is_some() {
                gb.bus.serial.printer = on.then(crate::printer::Printer::new);
            }
        }
    }

    /// The oldest finished print, or an empty array: `[margins, exposure, shades...]`, 160 shades
    /// (0 white to 3 black) per row. Margins: high nibble feeds before, low nibble after.
    pub fn printer_take_job(&mut self) -> Vec<u8> {
        self.gb.as_mut()
            .and_then(|gb| gb.bus.serial.printer.as_mut())
            .and_then(|p| p.jobs.pop_front())
            .unwrap_or_default()
    }

    /// True when the cartridge has a rumble motor (MBC5 types 0x1C-0x1E).
    pub fn has_rumble(&self) -> bool {
        self.gb.as_ref().map_or(false, |gb| gb.bus.cartridge.has_rumble())
    }

    /// Share of the emulated time the motor ran since the last call, 0 to 1.
    pub fn take_rumble(&mut self) -> f32 {
        self.gb.as_mut().map_or(0.0, |gb| gb.bus.cartridge.take_rumble())
    }

    /// True when the cartridge has an MBC7 accelerometer (type 0x22): feed it with `set_tilt`.
    pub fn has_tilt(&self) -> bool {
        self.gb.as_ref().map_or(false, |gb| gb.bus.cartridge.has_tilt())
    }

    /// Tilt in g (x > 0 = right side down, y > 0 = top side down), clamped to ±2 and held until the
    /// next call. A no-op without a game or on other cartridges.
    pub fn set_tilt(&mut self, x: f32, y: f32) {
        if let Some(gb) = self.gb.as_mut() { gb.bus.cartridge.set_tilt(x, y); }
    }

    // Remote link cable (the partner is on another machine; see serial.rs). While a transfer this
    // console clocks waits for the partner's byte, run_frame returns early and link_stalled() is true.

    pub fn set_link_remote(&mut self, on: bool) {
        if let Some(gb) = &mut self.gb {
            gb.bus.serial.set_remote(on);
        }
    }

    pub fn link_stalled(&self) -> bool {
        self.gb.as_ref().map_or(false, |gb| gb.bus.serial.stalled())
    }

    /// Once per transfer this console clocks: `byte | cycles << 8` for the partner, -1 if none.
    pub fn link_take_request(&mut self) -> i32 {
        self.gb.as_mut().and_then(|gb| gb.bus.serial.take_request()).map_or(-1, |(b, c)| b as i32 | (c as i32) << 8)
    }

    /// The partner's answer to our transfer.
    pub fn link_remote_reply(&mut self, byte: u8) {
        if let Some(gb) = &mut self.gb {
            gb.bus.serial.remote_reply(byte);
        }
    }

    /// The partner clocks a byte into this console; the answer comes out of link_take_reply().
    pub fn link_remote_clock(&mut self, byte: u8, cycles: u32) {
        if let Some(gb) = &mut self.gb {
            gb.bus.serial.remote_clock(byte, cycles);
        }
    }

    /// Our answer to the partner's transfer, once: the byte, or -1 if none yet.
    pub fn link_take_reply(&mut self) -> i32 {
        self.gb.as_mut().and_then(|gb| gb.bus.serial.take_reply()).map_or(-1, |b| b as i32)
    }

    pub fn vram_ptr(&self) -> *const u8 {
        self.gb.as_ref()
            .map_or(std::ptr::null(), |gb| gb.bus.ppu.vram.as_ptr())
    }

    pub fn get_bgp(&self) -> u8 {
        self.gb.as_ref().map_or(0, |gb| gb.bus.ppu.bgp)
    }

    /// The 160 bytes of OAM (40 entries of Y, X, tile, flags). Null without a ROM.
    pub fn oam_ptr(&self) -> *const u8 {
        self.gb.as_ref().map_or(std::ptr::null(), |gb| gb.bus.ppu.oam.as_ptr())
    }

    /// The 64 bytes of CGB background palette RAM (8 palettes × 4 RGB555 colors). Null without a ROM.
    pub fn cram_bg_ptr(&self) -> *const u8 {
        self.gb.as_ref().map_or(std::ptr::null(), |gb| gb.bus.ppu.bg_cram.as_ptr())
    }

    /// The 64 bytes of CGB object palette RAM. Null without a ROM.
    pub fn cram_obj_ptr(&self) -> *const u8 {
        self.gb.as_ref().map_or(std::ptr::null(), |gb| gb.bus.ppu.obj_cram.as_ptr())
    }

    /// LCDC, STAT, SCY, SCX, LY, LYC, BGP, OBP0, OBP1, WY, WX, VBK as the CPU reads them. Empty without a ROM.
    pub fn get_lcd_regs(&self) -> Vec<u8> {
        const REGS: [u16; 12] = [0xFF40, 0xFF41, 0xFF42, 0xFF43, 0xFF44, 0xFF45, 0xFF47, 0xFF48, 0xFF49, 0xFF4A, 0xFF4B, 0xFF4F];
        self.gb.as_ref().map_or(Vec::new(), |gb| REGS.iter().map(|&a| gb.bus.read_byte(a)).collect())
    }

    // Layer trace (see trace.rs for every buffer's layout). Off by default; the pointers below
    // move after every finished frame, so read them again after each run_frame.

    pub fn set_trace_enabled(&mut self, on: bool) {
        if let Some(gb) = &mut self.gb {
            gb.bus.ppu.set_tracing(on);
        }
    }

    pub fn trace_enabled(&self) -> bool {
        self.tracer().is_some()
    }

    /// Number of the last finished traced frame (0: none yet).
    pub fn trace_frame(&self) -> u32 {
        self.tracer().map_or(0, |t| t.frames)
    }

    /// Header, per-scanline records and the VBlank VRAM/OAM/palette snapshot.
    pub fn frame_meta_ptr(&self) -> *const u8 {
        self.tracer().map_or(std::ptr::null(), |t| t.done.meta.as_ptr())
    }

    pub fn frame_meta_len(&self) -> usize {
        crate::trace::META_LEN
    }

    /// RGBA planes, `layer_len()` bytes each: the shown frame, BG, window, OBJ.
    pub fn layer_final_ptr(&self) -> *const u8 {
        self.tracer().map_or(std::ptr::null(), |t| t.done.final_.as_ptr())
    }

    pub fn layer_bg_ptr(&self) -> *const u8 {
        self.tracer().map_or(std::ptr::null(), |t| t.done.bg.as_ptr())
    }

    pub fn layer_win_ptr(&self) -> *const u8 {
        self.tracer().map_or(std::ptr::null(), |t| t.done.win.as_ptr())
    }

    pub fn layer_obj_ptr(&self) -> *const u8 {
        self.tracer().map_or(std::ptr::null(), |t| t.done.obj.as_ptr())
    }

    /// 4 bytes per pixel: `[layer, OAM slot, colour ids, OBJ attr]`.
    pub fn layer_info_ptr(&self) -> *const u8 {
        self.tracer().map_or(std::ptr::null(), |t| t.done.info.as_ptr())
    }

    pub fn layer_len(&self) -> usize {
        FRAMEBUFFER_SIZE
    }

    /// Computes the exact motion field of the last frame against the one before it.
    /// `mode`: 0 shown pixel, 1 BG plane, 2 window plane, 3 OBJ plane. Then read `motion_ptr()`:
    /// `(dx, dy)` as i8 per pixel (the pixel was at `(x + dx, y + dy)`), -128 = unknown.
    pub fn compute_motion(&mut self, mode: u8) -> bool {
        let Some(t) = self.gb.as_mut().and_then(|gb| gb.bus.ppu.trace.as_deref_mut()) else { return false };
        t.compute_motion(mode);
        true
    }

    pub fn motion_ptr(&self) -> *const i8 {
        self.tracer().filter(|t| !t.motion.is_empty()).map_or(std::ptr::null(), |t| t.motion.as_ptr())
    }

    pub fn motion_len(&self) -> usize {
        crate::trace::PIXELS * 2
    }
}

impl Emulator {
    fn sgb(&self) -> Option<&crate::sgb::Sgb> {
        self.gb.as_ref()?.bus.sgb.as_deref()
    }

    fn set_player_button(&mut self, player: u8, button: JoypadButton, pressed: bool) {
        let Some(s) = self.gb.as_mut().and_then(|gb| gb.bus.sgb.as_deref_mut()) else { return };
        let Some(pad) = s.pads.get_mut((player as usize).wrapping_sub(1)) else { return };
        let (i, bit) = (button as u8 / 4, button as u8 % 4);
        let i = 1 - i as usize; // JoypadButton: A B Select Start (buttons), then the d-pad
        if pressed { pad[i] &= !(1 << bit); } else { pad[i] |= 1 << bit; }
    }

    fn tracer(&self) -> Option<&crate::trace::Tracer> {
        self.gb.as_ref()?.bus.ppu.trace.as_deref()
    }
}
