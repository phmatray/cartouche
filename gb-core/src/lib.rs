pub mod apu;
pub mod boot_rom;
pub mod cartridge;
pub mod cpu;
pub mod error;
pub mod gameboy;
pub mod interrupts;
pub mod joypad;
pub mod memory;
pub mod ppu;
pub mod registers;
pub mod serial;
pub mod timer;

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

    pub fn load_rom(&mut self, rom_data: &[u8]) -> bool {
        match GameBoy::new(rom_data.to_vec()) {
            Ok(mut gb) => {
                // No boot ROM is shipped: start directly in the post-boot state.
                gb.skip_boot_rom();
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
            match gb.step_instruction() {
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

    pub fn framebuffer_ptr(&self) -> *const u8 {
        if let Some(gb) = &self.gb {
            gb.bus.ppu.framebuffer.as_ptr()
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

    pub fn is_rom_loaded(&self) -> bool {
        self.gb.is_some()
    }

    /// True when the loaded cartridge runs in Game Boy Color mode (header byte 0x143, bit 7).
    pub fn is_cgb(&self) -> bool {
        self.gb.as_ref().map_or(false, |gb| gb.cgb_mode)
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

    pub fn load_state(&mut self, data: &[u8]) -> bool {
        if let Some(gb) = &mut self.gb {
            gb.load_state(data)
        } else {
            false
        }
    }

    /// Get a copy of the current framebuffer for save state thumbnails
    pub fn framebuffer_snapshot(&self) -> Vec<u8> {
        self.gb.as_ref()
            .map_or(Vec::new(), |gb| gb.bus.ppu.framebuffer.to_vec())
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

    pub fn vram_ptr(&self) -> *const u8 {
        self.gb.as_ref()
            .map_or(std::ptr::null(), |gb| gb.bus.ppu.vram.as_ptr())
    }

    pub fn get_bgp(&self) -> u8 {
        self.gb.as_ref().map_or(0, |gb| gb.bus.ppu.bgp)
    }
}
