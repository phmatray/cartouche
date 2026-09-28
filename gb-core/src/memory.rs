use crate::apu::Apu;
use crate::boot_rom::DMG_BOOT_ROM;
use crate::cartridge::Cartridge;
use crate::interrupts::{InterruptController, JOYPAD_BIT, SERIAL_BIT, STAT_BIT, TIMER_BIT, VBLANK_BIT};
use crate::joypad::Joypad;
use crate::ppu::Ppu;
use crate::serial::Serial;
use crate::timer::Timer;

pub struct MemoryBus {
    pub cartridge: Cartridge,
    pub ppu: Ppu,
    pub timer: Timer,
    pub interrupts: InterruptController,
    pub joypad: Joypad,
    pub apu: Apu,
    pub serial: Serial,
    /// Super Game Boy mode (packets over P1, palettes, border).
    pub sgb: Option<Box<crate::sgb::Sgb>>,
    /// 256 bytes (DMG) or 0x900 (CGB: $0000-$00FF and $0200-$08FF).
    pub boot_rom: &'static [u8],
    pub boot_rom_active: bool,
    /// KEY0 ($FF4C), written by the CGB boot ROM only: bit 2 = run the cartridge as a DMG
    /// ("compatibility mode") once the boot ROM unmaps itself.
    pub(crate) key0: u8,
    /// 32 KB WRAM (8 banks x 4 KB); DMG uses banks 0+1 only
    pub wram: [u8; 0x8000],
    /// Currently mapped WRAM bank for 0xD000-0xDFFF (1-7; writing 0 selects bank 1)
    pub wram_bank: u8,
    pub hram: [u8; 0x7F],
    pub cycle_count: u32,
    // OAM DMA state: a $FF46 write starts a transfer after one M-cycle, which then copies one
    // byte per M-cycle for 160 M-cycles; the bus is blocked (`dma_active`) while bytes move.
    pub(crate) dma_active: bool,
    /// M-cycles until a written transfer (re)starts: 2 on the write, 0 when none is pending.
    pub(crate) dma_delay: u8,
    /// Next byte of the running transfer (160 = the last one moved; it ends on the next M-cycle).
    pub(crate) dma_index: u8,
    /// Last value written to $FF46: the page the transfer reads from.
    pub(crate) dma_source: u8,
    /// Whether the ROM is CGB compatible
    pub cgb_mode: bool,
    /// KEY1 speed-switch register (bit 0 = switch armed)
    pub(crate) key1: u8,
    /// Whether the CPU is running at double speed (CGB only)
    pub double_speed: bool,
    // CGB HDMA/GDMA
    pub hdma5: u8,
    pub(crate) hdma_active: bool,
    pub(crate) hdma_source: u16,
    pub(crate) hdma_dest: u16,
    pub(crate) hdma_remaining: u8,
    /// RP ($FF56, CGB): bit 0 = LED on, bits 6-7 = read enable (both set: bit 1 shows the sensor).
    pub(crate) rp: u8,
    /// Whether the infrared sensor sees light (a linked partner's LED); never set when alone.
    pub ir_light_in: bool,
    /// Active cheat codes (Game Genie ROM patches, GameShark RAM writes).
    pub cheats: crate::cheats::Cheats,
}

impl MemoryBus {
    pub fn new(cartridge: Cartridge, cgb_mode: bool) -> Self {
        let mut ppu = Ppu::new();
        ppu.cgb_mode = cgb_mode;
        Self {
            cartridge,
            ppu,
            timer: Timer::new(),
            interrupts: InterruptController::new(),
            joypad: Joypad::new(),
            apu: Apu::new(),
            serial: Serial::new(),
            sgb: None,
            boot_rom: &DMG_BOOT_ROM,
            boot_rom_active: true,
            key0: 0,
            wram: [0; 0x8000],
            wram_bank: 1,
            hram: [0; 0x7F],
            cycle_count: 0,
            dma_active: false,
            dma_delay: 0,
            dma_index: 0,
            dma_source: 0xFF, // DMA reads $FF at power-on
            cgb_mode,
            key1: 0,
            double_speed: false,
            hdma5: 0xFF,
            hdma_active: false,
            hdma_source: 0,
            hdma_dest: 0,
            hdma_remaining: 0,
            rp: 0,
            ir_light_in: false,
            cheats: Default::default(),
        }
    }

