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
    /// After an odd number of switches into double speed with the APU on, the DIV-APU event
    /// reaches the APU one M-cycle late until it is powered off (Age spsw-ch2-lc-delay).
    pub(crate) apu_event_late: bool,
    /// A DIV-APU event held back that M-cycle (`Some(from a DIV write)`), delivered with the next one.
    pub(crate) apu_event_due: Option<bool>,
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
    /// Debugger watchpoints; `None` unless one is set, so the CPU accessors pay one check.
    pub watch: Option<Box<crate::debug::WatchSet>>,
    /// The hardware revision (`GameBoy::set_revision`), for subsystems to read as a plain field.
    pub rev: crate::gameboy::Revision,
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
            apu_event_late: false,
            apu_event_due: None,
            hdma5: 0xFF,
            hdma_active: false,
            hdma_source: 0,
            hdma_dest: 0,
            hdma_remaining: 0,
            rp: 0,
            ir_light_in: false,
            cheats: Default::default(),
            watch: None,
            rev: crate::gameboy::Revision::Default,
        }
    }

    /// Whether an infrared LED is lit: RP bit 0 in CGB mode, or a HuC1/HuC3 cartridge's own.
    pub fn ir_led(&self) -> bool {
        self.cgb_mode && self.rp & 1 != 0 || self.cartridge.ir_led()
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
            // On a Game Boy the CPU sees the byte the DMA reads this M-cycle; OAM itself, and
            // every conflict on Color hardware (as SameBoy), read $FF.
            if addr >= 0xFE00 || self.cgb_mode || self.ppu.compat {
                return 0xFF;
            }
            return self.peek(self.dma_src(self.dma_index.saturating_sub(1)));
        }
        self.peek(addr)
    }

    /// The address the OAM DMA reads byte `i` from; pages $E0-$FF read work RAM, like echo RAM.
    fn dma_src(&self, i: u8) -> u16 {
        let src = (self.dma_source as u16) << 8 | i as u16;
        if src >= 0xE000 { src - 0x2000 } else { src }
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
            0xA000..=0xBFFF => self.cartridge.read_ram_lit(addr - 0xA000, self.ir_light_in),
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
            0xFF10..=0xFF3F | 0xFF76 | 0xFF77 => self.apu.read_register(addr),
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
            0xFF68..=0xFF6C => {
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
            0xFF01 => self.serial.write(addr, value, self.timer.div_counter),
            0xFF02 => self.serial.write(addr, if self.cgb_mode { value } else { value & !0x02 }, self.timer.div_counter),
            0xFF04..=0xFF07 => {
                // An overflow requests the interrupt at once, a TIMA write cancelling the reload withdraws it (Timer::step).
                let (pending, div) = (self.timer.reload_pending, self.timer.div_counter);
                self.timer.write(addr, value);
                self.div_apu_edge(div, true);
                match (pending, self.timer.reload_pending) {
                    (false, true) => self.interrupts.request(TIMER_BIT),
                    (true, false) => self.interrupts.interrupt_flag &= !TIMER_BIT,
                    _ => {}
                }
            }
            0xFF0F => self.interrupts.interrupt_flag = value & 0x1F,
            0xFF10..=0xFF3F => {
                let was_on = self.apu.is_on();
                self.apu.write_register(addr, value);
                if !self.apu.is_on() { (self.apu_event_late, self.apu_event_due) = (false, None); }
                // Powered on while DIV's APU bit is set: the first DIV-APU event is skipped.
                if !was_on && self.apu.is_on() && self.timer.div_counter & self.div_apu_bit() != 0 {
                    self.apu.skip_first_div_event();
                }
            }
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
            0xFF68..=0xFF6C => {
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
        // STOP's second M-cycle reads the byte after it; DIV resets at the end of the next one.
        self.tick_components();
        let earlier = self.timer.div_counter;
        self.tick_components();
        let div = self.timer.div_counter;
        self.timer.speed_switch_div_reset(earlier);
        // The reset can drop DIV's APU bit (old speed), seen one M-cycle late like the 4 KHz timer
        // input: a bit that only just rose does not count (Age spsw-ch2-lc-delay).
        self.div_apu_edge(div & earlier, true);
        self.double_speed = !self.double_speed;
        if self.double_speed && self.apu.is_on() { self.apu_event_late = !self.apu_event_late; }
        self.ppu.m_cycle_dots = if self.double_speed { 2 } else { 4 };
        self.key1 = 0;
        // Then the CPU halts while the clock settles and everything else runs: $20000 DIV counts,
        // so DIV is back at 0 when it resumes (Age spsw-div, spsw-tima). Like HALT, an interrupt
        // ends it early (Age spsw-interrupts). Back in single speed the PPU comes out one dot
        // behind (Age spsw-mode0: the LCD-to-CPU alignment shifts).
        // An interrupt already pending skips that pause, but the divider still stops for two
        // M-cycles while the oscillator restarts (Age spsw-interrupts, CGB B/C).
        if self.interrupts.pending() & !self.late_interrupts() != 0 {
            self.timer.div_hold = 2;
            return true;
        }
        let mut behind = !self.double_speed;
        for _ in 0..0x8000 {
            self.tick_components();
            // Taken back once the PPU is a dot into a mode, so no mode change is undone.
            if behind && self.ppu.mode_clock > 0 {
                self.ppu.mode_clock -= 1;
                behind = false;
            }
            if self.interrupts.pending() & !self.late_interrupts() != 0 { break; }
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
        self.cartridge.tick_clock(t as u64);
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
        let div = self.timer.div_counter;
        if self.timer.step(4) {
            self.interrupts.request(TIMER_BIT);
        }
        self.div_apu_edge(div, false);
        if self.serial.tick(4) {
            self.interrupts.request(SERIAL_BIT);
        }
        self.cartridge.tick();
        self.cartridge.tick_clock(ppu_step as u64);
        self.apu.cgb_mode = self.cgb_mode || self.ppu.compat; // CGB hardware, whatever the mode
        self.apu.double_speed = self.double_speed;
        if let Some((l, r)) = self.sgb.as_deref_mut().and_then(|s| s.audio.run(ppu_step)) {
            self.apu.mix_external(l, r);
        }
        self.apu.step(ppu_step / 2); // 2 MHz ticks
        self.cycle_count += ppu_step;

        self.dma_tick();
    }

    /// The DIV-APU event: DIV bit 4 (bit 5 in double speed) fell since the counter read `old`,
    /// whether it counted there or was reset by a `write`; its rise arms the envelopes.
    #[inline]
    fn div_apu_edge(&mut self, old: u16, write: bool) {
        let (new, bit) = (self.timer.div_counter, self.div_apu_bit());
        let fell = old & !new & bit != 0;
        if fell | self.apu_event_late {
            self.deliver_div_event(fell.then_some(write));
        }
        // The rise is not held back: only the falling edge is measured late (spsw-ch2-lc-delay).
        if !old & new & bit != 0 {
            self.apu.div_secondary_event();
        }
    }

    /// Kept out of the per-M-cycle path: one event every 2048 or more M-cycles.
    #[inline(never)]
    fn deliver_div_event(&mut self, mut event: Option<bool>) {
        if self.apu_event_late {
            event = std::mem::replace(&mut self.apu_event_due, event);
        }
        if let Some(write) = event {
            self.apu.div_event(write);
        }
    }

    /// DIV bit 4 (bit 5 in double speed), in the timer's internal counter.
    fn div_apu_bit(&self) -> u16 {
        if self.double_speed { 0x2000 } else { 0x1000 }
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
        let byte = self.peek(self.dma_src(self.dma_index));
        self.ppu.write_oam(self.dma_index as u16, byte);
        self.dma_index += 1;
    }

    /// IF bits whose line rises only at the end of this M-cycle. A halted CPU samples IF
    /// mid-cycle, so these wake it one M-cycle later. The timer raises IF.2 with the TIMA reload,
    /// at the next M-cycle boundary; the bus requests it one M-cycle ahead (see `Timer::step`),
    /// which a running CPU's fetch-time sample needs but a halted one must not see yet.
    pub fn late_interrupts(&self) -> u8 {
        if self.timer.reload_pending { TIMER_BIT } else { 0 }
    }

    pub fn cycle_tick(&mut self) {
        self.tick_components();
    }

    pub fn cycle_read(&mut self, addr: u16) -> u8 {
        self.tick_components();
        if (0xFE00..=0xFEFF).contains(&addr) { self.ppu.oam_bug_read(); }
        let value = if self.ppu.cpu_locked(addr, false) { 0xFF } else { self.read_byte(addr) };
        if let Some(w) = &mut self.watch { w.record(addr, value, false); }
        value
    }

    /// Read whose address register is incremented/decremented in the same
    /// M-cycle (LD A,(HL+/-), POP).
    pub fn cycle_read_inc(&mut self, addr: u16) -> u8 {
        self.tick_components();
        if (0xFE00..=0xFEFF).contains(&addr) { self.ppu.oam_bug_read_inc(); }
        let value = if self.ppu.cpu_locked(addr, false) { 0xFF } else { self.read_byte(addr) };
        if let Some(w) = &mut self.watch { w.record(addr, value, false); }
        value
    }

    pub fn cycle_write(&mut self, addr: u16, value: u8) {
        self.tick_components();
        if (0xFE00..=0xFEFF).contains(&addr) { self.ppu.oam_bug_write(); }
        if let Some(w) = &mut self.watch { w.record(addr, value, true); }
        if !self.ppu.cpu_locked(addr, true) {
            self.write_byte(addr, value);
        } else if addr >= 0xFF00 && self.cgb_mode {
            self.ppu.palette_index_step(addr); // a dropped BCPD/OCPD write still steps the index
        }
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
            // Writing bit 7 = 0 during an HBlank DMA cancels it; HDMA5 then reads bit 7 = 1 with
            // the length bits just written, not the remaining length Pan Docs describes (SameSuite
            // hdma_lcd_off/hdma_mode0, checked on hardware). Writing bit 7 = 1 restarts it.
            self.hdma_active = false;
            self.hdma5 = 0x80 | (value & 0x7F);
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
    fn cgb_palette_ram_locked_in_mode3() {
        let mut rom = vec![0u8; 0x8000];
        rom[0x14D] = (0x134..=0x14C).fold(0u8, |c, i| c.wrapping_sub(rom[i]).wrapping_sub(1));
        let mut bus = MemoryBus::new(Cartridge::from_rom(rom).unwrap(), true);
        bus.boot_rom_active = false;
        bus.write_byte(0xFF40, 0x80);
        let stat_mode = |b: &MemoryBus| b.read_byte(0xFF41) & 3;
        for (idx, data) in [(0xFF68u16, 0xFF69u16), (0xFF6A, 0xFF6B)] {
            // Mode 3: the write is dropped, the index still steps, a read gives $FF.
            while stat_mode(&bus) != 3 { bus.cycle_tick(); }
            bus.cycle_write(idx, 0x80 | 4);
            bus.cycle_write(data, 0x5A);
            assert_eq!(stat_mode(&bus), 3);
            let cram = |b: &MemoryBus| if data == 0xFF69 { b.ppu.bg_cram[4] } else { b.ppu.obj_cram[4] };
            assert_ne!(cram(&bus), 0x5A, "{data:04X} write in mode 3");
            assert_eq!(bus.read_byte(idx) & 0x3F, 5, "{idx:04X} steps on a dropped write");
            bus.cycle_write(idx, 4);
            assert_eq!(bus.cycle_read(data), 0xFF, "{data:04X} read in mode 3");
            // Mode 0: the write lands and the read sees it.
            while stat_mode(&bus) != 0 { bus.cycle_tick(); }
            bus.cycle_write(data, 0x5A);
            assert_eq!(cram(&bus), 0x5A, "{data:04X} write in mode 0");
            assert_eq!(bus.cycle_read(data), 0x5A);
        }
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
    fn oam_dma_conflicting_read_sees_the_dma_byte() {
        let mut bus = bus();
        bus.write_byte(0xFF46, 0xC0); // from WRAM, on the external bus with ROM
        for _ in 0..2 { bus.cycle_tick(); }
        assert_eq!(bus.read_byte(0x0100), 0x01, "a ROM read sees the byte the DMA reads");
        assert_eq!(bus.read_byte(0xD123), 0x01);
        bus.cycle_tick();
        assert_eq!(bus.read_byte(0x0100), 0x02);
        assert_eq!(bus.read_byte(0xFE00), 0xFF, "OAM itself still reads $FF");
        assert_eq!(bus.read_byte(0x8000), 0x00, "VRAM is on the other bus");
    }

    #[test]
    fn speed_switch_resets_div_and_pauses() {
        let mut bus = bus();
        bus.cgb_mode = true;
        for _ in 0..100 { bus.cycle_tick(); }
        assert_ne!(bus.read_byte(0xFF04), 0);
        bus.write_byte(0xFF4D, 0x01);
        assert_eq!(bus.read_byte(0xFF4D), 0x7F, "armed, normal speed");
        bus.write_byte(0xFF07, 0x04); // TIMA at 4 KHz
        bus.write_byte(0xFF05, 0x00);
        bus.cycle_count = 0;
        assert!(bus.try_speed_switch());
        assert_eq!(bus.read_byte(0xFF4D), 0xFE, "double speed, disarmed");
        assert_eq!(bus.read_byte(0xFF04), 0, "DIV reset, then $20000 counts: back at 0");
        assert_eq!(bus.read_byte(0xFF05), 0x80, "the timer ran through the pause (Age spsw-tima)");
        assert_eq!(bus.cycle_count, 2 * 4 + 0x8000 * 2, "STOP's 2 M-cycles, then $8000 at the new speed");
    }

    #[test]
    fn an_interrupt_ends_the_speed_switch_pause() {
        let mut bus = bus();
        bus.cgb_mode = true;
        bus.interrupts.interrupt_enable = TIMER_BIT;
        bus.write_byte(0xFF07, 0x05); // TIMA at 262 KHz: overflows 16 x 256 counts in
        bus.write_byte(0xFF4D, 0x01);
        bus.cycle_count = 0;
        assert!(bus.try_speed_switch());
        assert_ne!(bus.interrupts.interrupt_flag & TIMER_BIT, 0);
        assert!(bus.cycle_count < 0x8000 * 2, "woken by the timer, not after $8000 M-cycles");
        assert_ne!(bus.read_byte(0xFF04), 0, "DIV has not wrapped");
    }

    #[test]
    fn a_pending_interrupt_skips_the_pause_but_stops_the_divider() {
        let mut bus = bus();
        bus.cgb_mode = true;
        bus.interrupts.interrupt_enable = VBLANK_BIT;
        bus.interrupts.interrupt_flag = VBLANK_BIT;
        bus.write_byte(0xFF4D, 0x01);
        bus.cycle_count = 0;
        assert!(bus.try_speed_switch());
        assert_eq!(bus.cycle_count, 2 * 4, "STOP's two M-cycles, no pause");
        for _ in 0..2 { bus.cycle_tick(); }
        assert_eq!(bus.timer.div_counter, 0, "held for two M-cycles");
        bus.cycle_tick();
        assert_eq!(bus.timer.div_counter, 4);
    }

    #[test]
    fn odd_switches_into_double_speed_delay_the_div_apu_event_until_power_off() {
        let mut bus = bus();
        bus.cgb_mode = true;
        bus.interrupts.interrupt_enable = VBLANK_BIT; // pending: no pause to wait out
        bus.interrupts.interrupt_flag = VBLANK_BIT;
        bus.write_byte(0xFF26, 0x80);
        let mut switch = |bus: &mut MemoryBus| { bus.write_byte(0xFF4D, 0x01); bus.try_speed_switch(); };
        switch(&mut bus);
        assert!(bus.double_speed && bus.apu_event_late, "first switch into double speed");
        switch(&mut bus);
        assert!(bus.apu_event_late, "back to normal speed: still late");
        switch(&mut bus);
        assert!(!bus.apu_event_late, "second switch into double speed");
        switch(&mut bus);
        switch(&mut bus);
        assert!(bus.apu_event_late);
        // A DIV-APU edge (bit 5 in double speed) is held for one M-cycle.
        bus.timer.div_hold = 0;
        bus.timer.div_counter = 0x3FFC;
        bus.cycle_tick();
        assert_eq!(bus.apu_event_due, Some(false), "held back");
        bus.cycle_tick();
        assert_eq!(bus.apu_event_due, None, "delivered one M-cycle later");
        bus.write_byte(0xFF26, 0x00);
        assert!(!bus.apu_event_late, "power off ends it");
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
