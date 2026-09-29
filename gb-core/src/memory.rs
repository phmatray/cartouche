use crate::apu::Apu;
use crate::boot_rom::DMG_BOOT_ROM;
use crate::cartridge::Cartridge;
use crate::interrupts::{InterruptController, JOYPAD_BIT, SERIAL_BIT, STAT_BIT, TIMER_BIT, VBLANK_BIT};
use crate::joypad::Joypad;
use crate::ppu::{Ppu, PpuMode};
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
    /// M-cycles the APU hasn't run yet: it catches up (`apu_catch_up`) where it can be seen or
    /// changed, not on every M-cycle (#298). Always 0 between `GameBoy` calls.
    pub(crate) apu_pending: u32,
    // CGB HDMA/GDMA
    pub hdma5: u8,
    pub(crate) hdma_active: bool,
    pub(crate) hdma_source: u16,
    pub(crate) hdma_dest: u16,
    pub(crate) hdma_remaining: u8,
    /// A GDMA, or an HBlank DMA block, due: it runs after the CPU's next opcode fetch (`hdma_run`).
    pub(crate) hdma_on: bool,
    /// The CPU halted before this line's HBlank DMA request: waking in HBlank runs the block it
    /// slept through (`hdma_halt`).
    pub(crate) hdma_wake: bool,
    /// An HBlank DMA request came while the CPU was halted (`hdma_halted`).
    pub(crate) hdma_missed: bool,
    /// HBlank started while halted: that line's request is skipped (`hdma_halted`).
    pub(crate) hdma_skip: bool,
    /// HBlank (the PPU's internal mode 0) started in the M-cycle just run.
    pub(crate) hdma_entry: bool,
    /// A VRAM DMA is copying: a running OAM DMA skips its bytes (`dma_tick`).
    pub(crate) hdma_busy: bool,
    /// RP ($FF56, CGB): bit 0 = LED on, bits 6-7 = read enable (both set: bit 1 shows the sensor).
    pub(crate) rp: u8,
    /// The IF bits the M-cycle just run raised from clear, after the CPU's access in it: the PPU's
    /// (VBlank, STAT), the timer's and the serial port's (`raise_late`, `if_hidden`).
    /// Not saved: it only matters at the boundary after that M-cycle (`GameBoy::load_state`).
    pub(crate) if_late: u8,
    /// Whether the infrared sensor sees light (a linked partner's LED); never set when alone.
    pub ir_light_in: bool,
    /// Active cheat codes (Game Genie ROM patches, GameShark RAM writes).
    pub cheats: crate::cheats::Cheats,
    /// Debugger watchpoints; `None` unless one is set, so the CPU accessors pay one check.
    pub watch: Option<Box<crate::debug::WatchSet>>,
    /// The hardware revision (`GameBoy::set_revision`), for subsystems to read as a plain field.
    pub rev: crate::gameboy::Revision,
    /// The CPU is halted past HALT's first M-cycle: the OAM DMA waits (`dma_tick`).
    pub(crate) dma_hold: bool,
    /// The RAM a Game Boy Color up to revision D has at $FEA0-$FEFF (`fea0_index`).
    pub(crate) fea0: [u8; 0x30],
}

/// The bus an address sits on, as the OAM DMA sees it: it holds one bus while it runs.
#[derive(Clone, Copy, PartialEq, Eq, Debug)]
pub(crate) enum Bus {
    /// The cartridge (ROM, its RAM) and, on a Game Boy, work RAM.
    External,
    Vram,
    /// Work RAM and its echo, a bus of its own on Game Boy Color hardware.
    Wram,
    Oam,
    /// I/O registers and HRAM, never taken by the DMA.
    Io,
}