    /// Whether the infrared LED is lit (CGB mode, RP bit 0).
    pub fn ir_led(&self) -> bool {
        self.cgb_mode && self.rp & 1 != 0
    }

    fn wram_read(&self, addr: u16) -> u8 {
        let idx = if addr < 0xD000 {
            (addr - 0xC000) as usize
        } else {
            (self.wram_bank as usize) * 0x1000 + (addr - 0xD000) as usize
        };
        self.wram[idx]
    }

    fn wram_write(&mut self, addr: u16, value: u8) {
        let idx = if addr < 0xD000 {
            (addr - 0xC000) as usize
        } else {
            (self.wram_bank as usize) * 0x1000 + (addr - 0xD000) as usize
        };
        self.wram[idx] = value;
    }

    /// Whether a CPU read collides with the running OAM DMA: OAM itself, or an address on
    /// the bus the DMA reads from. Buses: VRAM, the external one (ROM, cartridge RAM, and WRAM
    /// on a Game Boy) and, on a Game Boy Color, WRAM's own. I/O and HRAM stay reachable, so a
    /// DMA from VRAM (or from WRAM on a Color) leaves ROM fetches alone. The Color quirks
    /// follow SameBoy: WRAM is busy unless the DMA reads VRAM, and a DMA from echo RAM
    /// ($E000+) blocks everything but VRAM.
    fn dma_conflict(&self, addr: u16) -> bool {
        let cgb = self.cgb_mode || self.ppu.compat; // Color hardware, whatever the mode
        let bus = |a: u16| match a { 0x8000..=0x9FFF => 1, 0xC000.. if cgb => 2, _ => 0 };
        let src = (self.dma_source as u16) << 8;
        match addr {
            0xFE00..=0xFEFF => true,
            0xFF00.. => false,
            0xC000.. if cgb => bus(src) != 1,
            _ if cgb && src >= 0xE000 => bus(addr) != 1,
            _ => bus(addr) == bus(src),
        }
    }

    /// A byte at a RetroAchievements address (rcheevos consoleinfo.c): the bus, except that $A000-$BFFF is cartridge
    /// RAM bank 0 and $D000-$DFFF work RAM bank 1 whatever is paged in; $10000-$15FFF are the Color's work RAM banks 2-7,
    /// $16000-$33FFF cartridge RAM banks 1-15. 0 outside.
    pub fn read_ra(&self, addr: u32) -> u8 {
        let ram = |i: u32| self.cartridge.ram_byte(i as usize);
        match addr {
            0xA000..=0xBFFF => ram(addr - 0xA000).unwrap_or_else(|| self.read_byte(addr as u16)),
            0xD000..=0xDFFF => self.wram[(addr - 0xC000) as usize],
            0x0000..=0xFFFF => self.read_byte(addr as u16),
            0x10000..=0x15FFF if self.cgb_mode => self.wram[(addr - 0x10000 + 0x2000) as usize],
            0x16000..=0x33FFF => ram(addr - 0x16000 + 0x2000).unwrap_or(0),
            _ => 0,
        }
    }

    pub fn read_byte(&self, addr: u16) -> u8 {
        if self.dma_active && self.dma_conflict(addr) {
            return 0xFF;
        }
        self.peek(addr)
    }

