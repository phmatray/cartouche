use wasm_bindgen::prelude::*;

#[wasm_bindgen]
#[derive(Clone, Copy, Debug)]
pub enum JoypadButton {
    A,
    B,
    Select,
    Start,
    Right,
    Left,
    Up,
    Down,
}

pub struct Joypad {
    pub select: u8,
    pub button_state: u8, // bits 0-3: A, B, Select, Start (0=pressed)
    pub dpad_state: u8,   // bits 0-3: Right, Left, Up, Down (0=pressed)
}

impl Joypad {
    pub fn new() -> Self {
        Self {
            select: 0x30,
            button_state: 0x0F, // all released
            dpad_state: 0x0F,   // all released
        }
    }

    pub fn read(&self) -> u8 {
        let mut result = self.select | 0xC0;

        if self.select & 0x10 == 0 {
            result = (result & 0xF0) | (self.dpad_state & 0x0F);
        }
        if self.select & 0x20 == 0 {
            result = (result & 0xF0) | (self.button_state & 0x0F);
        }

        result
    }

    pub fn write(&mut self, value: u8) {
        self.select = value & 0x30;
    }

    /// Set a button's pressed state. Returns true if a joypad interrupt
    /// should be requested (high-to-low transition on a selected input).
    pub fn set_button(&mut self, button: JoypadButton, pressed: bool) -> bool {
        let old_read = self.read() & 0x0F;

        let (state, bit) = match button {
            JoypadButton::A => (&mut self.button_state, 0),
            JoypadButton::B => (&mut self.button_state, 1),
            JoypadButton::Select => (&mut self.button_state, 2),
            JoypadButton::Start => (&mut self.button_state, 3),
            JoypadButton::Right => (&mut self.dpad_state, 0),
            JoypadButton::Left => (&mut self.dpad_state, 1),
            JoypadButton::Up => (&mut self.dpad_state, 2),
            JoypadButton::Down => (&mut self.dpad_state, 3),
        };

        if pressed {
            *state &= !(1 << bit);
        } else {
            *state |= 1 << bit;
        }

        let new_read = self.read() & 0x0F;
        // Interrupt on any high-to-low transition (bit was 1, now 0)
        (old_read & !new_read) != 0
    }
}