pub(crate) fn bus_of(addr: u16, cgb: bool) -> Bus {
    match addr {
        0x8000..=0x9FFF => Bus::Vram,
        0xC000..=0xFDFF if cgb => Bus::Wram,
        0xFE00..=0xFEFF => Bus::Oam,
        0xFF00.. => Bus::Io,
        _ => Bus::External,
    }
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
            apu_pending: 0,
            hdma5: 0xFF,
            hdma_active: false,
            hdma_source: 0,
            hdma_dest: 0,
            hdma_remaining: 0,
            hdma_on: false,
            hdma_wake: false,
            hdma_missed: false,
            hdma_skip: false,
            hdma_entry: false,
            hdma_busy: false,
            rp: 0,
            if_late: 0,
            ir_light_in: false,
            cheats: Default::default(),
            watch: None,
            rev: crate::gameboy::Revision::Default,
            dma_hold: false,
            fea0: [0; 0x30],
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
    /// the bus the DMA reads from (`bus_of`). I/O and HRAM stay reachable, so a DMA from VRAM
    /// (or from WRAM on a Color) leaves ROM fetches alone. The Color quirks follow SameBoy:
    /// WRAM is busy unless the DMA reads VRAM, and a DMA from echo RAM ($E000+) blocks
    /// everything but VRAM.
    fn dma_conflict(&self, addr: u16) -> bool {
        let cgb = self.cgb_mode || self.ppu.compat; // Color hardware, whatever the mode
        let src = (self.dma_source as u16) << 8;
        let src_bus = bus_of(self.dma_src(0), cgb);
        match bus_of(addr, cgb) {
            Bus::Oam => true,
            Bus::Io => false,
            Bus::Wram => src_bus != Bus::Vram,
            bus if cgb && src >= 0xE000 => bus != Bus::Vram,
            bus => bus == src_bus,
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
            return self.conflict_read(addr);
        }
        self.peek(addr)
    }

    /// What a CPU read on the bus the running OAM DMA holds returns: the byte the DMA reads
    /// this M-cycle, and $FF for OAM itself. On a Color (as SameBoy's `GB_read_memory`, MIT;
    /// Gambatte hwtests `oamdma_src*_busypop*`, `busyread*` over every source page), a DMA
    /// from $E000+ leaves $FF on the external bus, and a work RAM read during a DMA from the
    /// external bus reads the 4 KB bank the DMA's address picks (`dma_write_conflict`).
    fn conflict_read(&self, addr: u16) -> u8 {
        let cgb = self.cgb_mode || self.ppu.compat; // Color hardware, whatever the mode
        let i = self.dma_index.saturating_sub(1);
        match (bus_of(addr, cgb), self.dma_bus(cgb)) {
            (Bus::Oam, _) => 0xFF,
            (Bus::Wram, Bus::External) => self.wram_read(0xC000 | (self.dma_source as u16) << 8 & 0x1000 | addr & 0x0FFF),
            (Bus::External, _) if cgb && self.dma_source >= 0xE0 => 0xFF,
            _ => self.peek(self.dma_src(i)),
        }
    }

    /// A Color's CPU read of VRAM during a DMA from VRAM clears the byte the DMA copies this
    /// M-cycle (Gambatte hwtests `oamdma_src8000/9F00_busypop7FFF/9FFF`: OAM reads back $00).
    fn dma_read_clobber(&mut self, addr: u16) {
        let cgb = self.cgb_mode || self.ppu.compat;
        if cgb && bus_of(addr, cgb) == Bus::Vram && self.dma_bus(cgb) == Bus::Vram {
            self.ppu.write_oam(self.dma_index.saturating_sub(1) as u16, 0x00);
        }
    }

    /// A CPU write on the bus the running OAM DMA holds: the DMA drives the address, so the
    /// write never reaches its target, and OAM gets, as the byte being copied (Gambatte hwtests
    /// `oamdma_src*_busypush*`, `busywrite*`, `*bankchange_1`, over every source page):
    /// - on a Game Boy, the written value, ANDed with work RAM's byte when the DMA reads it
    ///   (from $C000-$FF00) as that RAM drives the bus too;
    /// - on a Color, the written value on the external bus, $00 on VRAM's, and on work RAM's
    ///   the DMA's own byte. A Color's DMA from $E000+ reads the external bus (`dma_bus`).
    /// A Color's work RAM write during a DMA from the external bus lands, but in the 4 KB bank
    /// the DMA's address picks: $C000 when its bit 12 is clear, $D000 when set (as SameBoy's
    /// `GB_write_memory`, MIT; `busypushC001`/`E001`/`F001`/`FE01` from $0000 and $7F00).
    /// Returns whether the write was taken.
    fn dma_write_conflict(&mut self, addr: u16, value: u8) -> bool {
        let cgb = self.cgb_mode || self.ppu.compat; // Color hardware, whatever the mode
        let (bus, dma_bus) = (bus_of(addr, cgb), self.dma_bus(cgb));
        let i = self.dma_index.saturating_sub(1);
        if bus == Bus::Wram && dma_bus == Bus::External {
            let at = (self.dma_source as u16) << 8 & 0x1000;
            self.wram_write(0xC000 | at | addr & 0x0FFF, value);
            return true;
        }
        if matches!(bus, Bus::Oam | Bus::Io) || bus != dma_bus {
            return false;
        }
        let from = self.dma_src(i);
        let byte = match bus {
            _ if !cgb && from >= 0xC000 => value & self.peek(from),
            Bus::Vram if cgb => 0x00,
            Bus::Wram => return true,
            _ => value,
        };
        self.ppu.write_oam(i as u16, byte);
        true
    }

    /// The bus the running OAM DMA reads from. A Color's DMA from $E000 and up reads the
    /// external bus, where nothing answers: $FF (as SameBoy's `GB_dma_run`, MIT; Gambatte
    /// hwtests `oamdma_srcE000..srcFF00_busypush*` on the CGB).
    fn dma_bus(&self, cgb: bool) -> Bus {
        if cgb && self.dma_source >= 0xE0 { Bus::External } else { bus_of(self.dma_src(0), cgb) }
    }

    /// $FEA0-$FEFF, past OAM (Pan Docs, "FEA0-FEFF range"): $FF while the PPU holds OAM; then a
    /// Game Boy reads $00, a CGB E or a GBA the address's high nibble twice, and an older Color
    /// its RAM there (as SameBoy's `GB_read_oam`, MIT; Gambatte hwtests `oamdma_*_busypushFEA1`,
    /// `busypushFF01`: a CGB C reads back what was written, a DMG $00).
    fn read_fea0(&self, addr: u16) -> u8 {
        let a = addr as u8;
        match self.fea0_index(addr) {
            _ if self.ppu.cpu_locked(0xFE00, false) => 0xFF,
            Some(i) => self.fea0[i],
            None if self.cgb_mode || self.ppu.compat => (a & 0xF0) | (a >> 4),
            None => 0x00,
        }
    }

    /// Where $FEA0-$FEFF lands in a Color's RAM there (`fea0`): up to revision C, 8 bytes at
    /// each of $FEA0, $FEC0 and $FEE0, each mirrored four times (bytes 0-23); on a CGB D, the 32
    /// of $FEA0-$FEBF (0-31) and the 16 of $FEF0-$FEFF (32-47), which $FEC0-$FEEF mirror. None
    /// on a Game Boy, a CGB E or a GBA.
    fn fea0_index(&self, addr: u16) -> Option<usize> {
        use crate::gameboy::Revision::*;
        let a = addr as usize & 0xFF;
        match self.rev {
            _ if !(self.cgb_mode || self.ppu.compat) => None,
            CgbE | Agb => None,
            CgbD if a >= 0xC0 => Some(0x20 | a & 0x0F),
            CgbD => Some(a - 0xA0),
            _ => Some(((a & 0x60) >> 2 | a & 0x07) - 8),
        }
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
            0xFEA0..=0xFEFF => self.read_fea0(addr),
            0xFF00 => self.sgb.as_ref().and_then(|s| s.read_p1(self.joypad.select)).unwrap_or_else(|| self.joypad.read()),
            0xFF01 => self.serial.read(addr),
            // SC: unused bits read 1, and bit 1 (the fast clock) exists in Color mode only.
            0xFF02 => self.serial.read(addr) | if self.cgb_mode { 0x7C } else { 0x7E },
            0xFF04..=0xFF07 => self.timer.read(addr),
            0xFF0F => (self.interrupts.interrupt_flag & !self.if_hidden()) | 0xE0, // bits 5-7 unused, read as 1
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
            0xFEA0..=0xFEFF => {
                if let Some(i) = self.fea0_index(addr).filter(|_| !self.ppu.cpu_locked(0xFE00, true)) {
                    self.fea0[i] = value;
                }
            }
            0xFF00 => {
                // Selecting a group whose button is held pulls a line low: a joypad interrupt, as a press would.
                let before = self.joypad.read();
                self.joypad.write(value);
                if before & !self.joypad.read() & 0x0F != 0 { self.interrupts.request(JOYPAD_BIT); }
                if let Some(s) = self.sgb.as_deref_mut() { s.write_p1(value); }
            }
            0xFF01 => { self.serial.write(addr, value, self.timer.div_counter); }
            0xFF02 => {
                // Stopped before its 8th edge: the request of this M-cycle is withdrawn.
                if self.serial.write(addr, if self.cgb_mode { value } else { value & !0x02 }, self.timer.div_counter) {
                    self.interrupts.interrupt_flag &= !(self.if_late & SERIAL_BIT);
                    self.if_late &= !SERIAL_BIT;
                }
            }
            0xFF04..=0xFF07 => {
                // An overflow requests the interrupt at once, a TIMA write cancelling the reload withdraws it (Timer::step).
                let (pending, div) = (self.timer.reload_pending, self.timer.div_counter);
                self.timer.write(addr, value);
                if addr == 0xFF04 { self.serial.div_reset(div); }
                self.div_apu_edge(div, true);
                match (pending, self.timer.reload_pending) {
                    (false, true) => self.interrupts.request(TIMER_BIT),
                    (true, false) => self.interrupts.interrupt_flag &= !TIMER_BIT,
                    _ => {}
                }
            }
            0xFF0F => {
                let seen = if self.ppu.mode0_edge_first_dot() { STAT_BIT } else { 0 };
                self.interrupts.interrupt_flag = value & 0x1F | self.if_hidden() & !seen;
            }
            0xFF10..=0xFF3F => {
                self.apu_catch_up();
                let was_on = self.apu.is_on();
                self.apu.write_register(addr, value);
                if !self.apu.is_on() { (self.apu_event_late, self.apu_event_due) = (false, None); }
                // Powered on while DIV's APU bit is set, as this M-cycle ends: the first DIV-APU
                // event is skipped (Gambatte `ch2_init_reset_env_counter_timing_5/7`,
                // `ch2_late_reset_nr52_*2b`: a power-on the M-cycle before the bit rises skips).
                if !was_on && self.apu.is_on() && self.timer.div_counter.wrapping_add(4) & self.div_apu_bit() != 0 {
                    self.apu.skip_first_div_event();
                }
            }
            0xFF40..=0xFF4B => {
                if addr == 0xFF46 {
                    // A write during a transfer restarts it; the old one holds the bus meanwhile.
                    self.dma_source = value;
                    self.dma_delay = 2;
                } else {
                    // The LCD turned off outside mode 0 enters it: an HBlank DMA runs a block (SameBoy's `GB_lcd_off`).
                    let lcd_off = addr == 0xFF40 && self.ppu.lcdc & !value & 0x80 != 0 && self.ppu.read_register(0xFF41) & 3 != 0;
                    self.ppu.write_register(addr, value);
                    self.hdma_on |= lcd_off && self.hdma_active;
                    if std::mem::take(&mut self.ppu.stat_write_irq) { self.interrupts.request(STAT_BIT); }
                    if std::mem::take(&mut self.ppu.stat_write_drop) && self.if_hidden() & STAT_BIT != 0 {
                        self.interrupts.interrupt_flag &= !STAT_BIT;
                        self.if_late &= !STAT_BIT;
                    }
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
            // The destination keeps its top bits: VRAM takes the low 13, and a transfer stops when it
            // wraps past $FFFF (Gambatte `dma_dst_wrap_1/2`; SameBoy).
            0xFF53 => self.hdma_dest = (self.hdma_dest & 0x00F0) | (value as u16) << 8,
            0xFF54 => self.hdma_dest = (self.hdma_dest & 0xFF00) | (value as u16 & 0xF0),
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
        self.apu_catch_up();
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
        // An HBlank DMA request in the first stays due; one in the second, as DIV resets, ends the
        // HBlank DMA: HDMA5 reads bit 7 = 1 and its length, nothing copied (Gambatte
        // `hdma_transition_speedchange_hdmalen00/01`, `hdma_late_m3speedchange_hdma5_scx1/2_1`).
        // A block left behind outside mode 0 runs on waking in mode 0 (SameBoy's `leave_stop_mode`).
        let (hdma_on, stat) = (self.hdma_on, self.ppu.read_register(0xFF41) & 3);
        self.tick_components();
        let first = std::mem::take(&mut self.hdma_on);
        let earlier = self.timer.div_counter;
        // From here the pause holds the OAM DMA's copying as HALT does (`dma_hold`).
        let hold = std::mem::replace(&mut self.dma_hold, true);
        self.tick_components();
        let second = self.hdma_on;
        if if self.double_speed { second } else { first } {
            let (len, rem) = (self.hdma5, self.hdma_remaining);
            if !self.double_speed { self.hdma_run(); }
            (self.hdma_active, self.hdma_on, self.hdma5, self.hdma_remaining) = (false, false, 0x80 | len, rem);
        } else if self.double_speed {
            self.hdma_on = hdma_on || first || self.hdma_active && stat != 0 && self.ppu.read_register(0xFF41) & 3 == 0;
        } else {
            self.hdma_on = hdma_on;
        }
        let div = self.timer.div_counter;
        let cgb_e = self.rev == crate::gameboy::Revision::CgbE;
        self.timer.speed_switch_div_reset(earlier, cgb_e);
        // The reset can drop DIV's APU bit (old speed), seen one M-cycle late like the 4 KHz timer
        // input: a bit that only just rose does not count (Age spsw-ch2-lc-delay).
        self.div_apu_edge(div & earlier, true);
        self.apu_catch_up(); // at the old speed's ticks per M-cycle
        self.double_speed = !self.double_speed;
        if self.double_speed && self.apu.is_on() { self.apu_event_late = !self.apu_event_late; }
        self.ppu.m_cycle_dots = if self.double_speed { 2 } else { 4 };
        self.key1 = 0;
        // Then the CPU halts while the clock settles and everything else runs: $20000 DIV counts,
        // so DIV is back at 0 when it resumes (Age spsw-div, spsw-tima). Like HALT, an interrupt
        // ends it early (Age spsw-interrupts). Back in single speed the PPU comes out one dot
        // behind (Age spsw-mode0: the LCD-to-CPU alignment shifts).
        // An interrupt already pending skips that pause, but the divider still stops for two
        // M-cycles while the oscillator restarts on a CGB B/C, one on a CGB E (Age spsw-interrupts'
        // `OFS_B`).
        if self.interrupts.pending() & !self.late_interrupts() != 0 {
            self.timer.div_hold = if cgb_e { 1 } else { 2 };
            self.dma_hold = hold;
            return true;
        }
        let mut behind = !self.double_speed;
        // The pause is a HALT to the HBlank DMA (`hdma_halt`, `hdma_unhalt`; Gambatte
        // `hdma_m3speedchange_late_m0wakeup_1/2`).
        let hdma_on = self.hdma_on;
        self.hdma_halt();
        for _ in 0..0x8000 {
            self.tick_components();
            self.hdma_missed |= std::mem::take(&mut self.hdma_on);
            // Taken back once the PPU is a dot into a mode, so no mode change is undone.
            if behind && self.ppu.mode_clock > 0 {
                self.ppu.mode_clock -= 1;
                behind = false;
            }
            if self.interrupts.pending() & !self.late_interrupts() != 0 { break; }
        }
        self.hdma_on = hdma_on;
        self.hdma_unhalt();
        self.dma_hold = hold;
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
        self.apu_catch_up();
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

    /// A timer or serial request of this M-cycle: it reaches IF after the CPU's access in it
    /// (`if_hidden`), as the PPU's do. The timer's is the TIMA reload's, one M-cycle after the
    /// overflow (`Timer::step`): an IF read or write in the overflow's M-cycle misses it, a write
    /// there doesn't clear it (Gambatte tima `tc00_irq_1/2`, `tc00_irq_ifw_1/2`, their `_ds` twins).
    #[inline]
    fn raise_late(&mut self, bit: u8) {
        self.if_late |= bit & !self.interrupts.interrupt_flag;
        self.interrupts.request(bit);
    }

    /// The PPU's interrupt requests of this M-cycle, and which of them are fresh (`if_late`); it
    /// also runs the M-cycle after a `raise_late`, to clear that one.
    /// Kept out of the per-M-cycle path: a few calls per line.
    #[inline(never)]
    fn ppu_irqs(&mut self, vblank_irq: bool, stat_irq: bool) {
        let before = self.interrupts.interrupt_flag;
        if vblank_irq {
            self.interrupts.request(VBLANK_BIT);
            if self.sgb.is_some() {
                self.apu_catch_up();
                let playing = self.apu.read_register(0xFF26) & 0x0F != 0;
                if let Some(s) = self.sgb.as_deref_mut() { s.vblank(&self.ppu.framebuffer, playing); }
            }
        }
        if stat_irq {
            self.interrupts.request(STAT_BIT);
        }
        self.if_late = self.interrupts.interrupt_flag & !before;
    }

    fn tick_components(&mut self) {
        let ppu_step = if self.double_speed { 2 } else { 4 };
        let (vblank_irq, stat_irq, hblank_entry) = self.ppu.step(ppu_step);
        if vblank_irq | stat_irq || self.if_late != 0 {
            self.ppu_irqs(vblank_irq, stat_irq);
        }
        if self.hdma_active {
            self.hdma_tick(hblank_entry);
        }
        let div = self.timer.div_counter;
        if self.timer.step(4) {
            self.raise_late(TIMER_BIT);
        }
        self.div_apu_edge(div, false);
        if self.serial.tick(4) {
            self.raise_late(SERIAL_BIT);
        }
        self.cartridge.tick();
        self.cartridge.tick_clock(ppu_step as u64);
        self.apu.cgb_mode = self.cgb_mode || self.ppu.compat; // CGB hardware, whatever the mode
        self.apu.double_speed = self.double_speed;
        if let Some((l, r)) = self.sgb.as_deref_mut().and_then(|s| s.audio.run(ppu_step)) {
            self.apu_catch_up();
            self.apu.mix_external(l, r);
        }
        self.apu_pending += 1;
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
            self.apu_catch_up();
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
            self.apu_catch_up();
            self.apu.div_event(write);
        }
    }

    /// Runs the M-cycles the APU is behind on, at this speed's ticks each: before anything reads or
    /// changes it (registers, DIV-APU edges, the Super Game Boy's sound, a speed switch, stop
    /// mode) and whenever `GameBoy` hands back control.
    #[inline]
    pub(crate) fn apu_catch_up(&mut self) {
        if self.apu_pending != 0 {
            let m = std::mem::take(&mut self.apu_pending);
            self.apu.run(m, if self.double_speed { 1 } else { 2 });
        }
    }

    /// An APU register (NRxx, wave RAM, PCM12/PCM34) is read at `addr`.
    #[inline]
    fn reads_apu(addr: u16) -> bool {
        matches!(addr, 0xFF10..=0xFF3F | 0xFF76 | 0xFF77)
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
            self.ppu.set_oam_dma(true);
        }
        if !self.dma_active {
            return;
        }
        // HALT holds the DMA's copying after its first M-cycle, not its end once the last byte
        // is in (as SameBoy's `GB_dma_run`, MIT; Gambatte hwtests `oamdmasrc80_halt_m2irq/lycirq_read8000`:
        // a DMA started before HALT is still copying after it, `oamdma_late_halt_stat_1/_2`).
        if self.dma_hold && self.dma_index < 0xA0 {
            return;
        }
        if self.dma_index >= 0xA0 {
            self.dma_active = false;
            self.ppu.set_oam_dma(false);
            return;
        }
        let cgb = self.cgb_mode || self.ppu.compat;
        // A VRAM DMA takes the bus from it: its bytes are skipped but for the transfer's last
        // (SameBoy's `GB_dma_run`; Gambatte `oamdmasrcC000_hdmasrc0000`, `hdma_transition_oamdma_*`).
        if self.hdma_busy && (self.hdma_remaining > 1 || self.hdma_dest & 0xF != 0xF) {
            self.dma_index += 1;
            return;
        }
        let byte = if cgb && self.dma_source >= 0xE0 { 0xFF } else { self.peek(self.dma_src(self.dma_index)) };
        self.ppu.write_oam(self.dma_index as u16, byte);
        self.dma_index += 1;
    }

    /// IF bits whose line rises only at the end of this M-cycle. A halted CPU samples IF
    /// mid-cycle, so these wake it one M-cycle later; so does the dispatch that clears the bit it
    /// takes (`Cpu::dispatch`). The timer raises IF.2 with the TIMA reload, at the next M-cycle
    /// boundary; the bus requests it one M-cycle ahead (see `Timer::step`), which a running CPU's
    /// fetch-time sample needs but a halted one must not see yet. The serial port's IF.3 also
    /// rises after that sample (Gambatte `start_wait_trigger_int8_read_if_2` on the DMG). Line
    /// 0's mode-2 edge is on time for the dispatch once LY = LYC 153 is (`lyc153int_m2irq_late_retrigger_1/2`),
    /// but an IF access in its M-cycle misses it (`if_hidden`).
    /// `late_interrupts` for a halted CPU: on Color hardware a mode-0 edge always wakes it an
    /// M-cycle later, whatever its dot in the M-cycle (Gambatte `halt/m0int_m0stat_scx3/4_2`,
    /// `m0irq_m0stat_scx3/4_2`, `late_m0int/irq_halt_m0stat_scx3_*b`, which a DMG splits by SCX).
    /// So is the LY = LYC edge at a line's start, when it lands after the M-cycle's first dot
    /// (Gambatte `dma/gdma_cycles_*`, `hdma_cycles_*`, `hdma_start_*` from LYC 1 and 144 against
    /// the same reads from LYC 153, `halt/lycirq_m2stat_2` on the CGB; not on a DMG, gbmicrotest
    /// `lyc*_int_halt_a`).
    pub fn halt_late_interrupts(&self) -> u8 {
        let p = &self.ppu;
        let lyc = p.stat & 0x40 != 0 && p.ly == p.lyc && matches!(p.mode, PpuMode::OamScan | PpuMode::VBlank)
            && p.mode_clock < p.m_cycle_dots;
        let cgb_m0 = (self.cgb_mode || self.ppu.compat) && self.if_late & STAT_BIT != 0 && (self.ppu.mode0_edge_now() || lyc);
        self.late_interrupts() | if cgb_m0 { STAT_BIT } else { 0 }
    }

    pub fn late_interrupts(&self) -> u8 {
        let stat = self.if_late & STAT_BIT != 0
            && (self.ppu.mode0_edge_late() || self.ppu.mode2_early());
        (if stat { STAT_BIT } else { 0 }) | self.if_late & SERIAL_BIT | if self.timer.reload_pending { TIMER_BIT } else { 0 }
    }

    /// The PPU's IF bits raised late in the M-cycle just run, after the CPU's read or write of IF
    /// in it: that access doesn't see them (nor clear them), though the next opcode fetch
    /// dispatches them. Mode 0 for every SCX (gbmicrotest `hblank_int_scx0..7_if_a/b/c`,
    /// `hblank_int_if_a/b`), VBlank's IF.0 and mode-1 STAT edge (`vblank2_int_if_a..d`,
    /// `vblank_int_if_a..d`, `stat_write_glitch_l143_c/d`), the LY = LYC edge (`lyc1_int_if_edge_a..d`).
    /// So is the mode-2 edge, which rises in the M-cycle before its line (`Ppu::mode2_early`):
    /// a read or write of IF there misses it (`oam_int_if_edge_a..d`), a halted CPU wakes one
    /// M-cycle later (`late_interrupts`). Not a mode-2 edge a STAT write raises at mode 2's start,
    /// which such a read sees (`mode2_edge_now`).
    /// An IF access samples 2 dots before its M-cycle ends: VBlank's IF.0 and the STAT edge with
    /// it, raised at line 144's start, show once 2 dots have run, which only a PPU off the CPU's
    /// M-cycle grid (a CGB after a speed switch) reaches before the M-cycle ends (Gambatte
    /// `lcd_offset/offset*_lyc8fint_m1irq_*`).
    pub(crate) fn if_hidden(&self) -> u8 {
        if self.if_late == 0 { return 0; }
        let ppu = if self.ppu.mode == PpuMode::VBlank && (2..self.ppu.m_cycle_dots).contains(&self.ppu.mode_clock) {
            VBLANK_BIT | STAT_BIT
        } else {
            0
        };
        self.if_late & !ppu & if self.ppu.mode2_edge_now() && self.ppu.ly != 0 { !STAT_BIT } else { 0xFF }
    }

    pub fn cycle_tick(&mut self) {
        self.tick_components();
    }


    pub fn cycle_read(&mut self, addr: u16) -> u8 {
        self.tick_components();
        if (0xFE00..=0xFEFF).contains(&addr) { self.ppu.oam_bug_read(); }
        if Self::reads_apu(addr) { self.apu_catch_up(); }
        let value = if self.ppu.cpu_locked(addr, false) { 0xFF } else { self.read_byte(addr) };
        if self.dma_active { self.dma_read_clobber(addr); }
        if let Some(w) = &mut self.watch { w.record(addr, value, false); }
        value
    }

    /// Read whose address register is incremented/decremented in the same
    /// M-cycle (LD A,(HL+/-), POP).
    pub fn cycle_read_inc(&mut self, addr: u16) -> u8 {
        self.tick_components();
        if (0xFE00..=0xFEFF).contains(&addr) { self.ppu.oam_bug_read_inc(); }
        if Self::reads_apu(addr) { self.apu_catch_up(); }
        let value = if self.ppu.cpu_locked(addr, false) { 0xFF } else { self.read_byte(addr) };
        if self.dma_active { self.dma_read_clobber(addr); }
        if let Some(w) = &mut self.watch { w.record(addr, value, false); }
        value
    }

    pub fn cycle_write(&mut self, addr: u16, value: u8) {
        self.tick_components();
        self.write_access(addr, value);
    }

    /// The CPU's write of an M-cycle whose components have already run.
    pub(crate) fn write_access(&mut self, addr: u16, value: u8) {
        if (0xFE00..=0xFEFF).contains(&addr) { self.ppu.oam_bug_write(); }
        if let Some(w) = &mut self.watch { w.record(addr, value, true); }
        if self.dma_active && self.dma_write_conflict(addr, value) {
            return;
        }
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

    /// Handle writes to HDMA5 (0xFF55): a GDMA, or an HBlank DMA, runs after the CPU's next
    /// opcode fetch (`hdma_run`).
    fn write_hdma5(&mut self, value: u8) {
        if !self.cgb_mode {
            return;
        }
        if self.hdma_active && value & 0x80 == 0 {
            // Writing bit 7 = 0 during an HBlank DMA cancels it; HDMA5 then reads bit 7 = 1 with
            // the length bits just written, not the remaining length Pan Docs describes (SameSuite
            // hdma_lcd_off/hdma_mode0, checked on hardware). Writing bit 7 = 1 restarts it.
            // A block already due still runs, as a GDMA of the length just written (SameBoy;
            // Gambatte `hdma_late_disable*`).
            self.hdma_active = false;
            self.hdma_remaining = (value & 0x7F) + 1;
            self.hdma5 = 0x80 | (value & 0x7F);
            return;
        }
        self.hdma_remaining = (value & 0x7F) + 1;
        // While a transfer is pending HDMA5 reads bit 7 = 0 plus the remaining length.
        self.hdma5 = value & 0x7F;
        self.hdma_active = value & 0x80 != 0;
        // A GDMA always; an HBlank DMA at once when the PPU is in HBlank already (the LCD off too).
        self.hdma_on = !self.hdma_active || self.ppu.mode == PpuMode::HBlank;
    }

    /// The HDMA/GDMA transfer, after the CPU's opcode fetch that found it due (the dispatch's
    /// discarded one too); the CPU waits meanwhile. Single speed: a lead-in half M-cycle, 2 bytes
    /// per M-cycle, a half M-cycle out (8n + 1 M-cycles for n blocks); double speed: a lead-in
    /// M-cycle, then 1 byte per M-cycle (16n + 1). A GDMA runs all its blocks back to back, an
    /// HBlank DMA one (Gambatte `gdma_cycles_*`, `hdma_cycles_*`). After SameBoy's `GB_hdma_run`
    /// (MIT, see THIRD_PARTY_NOTICES.md).
    #[inline(never)]
    pub(crate) fn hdma_run(&mut self) {
        let per = if self.double_speed { 1 } else { 2 };
        self.hdma_busy = true;
        if self.double_speed { self.tick_components(); }
        'run: loop {
            self.tick_components();
            for k in 0..per {
                // Only the cartridge and work RAM feed it: VRAM and $E000 on read $FF (Gambatte
                // `dma_vram_read`, `dma_hiram_read*`, `dma_oam_read`; SameBoy).
                let byte = if matches!(self.hdma_source, 0x8000..=0x9FFF | 0xE000..) { 0xFF } else { self.read_byte(self.hdma_source) };
                self.ppu.write_vram(self.hdma_dest & 0x1FFF, byte);
                // A running OAM DMA writes what it sees, the VRAM DMA's byte, at the source's low
                // byte: every byte in double speed, one in two in single speed (SameBoy).
                if self.dma_active && k == 0 && (self.hdma_source as u8) < 0xA0 {
                    self.ppu.write_oam(self.hdma_source & 0xFF, byte);
                }
                self.hdma_source = self.hdma_source.wrapping_add(1);
                self.hdma_dest = self.hdma_dest.wrapping_add(1);
                if self.hdma_dest & 0xF == 0 {
                    self.hdma_remaining -= 1;
                    if self.hdma_remaining == 0 || self.hdma_dest == 0 {
                        self.hdma_active = false;
                        self.hdma5 = 0xFF; // done
                        break 'run;
                    }
                    self.hdma5 = (self.hdma_remaining - 1) & 0x7F; // bit 7 = 0: more to come
                    if self.hdma_active { break 'run; }
                }
            }
        }
        self.hdma_busy = false;
        if !self.double_speed { self.tick_components(); }
        self.hdma_on = false;
    }

    /// An M-cycle of an HBlank DMA: its block request rises 2 dots after STAT shows mode 0
    /// in single speed (SameBoy), as it does in double speed, per SCX (Gambatte `hdma_start_*`,
    /// `hdma_late_disable_*`, `irq_precedence/hdma_vs_m0_*`, `late_hdma_vs_*`).
    /// Kept out of the per-M-cycle path: only while an HBlank DMA is on.
    #[inline(never)]
    fn hdma_tick(&mut self, hblank_entry: bool) {
        self.hdma_entry = hblank_entry;
        let at = if self.ppu.m_cycle_dots == 4 { 5 } else { 4 };
        if self.ppu.mode == PpuMode::HBlank && self.ppu.lcdc & 0x80 != 0
            && (at..at + self.ppu.m_cycle_dots).contains(&self.ppu.mode_clock)
        {
            self.hdma_on = true;
        }
    }

    /// The CPU halts (`HALT` after its first halted M-cycle, the STOP a held button turns into a
    /// HALT, the pause after a speed switch). A request it sleeps through runs when it wakes in
    /// HBlank, if it halted before that line's request (still in the line before, one dot in, or
    /// earlier in the line): Gambatte `hdma_late_m0halt_*`, `hdma_late_m0unhalt_*`,
    /// `hdma_late_m3halt_m0unhalt_*`, their `lcdoffset` twins.
    pub(crate) fn hdma_halt(&mut self) {
        let p = &self.ppu;
        let past = p.lcdc & 0x80 != 0 && p.mode == PpuMode::HBlank && p.mode_clock >= if p.m_cycle_dots == 4 { 5 } else { 4 };
        (self.hdma_missed, self.hdma_skip) = (false, false);
        self.hdma_wake = !past && !(p.mode == PpuMode::OamScan && p.mode_clock == 0);
    }

    /// The CPU wakes (see `hdma_halt`).
    #[inline(never)]
    pub(crate) fn hdma_unhalt(&mut self) {
        let hblank = self.ppu.lcdc & 0x80 == 0 || self.ppu.mode == PpuMode::HBlank;
        if self.hdma_active && self.hdma_wake && self.hdma_missed && hblank {
            self.hdma_on = true;
        }
    }

    /// An M-cycle of a halted CPU with an HBlank DMA on (after `hdma_halt` in its first). A
    /// request whose HBlank began before the CPU halted still runs, now; one whose HBlank began
    /// while halted waits for the wake (`hdma_unhalt`): Gambatte `hdma_late_m3halt_m2unhalt_*`,
    /// `hdma_transition_halt_*`.
    #[inline(never)]
    pub(crate) fn hdma_halted(&mut self) {
        if self.hdma_entry {
            self.hdma_skip = true;
        }
        if self.hdma_on && !self.hdma_skip {
            self.hdma_run();
        }
        if std::mem::take(&mut self.hdma_on) {
            (self.hdma_skip, self.hdma_missed) = (false, true);
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

    /// M-cycles from 10 into line 9's HBlank (past its mode-3 tail) until, on line 10: STAT shows
    /// mode 2, an OAM read reads $FF, an OAM write is dropped, STAT shows mode 3, a VRAM read
    /// reads $FF.
    fn lock_edges(cgb: bool, ds: bool, rev: crate::gameboy::Revision) -> [u32; 5] {
        let start = || {
            let mut bus = bus();
            (bus.cgb_mode, bus.ppu.cgb_mode, bus.rev, bus.ppu.rev) = (cgb, cgb, rev, rev);
            (bus.double_speed, bus.ppu.m_cycle_dots) = (ds, if ds { 2 } else { 4 });
            bus.write_byte(0xFF40, 0x91);
            while !(bus.ppu.ly == 9 && bus.ppu.mode == crate::ppu::PpuMode::HBlank) { bus.cycle_tick(); }
            bus
        };
        let first = |hit: &dyn Fn(u32) -> bool| (10..400).find(|&k| hit(k)).unwrap();
        let at = |k: u32| { let mut bus = start(); for _ in 1..k { bus.cycle_tick(); } bus };
        let stat = |m: u8| first(&|k| { let mut b = at(k); b.cycle_tick(); b.ppu.read_register(0xFF41) & 3 == m });
        [
            stat(2),
            first(&|k| at(k).cycle_read(0xFE00) == 0xFF),
            first(&|k| { let mut b = at(k); b.cycle_write(0xFE00, 0x99); b.ppu.oam[0] != 0x99 }),
            stat(3),
            first(&|k| at(k).cycle_read(0x8000) == 0xFF),
        ]
    }

    /// Age oam-read, oam-write, vram-read: a read is blocked one M-cycle before STAT shows mode
    /// 2 (not in double speed on a CGB B/C), a write on a DMG only once it shows, on a CGB with the
    /// read; VRAM reads lead mode 3 by an M-cycle on a DMG only.
    #[test]
    fn oam_vram_lock_edges_cgb() {
        use crate::gameboy::Revision;
        for (cgb, ds, rev, [oam_r, oam_w, vram_r]) in [
            (false, false, Revision::Default, [1, 0, 1]),
            (true, false, Revision::Default, [1, 1, 0]),
            (true, false, Revision::CgbE, [1, 1, 0]),
            (true, true, Revision::CgbC, [0, 1, 0]),
            (true, true, Revision::CgbE, [1, 1, 0]),
        ] {
            let [s2, r, w, s3, v] = lock_edges(cgb, ds, rev);
            assert_eq!([s2 - r, s2 - w, s3 - v], [oam_r, oam_w, vram_r], "CGB {cgb}, double speed {ds}, {rev:?}");
        }
    }

    /// A CGB after a speed switch runs its PPU 1-3 dots off the CPU's M-cycle grid. Stepping in
    /// M-cycles that end `phase` dots after line 144 starts: STAT reads mode 1 from 2 dots in, and
    /// VBlank's IF.0 shows to an IF read from then (Gambatte `lcd_offset/offset*_lyc8fint_m1*`).
    #[test]
    fn off_grid_ppu_shows_mode_1_two_dots_in() {
        for phase in 0..4 {
            let mut rom = vec![0u8; 0x8000];
            rom[0x14D] = (0x134..=0x14C).fold(0u8, |c, i| c.wrapping_sub(rom[i]).wrapping_sub(1));
            let mut bus = MemoryBus::new(Cartridge::from_rom(rom).unwrap(), true);
            bus.boot_rom_active = false;
            let p = &mut bus.ppu;
            (p.lcdc, p.ly, p.mode, p.mode3_len) = (0x81, 143, PpuMode::HBlank, 172);
            p.mode_clock = 206 - 4 + phase; // HBlank lasts 376 + 2 (MODE0_EARLY) - 172 dots
            bus.cycle_tick();
            assert_eq!((bus.ppu.ly, bus.ppu.mode_clock), (144, phase));
            let shown = phase >= 2;
            assert_eq!(bus.read_byte(0xFF41) & 3, if shown { 1 } else { 0 }, "phase {phase}");
            assert_eq!(bus.read_byte(0xFF0F) & 1 != 0, shown, "phase {phase}");
        }
    }

    /// A mode-0 edge 3 dots into its M-cycle wakes a halted DMG at once, a halted CGB an M-cycle
    /// later (Gambatte `halt/m0int_m0stat_scx3_2`: $00 on the DMG, $02 on the CGB).
    #[test]
    fn halt_mode0_wake_then_stat_read_per_scx() {
        for cgb in [false, true] {
            let mut rom = vec![0u8; 0x8000];
            rom[0x14D] = (0x134..=0x14C).fold(0u8, |c, i| c.wrapping_sub(rom[i]).wrapping_sub(1));
            let mut bus = MemoryBus::new(Cartridge::from_rom(rom).unwrap(), cgb);
            bus.boot_rom_active = false;
            let p = &mut bus.ppu;
            (p.lcdc, p.ly, p.mode, p.mode3_len, p.stat, p.scx) = (0x81, 10, PpuMode::Drawing, 175, 0x08, 3);
            p.mode_clock = 175 - 2 - 1;
            p.start_line();
            p.mode3_len = 175;
            bus.cycle_tick();
            assert!(bus.ppu.mode == PpuMode::HBlank && bus.if_late & STAT_BIT != 0);
            assert_eq!(bus.halt_late_interrupts() & STAT_BIT != 0, cgb, "CGB {cgb}");
        }
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
    fn bus_of_maps_every_region() {
        use Bus::*;
        for (addr, dmg, cgb) in [
            (0x0000, External, External), (0x7FFF, External, External),
            (0x8000, Vram, Vram), (0x9FFF, Vram, Vram),
            (0xA000, External, External), (0xBFFF, External, External),
            (0xC000, External, Wram), (0xDFFF, External, Wram),
            (0xE000, External, Wram), (0xFDFF, External, Wram),
            (0xFE00, Oam, Oam), (0xFEFF, Oam, Oam),
            (0xFF00, Io, Io), (0xFF80, Io, Io), (0xFFFF, Io, Io),
        ] {
            assert_eq!([bus_of(addr, false), bus_of(addr, true)], [dmg, cgb], "{addr:04X}");
        }
    }

    /// $FEA0-$FEFF: $00 on a DMG, RAM (mirrored) on a CGB C, the high nibble twice on a CGB E.
    #[test]
    fn fea0_area_per_model() {
        use crate::gameboy::Revision;
        let mut bus = bus();
        bus.write_byte(0xFEA0, 0x34);
        assert_eq!(bus.read_byte(0xFEA0), 0x00, "DMG");
        bus.cgb_mode = true;
        bus.write_byte(0xFEA1, 0x34);
        assert_eq!([bus.read_byte(0xFEA1), bus.read_byte(0xFEB9), bus.read_byte(0xFEC1)], [0x34, 0x34, 0x00], "CGB C");
        bus.rev = Revision::CgbE;
        assert_eq!(bus.read_byte(0xFEB9), 0xBB, "CGB E");
    }

    /// A DMG write on the DMA's bus lands in OAM as the byte being copied (ANDed with work RAM's
    /// when the DMA reads it), not at its target; a write on the other bus lands.
    #[test]
    fn dmg_write_during_dma_same_bus() {
        let mut bus = bus();
        bus.write_byte(0xFF46, 0xC0);
        for _ in 0..4 { bus.cycle_tick(); }
        bus.cycle_write(0xC001, 0x0A); // the DMA copies byte 3 ($04) this M-cycle
        bus.cycle_write(0x8000, 0x99); // VRAM: the other bus
        for _ in 0..160 { bus.cycle_tick(); }
        assert_eq!(bus.ppu.read_oam(3), 0x0A & 0x04, "work RAM's byte ANDed with the written value");
        assert_eq!(bus.ppu.read_oam(4), 0x05);
        assert_eq!(bus.read_byte(0xC001), 0x02, "the target is untouched");
        assert_eq!(bus.read_byte(0x8000), 0x99);

        bus.write_byte(0xFF46, 0x00); // from ROM (zeros)
        for _ in 0..4 { bus.cycle_tick(); }
        bus.cycle_write(0xC001, 0x0A);
        for _ in 0..160 { bus.cycle_tick(); }
        assert_eq!(bus.ppu.read_oam(3), 0x0A, "from ROM: the written value");
        assert_eq!(bus.read_byte(0xC001), 0x02);
    }

    /// A CGB write on the DMA's bus: OAM gets the value (external bus), $00 (VRAM) or keeps the
    /// DMA's byte (work RAM), and the target is untouched. A work RAM write during a DMA from the
    /// external bus lands in the bank the DMA's address bit 12 picks; from $E000+ the DMA reads $FF.
    #[test]
    fn cgb_write_during_dma_same_bus() {
        let run = |page: u8, addr: u16, value: u8| {
            let mut bus = bus();
            (bus.cgb_mode, bus.ppu.cgb_mode) = (true, true);
            bus.write_byte(0x8001, 0x77);
            bus.write_byte(0xFF46, page);
            for _ in 0..4 { bus.cycle_tick(); }
            bus.cycle_write(addr, value); // the DMA copies byte 3 this M-cycle
            for _ in 0..160 { bus.cycle_tick(); }
            bus
        };
        let b = run(0x00, 0x2000, 0x42);
        assert_eq!(b.ppu.read_oam(3), 0x42, "external bus: the written value");
        let b = run(0x80, 0x8001, 0x42);
        assert_eq!((b.ppu.read_oam(3), b.read_byte(0x8001)), (0x00, 0x77), "VRAM: $00, target untouched");
        let b = run(0xC0, 0xC001, 0x42);
        assert_eq!((b.ppu.read_oam(3), b.read_byte(0xC001)), (0x04, 0x02), "work RAM: the DMA's byte, target untouched");
        let b = run(0x00, 0xD223, 0x42);
        assert_eq!((b.read_byte(0xC223), b.read_byte(0xD223)), (0x42, 0x00), "from $00xx: bank $C000");
        let b = run(0x7F, 0xC223, 0x42);
        assert_eq!((b.read_byte(0xC223), b.read_byte(0xD223)), (0x00, 0x42), "from $7Fxx: bank $D000");
        assert_eq!(run(0xE0, 0xFF80, 0).ppu.read_oam(3), 0xFF, "from $E000: $FF");
    }

    /// The interrupt dispatch pushes PC in its M-cycles 4 and 5: onto a running DMA's bus, the
    /// bytes land in OAM there (Gambatte hwtest `oamdma_src0000_busyint0002`).
    #[test]
    fn dispatch_pushes_in_m_cycles_4_and_5() {
        let mut bus = bus();
        bus.write_byte(0xFF46, 0x00); // from ROM (zeros)
        for _ in 0..4 { bus.cycle_tick(); } // the next M-cycle copies byte 3
        let mut cpu = crate::cpu::Cpu::new();
        (cpu.ime, cpu.regs.sp, cpu.regs.pc) = (true, 0x0002, 0xFF94);
        (bus.interrupts.interrupt_enable, bus.interrupts.interrupt_flag) = (TIMER_BIT, TIMER_BIT);
        cpu.handle_interrupts(&mut bus);
        assert_eq!(cpu.regs.pc, 0x0050);
        for _ in 0..160 { bus.cycle_tick(); }
        let oam: Vec<u8> = (5..9).map(|i| bus.ppu.read_oam(i)).collect();
        assert_eq!(oam, [0x00, 0xFF, 0x94, 0x00], "PC high in M-cycle 4 (byte 6), low in 5 (byte 7)");
    }

    /// HALT holds the OAM DMA after its first M-cycle: a VRAM read after 50 halted M-cycles still
    /// sees the byte copied in that first one.
    #[test]
    fn oam_dma_from_vram_while_halted() {
        let mut bus = bus();
        for i in 0..0xA0 { bus.write_byte(0x8000 + i, 0xA0 - i as u8); }
        bus.write_byte(0xFF46, 0x80);
        for _ in 0..4 { bus.cycle_tick(); } // bytes 0-2 copied
        let mut cpu = crate::cpu::Cpu::new();
        (cpu.halted, cpu.halt_grace) = (true, true);
        for _ in 0..50 { cpu.step(&mut bus).unwrap(); }
        assert_eq!(bus.read_byte(0x8000), 0xA0 - 3, "byte 3, copied in HALT's first M-cycle");
    }

    /// A DMA from $FE00 copies work RAM's $DE00 page on a DMG, $FF on a CGB (the external bus).
    #[test]
    fn dma_from_fe00_copies_per_model() {
        for (cgb, want) in [(false, 0x5A), (true, 0xFF)] {
            let mut bus = bus();
            (bus.cgb_mode, bus.ppu.cgb_mode) = (cgb, cgb);
            bus.write_byte(0xDE07, 0x5A);
            bus.write_byte(0xFF46, 0xFE);
            for _ in 0..162 { bus.cycle_tick(); }
            assert_eq!(bus.read_byte(0xFE07), want, "CGB {cgb}");
        }
    }

    /// A CGB read during a DMA: the DMA's byte on its own bus, $FF on the external bus from
    /// $E000+, work RAM's remapped bank from the external bus, the addressed byte elsewhere; a
    /// VRAM read during a VRAM DMA clears the OAM byte copied that M-cycle.
    #[test]
    fn cgb_conflict_read_per_bus_pair() {
        let start = |page: u8| {
            let mut bus = bus();
            (bus.cgb_mode, bus.ppu.cgb_mode) = (true, true);
            bus.write_byte(0x8003, 0x77);
            bus.write_byte(0xFF46, page);
            for _ in 0..4 { bus.cycle_tick(); }
            bus
        };
        let mut b = start(0xC0); // work RAM
        assert_eq!(b.cycle_read(0xD123), 0x04, "work RAM: the DMA's byte ($C003)");
        assert_eq!(b.cycle_read(0x0100), 0x00, "external: its own byte");
        let mut b = start(0x00); // ROM (zeros)
        assert_eq!(b.cycle_read(0xD003), 0x04, "work RAM from the external bus: bank $C000");
        assert_eq!(b.cycle_read(0x8003), 0x77, "VRAM: its own byte");
        let mut b = start(0xE0);
        assert_eq!(b.cycle_read(0x0100), 0xFF, "external, DMA from $E000: $FF");
        let mut b = start(0x80); // VRAM
        assert_eq!(b.cycle_read(0x9000), 0x77, "VRAM: the DMA's byte ($8003)");
        for _ in 0..160 { b.cycle_tick(); }
        assert_eq!(b.ppu.read_oam(3), 0x00, "the byte copied that M-cycle is cleared");
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

    /// The speed-switch pause holds the OAM DMA from STOP's second M-cycle on, as HALT does: a DMA
    /// with its last byte still to copy then keeps OAM through the pause (Gambatte
    /// `oamdma/oamdma_late_speedchange_stat_1/_2`, `oamdmasrcC0_speedchange_readC000`).
    #[test]
    fn speed_switch_pause_holds_the_oam_dma() {
        for (left, held) in [(2u8, true), (1, false)] {
            let mut bus = bus();
            bus.cgb_mode = true;
            (bus.dma_active, bus.dma_index) = (true, 0xA0 - left);
            bus.write_byte(0xFF4D, 0x01);
            assert!(bus.try_speed_switch());
            assert_eq!(bus.dma_active, held, "{left} byte(s) left at STOP");
            assert!(!bus.dma_hold);
            bus.cycle_tick();
            bus.cycle_tick();
            assert!(!bus.dma_active, "done once the CPU runs again");
        }
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

    /// The divider stops for two M-cycles on a CGB B/C, one on a CGB E (Age spsw-interrupts).
    #[test]
    fn a_pending_interrupt_skips_the_pause_but_stops_the_divider() {
        use crate::gameboy::Revision;
        for (rev, held) in [(Revision::Default, 2), (Revision::CgbC, 2), (Revision::CgbE, 1)] {
            let mut bus = bus();
            bus.cgb_mode = true;
            bus.rev = rev;
            bus.interrupts.interrupt_enable = VBLANK_BIT;
            bus.interrupts.interrupt_flag = VBLANK_BIT;
            bus.write_byte(0xFF4D, 0x01);
            bus.cycle_count = 0;
            assert!(bus.try_speed_switch());
            assert_eq!(bus.cycle_count, 2 * 4, "STOP's two M-cycles, no pause");
            for _ in 0..held { bus.cycle_tick(); }
            assert_eq!(bus.timer.div_counter, 0, "{rev:?}: held for {held} M-cycles");
            bus.cycle_tick();
            assert_eq!(bus.timer.div_counter, 4, "{rev:?}");
        }
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

    /// DMG line 10 from its first dot, SCX `scx`, the mode-0 STAT interrupt enabled.
    fn line10_mode0_irq(scx: u8) -> MemoryBus {
        let mut bus = bus();
        let p = &mut bus.ppu;
        (p.lcdc, p.ly, p.mode, p.mode_clock, p.stat, p.scx) = (0x81, 10, crate::ppu::PpuMode::OamScan, 0, 0x08, scx);
        bus.interrupts.interrupt_enable = STAT_BIT;
        bus
    }

    /// The mode-0 edge lands 250 + SCX dots into the line (Pan Docs' 80 + 172 + SCX, less
    /// `MODE0_EARLY`): IF.1 is set in M-cycle 63 for SCX 0-2, 64 for 3-6, 65 for 7, so the next
    /// opcode fetch dispatches it, but an IF read in that M-cycle still sees it clear
    /// (gbmicrotest `hblank_int_scx0..7_if_a/b/c`: 35, 35, 35, 36, 36, 36, 36, 37 NOPs).
    #[test]
    fn mode0_if_rises_per_scx() {
        let rises: Vec<u32> = (0..8).map(|scx| {
            let mut bus = line10_mode0_irq(scx);
            let mut m = 0;
            while bus.interrupts.interrupt_flag & STAT_BIT == 0 {
                bus.cycle_tick();
                m += 1;
                assert!(m < 114, "SCX {scx}: no mode-0 interrupt");
            }
            assert_eq!(bus.read_byte(0xFF0F) & STAT_BIT, 0, "SCX {scx}: an IF read in M-cycle {m} misses it");
            bus.cycle_tick();
            assert_eq!(bus.read_byte(0xFF0F) & STAT_BIT, STAT_BIT, "SCX {scx}: seen in M-cycle {}", m + 1);
            m
        }).collect();
        assert_eq!(rises, [63, 63, 63, 64, 64, 64, 64, 65]);
    }

    /// A halted CPU samples IF halfway through the M-cycle: an edge in the second half of it wakes
    /// HALT one M-cycle later than a running CPU dispatches: after M-cycle 63 for SCX 0, 64 for 1-4,
    /// 65 for 5-7 (Mooneye `hblank_ly_scx_timing-GS`: SCX 1-4 one M-cycle after SCX 0).
    #[test]
    fn mode0_irq_wakes_halt_on_edge_mcycle() {
        let wakes: Vec<u32> = (0..8).map(|scx| {
            let mut bus = line10_mode0_irq(scx);
            let mut cpu = crate::cpu::Cpu::new();
            cpu.halted = true;
            let mut m = 0;
            loop {
                cpu.handle_interrupts(&mut bus);
                if !cpu.halted { break m; }
                bus.cycle_tick();
                m += 1;
                assert!(m < 114, "SCX {scx}: HALT never woke");
            }
        }).collect();
        assert_eq!(wakes, [63, 64, 64, 64, 64, 65, 65, 65]);
    }

    /// Line 144's IF.0 and mode-1 STAT edge rise late in their M-cycle: an IF read in it misses
    /// them and an IF write in it doesn't clear them; the next M-cycle reads them
    /// (gbmicrotest `vblank2_int_if_a..d`, `vblank_int_if_a..d`).
    #[test]
    fn vblank_if_rises_on_line_144_mcycle() {
        for clear in [false, true] {
            let mut bus = bus();
            let p = &mut bus.ppu;
            (p.lcdc, p.ly, p.mode, p.mode_clock, p.stat) = (0x81, 143, crate::ppu::PpuMode::HBlank, 0, 0x10);
            while bus.interrupts.interrupt_flag & VBLANK_BIT == 0 { bus.cycle_tick(); }
            assert_eq!(bus.ppu.ly, 144);
            assert_eq!(bus.read_byte(0xFF0F) & 3, 0, "not seen in its own M-cycle");
            if clear { bus.write_byte(0xFF0F, 0); }
            bus.cycle_tick();
            assert_eq!(bus.read_byte(0xFF0F) & 3, 3, "seen the next M-cycle (write in between: {clear})");
        }
    }

    /// A dispatch takes the timer interrupt already requested; TIMA overflowing again in its M4
    /// is taken with it (IF.2 clear afterwards), in its M5 it retriggers (IF.2 set) on a DMG: the
    /// bit is let go at M5's sampling point, which the TIMA reload misses there but not on a CGB
    /// (Gambatte `tc00_irq_late_retrigger_1..3`).
    #[test]
    fn source_rising_after_dispatch_clear_retriggers() {
        for (m, cgb, retriggers) in [(3, false, false), (4, false, false), (5, false, true), (4, true, false), (5, true, false)] {
            let mut bus = bus();
            bus.cgb_mode = cgb;
            // TAC 4: DIV bit 9 falls when the counter reaches $400, `m` M-cycles into the dispatch.
            (bus.timer.div_counter, bus.timer.tima, bus.timer.tac) = (0x400 - 4 * m, 0xFF, 0x04);
            (bus.interrupts.interrupt_enable, bus.interrupts.interrupt_flag) = (TIMER_BIT, TIMER_BIT);
            let mut cpu = crate::cpu::Cpu::new();
            (cpu.ime, cpu.regs.sp, cpu.regs.pc) = (true, 0xD000, 0x1234);
            cpu.handle_interrupts(&mut bus);
            assert_eq!(cpu.regs.pc, 0x50, "M{m}: dispatched");
            assert_eq!(bus.timer.tima, 0x00, "M{m}: overflowed during the dispatch");
            assert_eq!(bus.interrupts.interrupt_flag & TIMER_BIT != 0, retriggers, "overflow in M{m}, CGB {cgb}");
        }
    }

    /// An IF write comes later in its M-cycle than a read: a mode-0 edge in the M-cycle's first
    /// dot (SCX 3) is missed by a read but cleared by a write; a later one (SCX 4) survives it
    /// (Gambatte `m2int_m0irq_scx3_ifw_1..4`, `_ds_1/2`).
    #[test]
    fn if_write_sees_a_mode0_edge_of_the_first_dot() {
        for (scx, cleared) in [(3, true), (4, false)] {
            let mut bus = line10_mode0_irq(scx);
            while bus.interrupts.interrupt_flag & STAT_BIT == 0 { bus.cycle_tick(); }
            assert_eq!(bus.read_byte(0xFF0F) & STAT_BIT, 0, "SCX {scx}: a read misses it");
            bus.write_byte(0xFF0F, 0);
            bus.cycle_tick();
            assert_eq!(bus.read_byte(0xFF0F) & STAT_BIT == 0, cleared, "SCX {scx}");
        }
    }

    /// SC's unused bits read 1, and bit 1 (the fast clock) only exists in Color mode: $FF/$FD
    /// while a transfer runs, $7F/$7D once done. The last M-cycle of a transfer still reads it
    /// running, and stopping it there (SC bit 7 or bit 0 cleared) keeps its interrupt from firing
    /// (Gambatte `start_wait_read_sc_1/2`, `start_wait_stop_read_if_1/2`, `start_wait_sc80_read_if_1/2`).
    #[test]
    fn sc_reads_unused_bits_per_model() {
        for (cgb, busy, done) in [(false, 0xFF, 0x7F), (true, 0xFD, 0x7D)] {
            let last_cycle = || {
                let mut bus = bus();
                bus.cgb_mode = cgb;
                (bus.serial.control, bus.serial.remaining) = (0x81, 4);
                bus.cycle_tick();
                bus
            };
            let mut bus = last_cycle();
            assert_eq!(bus.read_byte(0xFF02), busy, "CGB {cgb}: the last M-cycle");
            bus.cycle_tick();
            assert_eq!(bus.read_byte(0xFF02), done, "CGB {cgb}: done");
            assert_ne!(bus.interrupts.interrupt_flag & SERIAL_BIT, 0);
            for stop in [0x01, 0x80] {
                let mut bus = last_cycle();
                bus.write_byte(0xFF02, stop);
                bus.cycle_tick();
                assert_eq!(bus.interrupts.interrupt_flag & SERIAL_BIT, 0, "CGB {cgb}: SC = {stop:#x} in the last M-cycle");
                assert_eq!(bus.read_byte(0xFF01), 0x7F, "7 bits in");
            }
        }
    }

    /// The timer's and the serial port's requests reach IF late in their M-cycle, like the PPU's
    /// (`raise_late`): an IF read in it misses them, an IF write in it doesn't clear them.
    #[test]
    fn if_write_in_the_rising_cycle_keeps_the_request() {
        for (bit, arm) in [
            // TIMA at $FF, one M-cycle before TAC 1's input bit (DIV bit 3) falls.
            (TIMER_BIT, (|b: &mut MemoryBus| (b.timer.div_counter, b.timer.tima, b.timer.tac) = (0x000C, 0xFF, 0x05)) as fn(&mut MemoryBus)),
            // A transfer's last internal-clock M-cycle.
            (SERIAL_BIT, |b: &mut MemoryBus| (b.serial.control, b.serial.remaining) = (0x81, 4)),
        ] {
            for clear in [false, true] {
                let mut bus = bus();
                arm(&mut bus);
                bus.cycle_tick();
                assert_ne!(bus.interrupts.interrupt_flag & bit, 0, "{bit:#x}: requested");
                assert_eq!(bus.read_byte(0xFF0F) & bit, 0, "{bit:#x}: not seen in its own M-cycle");
                if clear { bus.write_byte(0xFF0F, 0); }
                bus.cycle_tick();
                assert_eq!(bus.read_byte(0xFF0F) & bit, bit, "{bit:#x}: seen the next M-cycle (write in between: {clear})");
            }
        }
    }

    /// A Color bus with the VRAM DMA pointed from $C000 to $8000.
    fn cgb_bus(lcd: u8) -> MemoryBus {
        let mut bus = bus();
        (bus.cgb_mode, bus.ppu.cgb_mode) = (true, true);
        bus.write_byte(0xFF40, lcd);
        for (addr, value) in [(0xFF51, 0xC0), (0xFF52, 0x00), (0xFF53, 0x00), (0xFF54, 0x00)] {
            bus.write_byte(addr, value);
        }
        bus
    }

    /// A GDMA waits for the CPU's next opcode fetch, then moves 2 bytes per M-cycle in single
    /// speed (1 in double speed) after a lead-in: 8n + 1 M-cycles (16n + 1) for n blocks.
    #[test]
    fn gdma_moves_two_bytes_per_m_cycle() {
        for (ds, blocks, m_cycles) in [(false, 1u32, 9u32), (false, 2, 17), (true, 1, 17), (true, 2, 33)] {
            let mut bus = cgb_bus(0x00);
            (bus.double_speed, bus.ppu.m_cycle_dots) = (ds, if ds { 2 } else { 4 });
            bus.write_byte(0xFF55, blocks as u8 - 1);
            assert!(bus.hdma_on && bus.ppu.vram[0] == 0, "nothing moves before the fetch");
            bus.cycle_count = 0;
            bus.hdma_run();
            assert_eq!(bus.cycle_count, m_cycles * if ds { 2 } else { 4 }, "ds {ds}, {blocks} blocks");
            assert_eq!(bus.read_byte(0xFF55), 0xFF);
            assert!((0..16 * blocks as usize).all(|i| bus.ppu.vram[i] == i as u8 + 1), "ds {ds}, {blocks} blocks");
        }
    }

    /// Runs the PPU to line 10 at `mode` with `mode_clock` at least `dot`.
    fn to_line_10(bus: &mut MemoryBus, mode: PpuMode, dot: u32) {
        while !(bus.ppu.ly == 10 && bus.ppu.mode == mode && bus.ppu.mode_clock >= dot) {
            bus.cycle_tick();
        }
    }

    /// A CPU halted before a line's HBlank DMA request skips it, and runs it on waking in that
    /// HBlank; halted after the request (the block done), it has nothing to run.
    #[test]
    fn hdma_block_runs_during_halt() {
        let mut bus = cgb_bus(0x91);
        to_line_10(&mut bus, PpuMode::OamScan, 8);
        bus.write_byte(0xFF55, 0x81); // 2 blocks, mode 2: nothing due yet
        assert!(!bus.hdma_on);
        bus.hdma_halt();
        while !(bus.ppu.mode == PpuMode::HBlank && bus.ppu.mode_clock >= 20) {
            bus.cycle_tick();
            bus.hdma_halted();
        }
        assert_eq!((bus.hdma_on, bus.hdma_missed, bus.hdma5), (false, true, 0x01), "slept through");
        bus.hdma_unhalt();
        assert!(bus.hdma_on, "woken in HBlank");
        bus.hdma_run();
        assert_eq!(bus.hdma5, 0x00);

        let mut bus = cgb_bus(0x91);
        to_line_10(&mut bus, PpuMode::OamScan, 8);
        bus.write_byte(0xFF55, 0x81);
        to_line_10(&mut bus, PpuMode::HBlank, 20);
        bus.hdma_run(); // the request came to a running CPU
        bus.hdma_halt();
        bus.hdma_halted();
        bus.hdma_unhalt();
        assert!(!bus.hdma_on, "halted after the request: nothing left for this line");
    }

    /// The pause after a speed switch is a HALT to the HBlank DMA: no block moves in it.
    #[test]
    fn hdma_waits_for_speed_switch_pause() {
        let mut bus = cgb_bus(0x91);
        to_line_10(&mut bus, PpuMode::OamScan, 8);
        bus.write_byte(0xFF55, 0x81);
        bus.write_byte(0xFF4D, 0x01);
        assert!(bus.try_speed_switch());
        assert!(bus.double_speed);
        assert_eq!(bus.hdma5, 0x01, "both blocks still to go");
        assert!(bus.ppu.vram[..32].iter().all(|&b| b == 0));
    }
}