    /// The byte at `addr`, ignoring a running OAM DMA.
    fn peek(&self, addr: u16) -> u8 {
        match addr {
            0x0000..=0x7FFF => {
                if self.boot_rom_active && (addr < 0x100 || (0x200..self.boot_rom.len()).contains(&(addr as usize))) {
                    self.boot_rom[addr as usize]
                } else if self.cheats.rom_is_empty() {
                    self.cartridge.read_rom(addr)
                } else {
                    self.cheats.patch_rom(addr, self.cartridge.read_rom(addr))
                }
            }
            0x8000..=0x9FFF => self.ppu.read_vram(addr - 0x8000),
            0xA000..=0xBFFF => self.cartridge.read_ram(addr - 0xA000),
            0xC000..=0xDFFF => self.wram_read(addr),
            0xE000..=0xFDFF => self.wram_read(addr - 0x2000),
            0xFE00..=0xFE9F => self.ppu.read_oam(addr - 0xFE00),
            0xFEA0..=0xFEFF => 0xFF,
            0xFF00 => self.sgb.as_ref().and_then(|s| s.read_p1(self.joypad.select)).unwrap_or_else(|| self.joypad.read()),
            0xFF01 => self.serial.read(addr),
            // SC: unused bits read 1, and bit 1 (the fast clock) exists in Color mode only.
            0xFF02 => self.serial.read(addr) | if self.cgb_mode { 0x7C } else { 0x7E },
            0xFF04..=0xFF07 => self.timer.read(addr),
            0xFF0F => self.interrupts.interrupt_flag | 0xE0, // bits 5-7 unused, read as 1
            0xFF10..=0xFF3F => self.apu.read_register(addr),
            0xFF46 => self.dma_source,
            0xFF40..=0xFF4B => self.ppu.read_register(addr),
            0xFF4D => {
                if self.cgb_mode {
                    ((self.double_speed as u8) << 7) | (self.key1 & 0x01) | 0x7E
                } else {
                    0xFF
                }
            }
            0xFF4F => if self.cgb_mode { self.ppu.read_register(addr) } else { 0xFF },
            // HDMA registers — 0xFF51-0xFF54 are write-only, return 0xFF on read
            0xFF51..=0xFF54 => 0xFF,
            0xFF55 => {
                if self.cgb_mode { self.hdma5 } else { 0xFF }
            }
            // RP: bits 2-5 read 1; bit 1 = 0 only when reading is enabled and light is seen.
            0xFF56 => {
                if self.cgb_mode {
                    let dark = !(self.rp & 0xC0 == 0xC0 && self.ir_light_in);
                    (self.rp & 0xC1) | 0x3C | (dark as u8) << 1
                } else {
                    0xFF
                }
            }
            0xFF68..=0xFF6B => {
                if self.cgb_mode { self.ppu.read_register(addr) } else { 0xFF }
            }
            0xFF70 => {
                if self.cgb_mode { self.wram_bank | 0xF8 } else { 0xFF }
            }
            0xFF80..=0xFFFE => self.hram[(addr - 0xFF80) as usize],
            0xFFFF => self.interrupts.interrupt_enable,
            _ => 0xFF,
        }
    }

    pub fn write_byte(&mut self, addr: u16, value: u8) {
        if self.dma_active && (0xFE00..=0xFEFF).contains(&addr) {
            return; // OAM belongs to the running DMA
        }
        match addr {
            0x0000..=0x7FFF => self.cartridge.write_rom(addr, value),
            0x8000..=0x9FFF => self.ppu.write_vram(addr - 0x8000, value),
            0xA000..=0xBFFF => self.cartridge.write_ram(addr - 0xA000, value),
            0xC000..=0xDFFF => self.wram_write(addr, value),
            0xE000..=0xFDFF => self.wram_write(addr - 0x2000, value),
            0xFE00..=0xFE9F => self.ppu.write_oam(addr - 0xFE00, value),
            0xFEA0..=0xFEFF => {}
            0xFF00 => {
                // Selecting a group whose button is held pulls a line low: a joypad interrupt, as a press would.
                let before = self.joypad.read();
                self.joypad.write(value);
                if before & !self.joypad.read() & 0x0F != 0 { self.interrupts.request(JOYPAD_BIT); }
                if let Some(s) = self.sgb.as_deref_mut() { s.write_p1(value); }
            }
            0xFF01 => self.serial.write(addr, value),
            0xFF02 => self.serial.write(addr, if self.cgb_mode { value } else { value & !0x02 }),
            0xFF04..=0xFF07 => {
                // An overflow requests the interrupt at once, a TIMA write cancelling the reload withdraws it (Timer::step).
                let pending = self.timer.reload_pending;
                self.timer.write(addr, value);
                match (pending, self.timer.reload_pending) {
                    (false, true) => self.interrupts.request(TIMER_BIT),
                    (true, false) => self.interrupts.interrupt_flag &= !TIMER_BIT,
                    _ => {}
                }
            }
            0xFF0F => self.interrupts.interrupt_flag = value & 0x1F,
            0xFF10..=0xFF3F => self.apu.write_register(addr, value),
            0xFF40..=0xFF4B => {
                if addr == 0xFF46 {
                    // A write during a transfer restarts it; the old one holds the bus meanwhile.
                    self.dma_source = value;
                    self.dma_delay = 2;
                } else {
                    self.ppu.write_register(addr, value);
                }
            }
            0xFF4D => {
                if self.cgb_mode {
                    self.key1 = (self.key1 & !0x01) | (value & 0x01);
                }
            }
            0xFF4F => {
                if self.cgb_mode {
                    self.ppu.write_register(addr, value);
                }
            }
            0xFF4C => {
                if self.boot_rom_active && self.cgb_mode {
                    self.key0 = value;
                }
            }
            0xFF50 => {
                if self.boot_rom_active && value != 0 {
                    self.boot_rom_active = false;
                    self.joypad.boot_hold = [0, 0];
                    if self.cgb_mode && self.key0 & 0x04 != 0 {
                        self.enter_compat();
                    }
                }
            }
            // HDMA1-4 write straight into the transfer's address counters, which advance as
            // blocks are copied: restarting via HDMA5 without rewriting them resumes where the
            // previous (cancelled) transfer stopped.
            0xFF51 => self.hdma_source = (self.hdma_source & 0x00F0) | (value as u16) << 8,
            0xFF52 => self.hdma_source = (self.hdma_source & 0xFF00) | (value as u16 & 0xF0),
            0xFF53 => self.hdma_dest = (self.hdma_dest & 0x00F0) | ((value as u16 & 0x1F) << 8),
            0xFF54 => self.hdma_dest = (self.hdma_dest & 0x1F00) | (value as u16 & 0xF0),
            0xFF55 => self.write_hdma5(value),
            0xFF56 => {
                if self.cgb_mode { self.rp = value & 0xC1; }
            }
            0xFF68..=0xFF6B => {
                if self.cgb_mode { self.ppu.write_register(addr, value); }
            }
            0xFF70 => {
                if self.cgb_mode {
                    let bank = value & 0x07;
                    self.wram_bank = if bank == 0 { 1 } else { bank };
                }
            }
            0xFF80..=0xFFFE => self.hram[(addr - 0xFF80) as usize] = value,
            0xFFFF => self.interrupts.interrupt_enable = value,
            _ => {}
        }
    }

    /// A CGB running a DMG cartridge (Pan Docs, "CGB Registers" / KEY0): the CGB registers lock
    /// (VBK, SVBK, palette RAM, HDMA, KEY1) and the PPU draws like a DMG, with BGP/OBP0/OBP1
    /// picking colours from the palettes the boot ROM left in BG palette 0 and OBJ palettes 0-1.
    pub(crate) fn enter_compat(&mut self) {
        self.cgb_mode = false;
        self.ppu.cgb_mode = false;
        self.ppu.compat = true;
        self.ppu.vram_bank = 0;
        self.wram_bank = 1;
    }

    /// Attempt a CGB speed switch (triggered by STOP with KEY1 bit 0 armed).
    pub fn try_speed_switch(&mut self) -> bool {
        if !self.cgb_mode || self.key1 & 0x01 == 0 {
            return false;
        }
        self.double_speed = !self.double_speed;
        self.key1 = 0;
        // Pan Docs, "CGB Registers": DIV resets and the CPU waits 2050 M-cycles for the clock to settle.
        self.timer.write(0xFF04, 0);
        for _ in 0..2050 {
            self.stop_tick();
        }
        true
    }

    /// STOP entered: DIV resets and the LCD shows blank until a button wakes the CPU.
    pub fn enter_stop(&mut self) {
        self.write_byte(0xFF04, 0);
        self.ppu.blank();
    }

    /// An M-cycle in stop mode: the clock is off (no PPU, timer, DMA or sound), only time passes.
    pub fn stop_tick(&mut self) {
        let t = if self.double_speed { 2 } else { 4 };
        self.apu.silence(t);
        self.cycle_count += t;
    }

    pub fn serial_output(&self) -> &[u8] {
        self.serial.serial_output()
    }

    pub fn clear_serial_output(&mut self) {
        self.serial.clear_serial_output();
    }

    fn tick_components(&mut self) {
        let ppu_step = if self.double_speed { 2 } else { 4 };
        let (vblank_irq, stat_irq, hblank_entry) = self.ppu.step(ppu_step);
        if vblank_irq {
            self.interrupts.request(VBLANK_BIT);
            if let Some(s) = self.sgb.as_deref_mut() { s.vblank(&self.ppu.framebuffer, self.apu.read_register(0xFF26) & 0x0F != 0); }
        }
        if stat_irq {
            self.interrupts.request(STAT_BIT);
        }
        if hblank_entry && self.hdma_active {
            self.hdma_step();
            self.dma_stall();
        }
        if self.timer.step(4) {
            self.interrupts.request(TIMER_BIT);
        }
        if self.serial.tick(4) {
            self.interrupts.request(SERIAL_BIT);
        }
        self.cartridge.tick();
        self.apu.cgb_mode = self.cgb_mode || self.ppu.compat; // CGB hardware, whatever the mode
        if let Some((l, r)) = self.sgb.as_deref_mut().and_then(|s| s.audio.run(ppu_step)) {
            self.apu.mix_external(l, r);
        }
        self.apu.step(ppu_step);
        self.cycle_count += ppu_step;

        self.dma_tick();
    }

    /// One M-cycle of OAM DMA.
    fn dma_tick(&mut self) {
        if self.dma_delay > 0 {
            self.dma_delay -= 1;
            if self.dma_delay > 0 {
                return; // the start-up M-cycle: nothing moves
            }
            self.dma_active = true;
            self.dma_index = 0;
        }
        if !self.dma_active {
            return;
        }
        if self.dma_index >= 0xA0 {
            self.dma_active = false;
            return;
        }
        // Pages $E0-$FF read work RAM, like echo RAM.
        let src = (self.dma_source as u16) << 8 | self.dma_index as u16;
        let byte = self.peek(if src >= 0xE000 { src - 0x2000 } else { src });
        self.ppu.write_oam(self.dma_index as u16, byte);
        self.dma_index += 1;
    }

    pub fn cycle_tick(&mut self) {
        self.tick_components();
    }

    pub fn cycle_read(&mut self, addr: u16) -> u8 {
        self.tick_components();
        if (0xFE00..=0xFEFF).contains(&addr) { self.ppu.oam_bug_read(); }
        self.read_byte(addr)
    }

    /// Read whose address register is incremented/decremented in the same
    /// M-cycle (LD A,(HL+/-), POP).
    pub fn cycle_read_inc(&mut self, addr: u16) -> u8 {
        self.tick_components();
        if (0xFE00..=0xFEFF).contains(&addr) { self.ppu.oam_bug_read_inc(); }
        self.read_byte(addr)
    }

    pub fn cycle_write(&mut self, addr: u16, value: u8) {
        self.tick_components();
        if (0xFE00..=0xFEFF).contains(&addr) { self.ppu.oam_bug_write(); }
        self.write_byte(addr, value);
    }

    /// Internal M-cycle in which the 16-bit IDU increments/decrements `addr`
    /// (INC/DEC rr, the first cycle of PUSH/CALL/RST).
    pub fn cycle_idu(&mut self, addr: u16) {
        self.tick_components();
        if (0xFE00..=0xFEFF).contains(&addr) { self.ppu.oam_bug_write(); }
    }

    /// Handle writes to HDMA5 (0xFF55) — triggers GDMA or starts HDMA.
    fn write_hdma5(&mut self, value: u8) {
        if !self.cgb_mode {
            return;
        }
        if self.hdma_active && value & 0x80 == 0 {
            // Writing bit 7 = 0 during an HBlank DMA cancels it; HDMA5 then reads bit 7 = 1
            // with the remaining length. (Writing bit 7 = 1 restarts it with the new length.)
            self.hdma_active = false;
            self.hdma5 = 0x80 | (self.hdma_remaining.wrapping_sub(1) & 0x7F);
            return;
        }
        self.hdma_remaining = (value & 0x7F) + 1;
        // While a transfer is pending HDMA5 reads bit 7 = 0 plus the remaining length.
        self.hdma5 = value & 0x7F;

        if value & 0x80 == 0 {
            // GDMA: transfer all blocks immediately; the CPU is stalled meanwhile.
            while self.hdma_remaining > 0 {
                self.hdma_step();
                self.dma_stall();
            }
        } else {
            // HDMA: one 16-byte block per HBlank, the first one right away if the PPU is
            // already in HBlank (which includes the LCD being off).
            self.hdma_active = true;
            if self.ppu.mode == crate::ppu::PpuMode::HBlank {
                self.hdma_step();
                self.dma_stall();
            }
        }
    }

    /// The CPU is stalled while a 16-byte block is copied: 8 M-cycles at normal speed,
    /// 16 at double speed (the same wall-clock time).
    fn dma_stall(&mut self) {
        for _ in 0..if self.double_speed { 16 } else { 8 } {
            self.tick_components();
        }
    }

    /// Transfer one 16-byte HDMA block from source to VRAM.
    fn hdma_step(&mut self) {
        for i in 0..16u16 {
            let byte = self.read_byte(self.hdma_source.wrapping_add(i));
            self.ppu.write_vram((self.hdma_dest + i) & 0x1FFF, byte);
        }
        self.hdma_source = self.hdma_source.wrapping_add(16);
        self.hdma_dest = (self.hdma_dest + 16) & 0x1FF0;
        self.hdma_remaining -= 1;
        if self.hdma_remaining == 0 {
            self.hdma_active = false;
            self.hdma5 = 0xFF; // inactive, no blocks remaining
        } else {
            self.hdma5 = (self.hdma_remaining - 1) & 0x7F; // active (bit 7 = 0)
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn bus() -> MemoryBus {
        let mut rom = vec![0u8; 0x8000];
        rom[0x14D] = (0x134..=0x14C).fold(0u8, |c, i| c.wrapping_sub(rom[i]).wrapping_sub(1));
        let mut bus = MemoryBus::new(Cartridge::from_rom(rom).unwrap(), false);
        bus.boot_rom_active = false;
        for i in 0..0xA0 {
            bus.write_byte(0xC000 + i, i as u8 + 1);
            bus.write_byte(0xC100 + i, 0x80 | i as u8);
        }
        bus
    }

    #[test]
    fn oam_dma_copies_one_byte_per_m_cycle_after_a_delay() {
        let mut bus = bus();
        bus.write_byte(0xFF46, 0xC0);
        assert_eq!(bus.read_byte(0xFF46), 0xC0);
        bus.cycle_tick();
        assert_eq!(bus.read_byte(0xFE00), 0x00, "start-up M-cycle: OAM still readable, nothing copied");
        bus.cycle_tick();
        assert_eq!(bus.read_byte(0xFE00), 0xFF, "transfer running: OAM blocked");
        assert_eq!(bus.ppu.read_oam(0), 0x01);
        assert_eq!(bus.ppu.read_oam(1), 0x00);
        for _ in 0..9 { bus.cycle_tick(); }
        assert_eq!(bus.ppu.read_oam(9), 0x0A);
        assert_eq!(bus.ppu.read_oam(10), 0x00);
        for _ in 0..150 { bus.cycle_tick(); }
        assert_eq!(bus.ppu.read_oam(159), 0xA0);
        assert_eq!(bus.read_byte(0xFE00), 0xFF, "the M-cycle of the last byte is still blocked");
        bus.cycle_tick();
        assert_eq!(bus.read_byte(0xFE00), 0x01, "done");
    }

    #[test]
    fn speed_switch_resets_div_and_pauses() {
        let mut bus = bus();
        bus.cgb_mode = true;
        for _ in 0..100 { bus.cycle_tick(); }
        assert_ne!(bus.read_byte(0xFF04), 0);
        bus.write_byte(0xFF4D, 0x01);
        assert_eq!(bus.read_byte(0xFF4D), 0x7F, "armed, normal speed");
        bus.cycle_count = 0;
        assert!(bus.try_speed_switch());
        assert_eq!(bus.read_byte(0xFF4D), 0xFE, "double speed, disarmed");
        assert_eq!(bus.read_byte(0xFF04), 0, "DIV reset, and still while the clock settles");
        assert_eq!(bus.cycle_count, 2050 * 2, "2050 M-cycles at the new speed");
    }

    #[test]
    fn oam_dma_restart_starts_over() {
        let mut bus = bus();
        bus.write_byte(0xFF46, 0xC0);
        for _ in 0..12 { bus.cycle_tick(); }
        bus.write_byte(0xFF46, 0xC1);
        bus.cycle_tick();
        assert_eq!(bus.read_byte(0xFE00), 0xFF, "the old transfer holds the bus during the new start-up");
        bus.cycle_tick();
        assert_eq!(bus.ppu.read_oam(0), 0x80, "restarted from byte 0 with the new page");
        for _ in 0..160 { bus.cycle_tick(); }
        assert_eq!(bus.read_byte(0xFE9F), 0x80 | 0x9F);
    }
}
