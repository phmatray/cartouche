use crate::cartridge::{Cartridge, MAPPER_STATE_LEN};
use crate::cpu::Cpu;
use crate::error::EmulatorError;
use crate::memory::MemoryBus;

pub const CYCLES_PER_FRAME: u32 = 70224;

/// Which console to emulate.
#[derive(Clone, Copy, PartialEq, Eq, Debug)]
pub enum Model {
    /// CGB when the header's $0143 bit 7 says the cart supports it, DMG otherwise.
    Auto,
    /// DMG even for CGB-compatible ($80) carts, like a real DMG would run them.
    Dmg,
}

/// The machine a save state belongs to: a state from one never loads into another.
#[derive(Clone, Copy, PartialEq, Eq, Debug)]
pub enum Console {
    Dmg = 0,
    Cgb = 1,
    /// A CGB running a DMG-only cartridge in compatibility mode (colourised by its boot ROM).
    Compat = 2,
    /// A Super Game Boy (a DMG with the SNES side's palettes and border, see sgb.rs).
    Sgb = 3,
}

pub struct GameBoy {
    pub cpu: Cpu,
    pub bus: MemoryBus,
    pub cgb_mode: bool,
    pub double_speed: bool,
    /// Cycles already run of a frame cut short by a stalled remote-link transfer.
    frame_cycles: u32,
    pub console: Console,
    /// The palette a colourised DMG cartridge was switched on with (`with_boot`), else 0.
    pub palette: u8,
}

impl GameBoy {
    pub fn new(rom_data: Vec<u8>) -> Result<Self, EmulatorError> {
        Self::with_model(rom_data, Model::Auto)
    }

    /// Starts like the real console, with SameBoy's boot ROMs mapped (see boot_rom.rs).
    /// `colorize`: a DMG-only cartridge runs on a CGB, whose boot ROM picks its colours (always
    /// run: the palettes come from it). `palette`: 0 automatic, 1-12 the palette a real GBC gives
    /// when a combination is held during the logo (1-4 Right, Left, Up, Down; 5-8 the same + A;
    /// 9-12 + B). `animation`: false starts from the post-boot state (DMG and CGB cartridges) or
    /// runs the boot ROM unseen (`finish_boot`, colourised DMG cartridges).
    pub fn with_boot(rom_data: Vec<u8>, colorize: bool, palette: u8, animation: bool) -> Result<Self, EmulatorError> {
        let cartridge = Cartridge::from_rom(rom_data)?;
        let cgb_cart = cartridge.cgb_mode();
        let cgb = cgb_cart || colorize;
        let mut gb = GameBoy {
            cpu: Cpu::new(),
            bus: MemoryBus::new(cartridge, cgb),
            cgb_mode: cgb,
            double_speed: false,
            frame_cycles: 0,
            console: if cgb_cart { Console::Cgb } else if cgb { Console::Compat } else { Console::Dmg },
            palette: 0,
        };
        gb.bus.boot_rom = if cgb { &crate::boot_rom::SAMEBOY_CGB[..] } else { &crate::boot_rom::SAMEBOY_DMG[..] };
        if gb.console == Console::Compat {
            gb.palette = if palette <= 12 { palette } else { 0 };
            gb.hold_palette();
            if !animation {
                gb.finish_boot()?;
            }
        } else if !animation {
            gb.skip_boot_rom();
        }
        Ok(gb)
    }

    /// A Super Game Boy, from its boot ROM (`animation`) or its post-boot state. The cartridge
    /// runs as on a DMG, even a Game Boy Color one; without SGB support it is an ordinary DMG.
    pub fn with_sgb(rom_data: Vec<u8>, animation: bool) -> Result<Self, EmulatorError> {
        // Header $0146 = $03 with the old licensee $33, as the SGB checks.
        if rom_data.get(0x146) != Some(&0x03) || rom_data.get(0x14B) != Some(&0x33) {
            return Self::with_boot(rom_data, false, 0, animation);
        }
        let mut gb = Self::with_model(rom_data, Model::Dmg)?;
        gb.console = Console::Sgb;
        gb.bus.sgb = Some(Box::default());
        gb.bus.boot_rom = &crate::boot_rom::SAMEBOY_SGB[..];
        if !animation {
            gb.skip_boot_rom();
        }
        Ok(gb)
    }

    /// Runs the boot ROM to its end without showing it (a skipped start-up animation).
    pub fn finish_boot(&mut self) -> Result<(), EmulatorError> {
        for _ in 0..900 {
            if !self.bus.boot_rom_active {
                break;
            }
            self.run_frame()?;
        }
        self.bus.apu.clear_samples();
        Ok(())
    }

    /// Holds the direction/A/B combination of `palette` until the boot ROM unmaps itself.
    fn hold_palette(&mut self) {
        self.bus.joypad.boot_hold = match self.palette {
            p @ 1..=12 => [1 << ((p - 1) % 4), [0, 1, 2][(p - 1) as usize / 4]],
            _ => [0, 0],
        };
    }

    /// The picture shown, 160x144 RGBA: the PPU's, or on a Super Game Boy the one it coloured.
    pub fn screen(&self) -> &[u8] {
        self.bus.sgb.as_deref().map_or(&self.bus.ppu.framebuffer[..], |s| &s.out[..])
    }

    /// The picture is in colour: a CGB cartridge, or a DMG one colourised by the CGB.
    pub fn in_colour(&self) -> bool {
        self.console != Console::Dmg
    }

    /// The model is fixed here, before any post-boot state is applied.
    pub fn with_model(rom_data: Vec<u8>, model: Model) -> Result<Self, EmulatorError> {
        let cartridge = Cartridge::from_rom(rom_data)?;
        let cgb_mode = cartridge.cgb_mode() && model == Model::Auto;
        let bus = MemoryBus::new(cartridge, cgb_mode);
        let cpu = Cpu::new();
        let console = if cgb_mode { Console::Cgb } else { Console::Dmg };
        let mut gb = GameBoy { cpu, bus, cgb_mode, double_speed: false, frame_cycles: 0, console, palette: 0 };
        // The built-in boot ROM is a DMG one: it hands over with A=$01, which CGB software reads
        // as "running on a DMG" (CGB-only titles then show their "GBC only" screen, dual-mode
        // titles fall back to monochrome). CGB carts therefore start from the CGB post-boot state.
        if cgb_mode {
            gb.skip_boot_rom();
        }
        Ok(gb)
    }

    pub fn skip_boot_rom(&mut self) {
        if self.cgb_mode {
            self.cpu.regs.a = 0x11;
            self.cpu.regs.f = 0x80;
            self.cpu.regs.b = 0x00;
            self.cpu.regs.c = 0x00;
            self.cpu.regs.d = 0xFF;
            self.cpu.regs.e = 0x56;
            self.cpu.regs.h = 0x00;
            self.cpu.regs.l = 0x0D;
        } else if self.console == Console::Sgb {
            self.cpu.regs.a = 0x01;
            self.cpu.regs.f = 0x00;
            self.cpu.regs.b = 0x00;
            self.cpu.regs.c = 0x14;
            self.cpu.regs.d = 0x00;
            self.cpu.regs.e = 0x00;
            self.cpu.regs.h = 0xC0;
            self.cpu.regs.l = 0x60;
        } else {
            self.cpu.regs.a = 0x01;
            self.cpu.regs.f = 0xB0;
            self.cpu.regs.b = 0x00;
            self.cpu.regs.c = 0x13;
            self.cpu.regs.d = 0x00;
            self.cpu.regs.e = 0xD8;
            self.cpu.regs.h = 0x01;
            self.cpu.regs.l = 0x4D;
        }
        self.cpu.regs.sp = 0xFFFE;
        self.cpu.regs.pc = 0x0100;

        self.bus.boot_rom_active = false;
        self.bus.timer.div_counter = 0xABCC;
        self.bus.interrupts.interrupt_flag = 0xE1;
        self.bus.ppu.lcdc = 0x91;
        self.bus.ppu.bgp = 0xFC;
        self.bus.ppu.obp0 = 0xFF;
        self.bus.ppu.obp1 = 0xFF;
        self.bus.ppu.ly = 153;
        self.bus.ppu.mode = crate::ppu::PpuMode::VBlank;
        self.bus.ppu.mode_clock = 396;

        self.bus.apu.write_register(0xFF26, 0x80);
        self.bus.apu.write_register(0xFF24, 0x77);
        self.bus.apu.write_register(0xFF25, 0xFF);

        if self.cgb_mode {
            self.bus.wram_bank = 1;
            self.bus.ppu.vram_bank = 0;
            // The CGB boot ROM leaves every background palette white ($7FFF).
            for pair in self.bus.ppu.bg_cram.chunks_mut(2) {
                pair.copy_from_slice(&[0xFF, 0x7F]);
            }
        }
    }

    /// Runs one frame's worth of cycles. With a remote link, returns early while a transfer waits
    /// for the partner's byte (`bus.serial.stalled()`); the next call finishes that frame.
    pub fn run_frame(&mut self) -> Result<(), EmulatorError> {
        if self.frame_cycles == 0 {
            self.bus.ppu.frame_ready = false;
        }
        while self.frame_cycles < CYCLES_PER_FRAME {
            if self.bus.serial.stalled() {
                return Ok(());
            }
            self.bus.cycle_count = 0;
            self.cpu.handle_interrupts(&mut self.bus);
            self.cpu.step(&mut self.bus)?;
            self.frame_cycles += self.bus.cycle_count;
            self.double_speed = self.bus.double_speed;
        }
        self.frame_cycles = 0;
        Ok(())
    }

    /// Runs up to the next VBlank entry, so a traced frame is complete when it returns `true`.
    /// Returns `false` after two frames' worth of cycles without one (LCD off).
    pub fn run_to_vblank(&mut self) -> Result<bool, EmulatorError> {
        self.bus.ppu.frame_ready = false;
        let mut total = 0;
        while !self.bus.ppu.frame_ready {
            if total >= 2 * CYCLES_PER_FRAME {
                return Ok(false);
            }
            total += self.step_instruction()?;
        }
        Ok(true)
    }

    pub fn step_instruction(&mut self) -> Result<u32, EmulatorError> {
        self.bus.cycle_count = 0;
        self.cpu.handle_interrupts(&mut self.bus);
        self.cpu.step(&mut self.bus)?;
        self.double_speed = self.bus.double_speed;
        Ok(self.bus.cycle_count)
    }

    pub fn save_state(&self) -> Vec<u8> {
        let mut data = Vec::with_capacity(65536);

        data.extend_from_slice(SAVE_MAGIC);
        data.extend_from_slice(&SAVE_VERSION.to_le_bytes());
        data.push(self.console as u8);
        data.push(self.palette);

        data.push(self.cpu.regs.a);
        data.push(self.cpu.regs.f);
        data.push(self.cpu.regs.b);
        data.push(self.cpu.regs.c);
        data.push(self.cpu.regs.d);
        data.push(self.cpu.regs.e);
        data.push(self.cpu.regs.h);
        data.push(self.cpu.regs.l);
        data.extend_from_slice(&self.cpu.regs.sp.to_le_bytes());
        data.extend_from_slice(&self.cpu.regs.pc.to_le_bytes());

        data.push(self.cpu.ime as u8);
        data.push(self.cpu.halted as u8);
        data.push(self.cpu.halt_bug as u8);

        data.push(self.bus.interrupts.interrupt_enable);
        data.push(self.bus.interrupts.interrupt_flag);

        data.extend_from_slice(&self.bus.timer.div_counter.to_le_bytes());
        data.push(self.bus.timer.tima);
        data.push(self.bus.timer.tma);
        data.push(self.bus.timer.tac);

        data.extend_from_slice(&self.bus.wram);
        data.push(self.bus.wram_bank);
        data.extend_from_slice(&self.bus.hram);

        data.extend_from_slice(&self.bus.ppu.vram);
        data.push(self.bus.ppu.vram_bank);
        data.extend_from_slice(&self.bus.ppu.oam);
        data.push(self.bus.ppu.lcdc);
        data.push(self.bus.ppu.stat);
        data.push(self.bus.ppu.scy);
        data.push(self.bus.ppu.scx);
        data.push(self.bus.ppu.ly);
        data.push(self.bus.ppu.lyc);
        data.push(self.bus.ppu.bgp);
        data.push(self.bus.ppu.obp0);
        data.push(self.bus.ppu.obp1);
        data.push(self.bus.ppu.wy);
        data.push(self.bus.ppu.wx);
        data.push(self.bus.ppu.mode as u8);
        data.extend_from_slice(&self.bus.ppu.mode_clock.to_le_bytes());
        data.push(self.bus.ppu.window_line_counter);
        data.push(self.bus.ppu.frame_ready as u8);

        data.push(self.bus.boot_rom_active as u8);

        let ram = self.bus.cartridge.export_sram();
        data.extend_from_slice(&(ram.len() as u32).to_le_bytes());
        data.extend_from_slice(&ram);

        data.push(self.bus.joypad.select);
        data.push(self.bus.joypad.button_state);
        data.push(self.bus.joypad.dpad_state);

        data.push(self.bus.cgb_mode as u8);
        data.push(self.bus.double_speed as u8);

        // CGB colour RAM.
        data.extend_from_slice(&self.bus.ppu.bg_cram);
        data.extend_from_slice(&self.bus.ppu.obj_cram);
        data.push(self.bus.ppu.bcps);
        data.push(self.bus.ppu.ocps);

        // Version 3: mapper registers and the remaining machine state a fresh instance lacks.
        data.extend_from_slice(&self.bus.cartridge.export_state());
        let b = &self.bus;
        data.extend_from_slice(&b.hdma_source.to_le_bytes());
        data.extend_from_slice(&b.hdma_dest.to_le_bytes());
        data.extend_from_slice(&[b.hdma_remaining, b.hdma_active as u8, b.hdma5, b.key1]);
        data.extend_from_slice(&[b.dma_active as u8, b.dma_cycles_remaining]);
        data.extend_from_slice(&[b.ppu.window_was_active as u8, b.ppu.lcd_on_line0 as u8, b.ppu.stat_irq_line as u8]);
        data.extend_from_slice(&[self.cpu.ime_pending as u8, self.cpu.stopped as u8]);
        let sr = &self.bus.serial;
        data.extend_from_slice(&[sr.data, sr.control, sr.incoming]);
        data.extend_from_slice(&sr.remaining.to_le_bytes());
        self.bus.apu.export_state(&mut data);
        if let Some(s) = &self.bus.sgb { s.export_state(&mut data); }

        data
    }

    /// The console a state was saved on (`None`: not a state this core reads). A v3 state
    /// predates colourised DMG cartridges: it was saved on the cartridge's own console.
    pub fn state_console(&self, data: &[u8]) -> Option<Console> {
        if data.len() < 9 || &data[0..4] != SAVE_MAGIC { return None; }
        match u32::from_le_bytes([data[4], data[5], data[6], data[7]]) {
            3 => Some(if self.bus.cartridge.cgb_mode() { Console::Cgb } else { Console::Dmg }),
            SAVE_VERSION => [Console::Dmg, Console::Cgb, Console::Compat, Console::Sgb].get(data[8] as usize).copied(),
            _ => None,
        }
    }

    /// A state loads on the console it was saved on, or a Game Boy one on a Super Game Boy
    /// (the same machine; the SGB side then starts fresh).
    pub fn load_state(&mut self, data: &[u8]) -> bool {
        match (self.state_console(data), self.console) {
            (Some(a), b) if a == b => {}
            (Some(Console::Dmg), Console::Sgb) => {}
            _ => return false,
        }
        let version = u32::from_le_bytes([data[4], data[5], data[6], data[7]]);

        let mut pos = if version == 3 { 8 } else { 10 };
        self.palette = if version == 3 { 0 } else { *data.get(9).unwrap_or(&0) };

        macro_rules! read_u8 {
            () => {{
                if pos >= data.len() { return false; }
                let v = data[pos]; pos += 1; v
            }};
        }
        macro_rules! read_u16 {
            () => {{
                if pos + 2 > data.len() { return false; }
                let v = u16::from_le_bytes([data[pos], data[pos + 1]]); pos += 2; v
            }};
        }
        macro_rules! read_u32 {
            () => {{
                if pos + 4 > data.len() { return false; }
                let v = u32::from_le_bytes([data[pos], data[pos+1], data[pos+2], data[pos+3]]); pos += 4; v
            }};
        }
        macro_rules! read_bytes {
            ($n:expr) => {{
                if pos + $n > data.len() { return false; }
                let slice = &data[pos..pos + $n]; pos += $n; slice
            }};
        }

        self.cpu.regs.a = read_u8!();
        self.cpu.regs.f = read_u8!();
        self.cpu.regs.b = read_u8!();
        self.cpu.regs.c = read_u8!();
        self.cpu.regs.d = read_u8!();
        self.cpu.regs.e = read_u8!();
        self.cpu.regs.h = read_u8!();
        self.cpu.regs.l = read_u8!();
        self.cpu.regs.sp = read_u16!();
        self.cpu.regs.pc = read_u16!();

        self.cpu.ime = read_u8!() != 0;
        self.cpu.halted = read_u8!() != 0;
        self.cpu.halt_bug = read_u8!() != 0;

        self.bus.interrupts.interrupt_enable = read_u8!();
        self.bus.interrupts.interrupt_flag = read_u8!();

        self.bus.timer.div_counter = read_u16!();
        self.bus.timer.tima = read_u8!();
        self.bus.timer.tma = read_u8!();
        self.bus.timer.tac = read_u8!();

        let wram = read_bytes!(0x8000);
        self.bus.wram.copy_from_slice(wram);
        self.bus.wram_bank = (read_u8!() & 7).max(1); // clamped: a damaged state must not index out of WRAM
        let hram = read_bytes!(0x7F);
        self.bus.hram.copy_from_slice(hram);

        let vram = read_bytes!(0x4000);
        self.bus.ppu.vram.copy_from_slice(vram);
        self.bus.ppu.vram_bank = read_u8!() & 1;
        let oam = read_bytes!(0xA0);
        self.bus.ppu.oam.copy_from_slice(oam);
        self.bus.ppu.lcdc = read_u8!();
        self.bus.ppu.stat = read_u8!();
        self.bus.ppu.scy = read_u8!();
        self.bus.ppu.scx = read_u8!();
        self.bus.ppu.ly = read_u8!();
        self.bus.ppu.lyc = read_u8!();
        self.bus.ppu.bgp = read_u8!();
        self.bus.ppu.obp0 = read_u8!();
        self.bus.ppu.obp1 = read_u8!();
        self.bus.ppu.wy = read_u8!();
        self.bus.ppu.wx = read_u8!();
        self.bus.ppu.mode = match read_u8!() {
            0 => crate::ppu::PpuMode::HBlank,
            1 => crate::ppu::PpuMode::VBlank,
            2 => crate::ppu::PpuMode::OamScan,
            _ => crate::ppu::PpuMode::Drawing,
        };
        self.bus.ppu.mode_clock = read_u32!();
        self.bus.ppu.window_line_counter = read_u8!();
        self.bus.ppu.frame_ready = read_u8!() != 0;

        self.bus.boot_rom_active = read_u8!() != 0;

        let ram_len = read_u32!() as usize;
        if pos + ram_len > data.len() { return false; }
        let ram_data = &data[pos..pos + ram_len]; pos += ram_len;
        self.bus.cartridge.import_sram(ram_data);

        self.bus.joypad.select = read_u8!();
        // The held buttons are the player's live input, not the state's: skip them, or a button
        // held at the save stays pressed after a load (the host sends no release for it).
        pos += 2;

        self.bus.cgb_mode = read_u8!() != 0;
        self.cgb_mode = self.bus.cgb_mode;
        self.bus.ppu.cgb_mode = self.cgb_mode;
        self.bus.ppu.compat = self.console == Console::Compat && !self.bus.boot_rom_active;
        self.bus.joypad.boot_hold = [0, 0];
        if self.bus.boot_rom_active { self.hold_palette(); } // a state saved during the animation keeps its colours
        self.bus.double_speed = read_u8!() != 0;
        self.double_speed = self.bus.double_speed;
        self.bus.ppu.bg_cram.copy_from_slice(read_bytes!(64));
        self.bus.ppu.obj_cram.copy_from_slice(read_bytes!(64));
        self.bus.ppu.bcps = read_u8!();
        self.bus.ppu.ocps = read_u8!();

        let mapper: &[u8; MAPPER_STATE_LEN] = read_bytes!(MAPPER_STATE_LEN).try_into().unwrap();
        self.bus.cartridge.import_state(mapper);
        self.bus.hdma_source = read_u16!();
        self.bus.hdma_dest = read_u16!();
        self.bus.hdma_remaining = read_u8!();
        self.bus.hdma_active = read_u8!() != 0;
        self.bus.hdma5 = read_u8!();
        self.bus.key1 = read_u8!();
        self.bus.dma_active = read_u8!() != 0;
        self.bus.dma_cycles_remaining = read_u8!();
        self.bus.ppu.window_was_active = read_u8!() != 0;
        self.bus.ppu.lcd_on_line0 = read_u8!() != 0;
        self.bus.ppu.stat_irq_line = read_u8!() != 0;
        self.cpu.ime_pending = read_u8!() != 0;
        self.cpu.stopped = read_u8!() != 0;
        self.bus.serial.data = read_u8!();
        self.bus.serial.control = read_u8!();
        self.bus.serial.incoming = read_u8!();
        self.bus.serial.remaining = read_u32!();
        if !self.bus.apu.import_state(data, &mut pos) { return false; }
        if let Some(s) = self.bus.sgb.as_deref_mut() {
            if !s.import_state(data, &mut pos) { return false; }
        }

        let _ = pos;
        true
    }
}

/// Runs one frame on two consoles joined by a link cable, in lockstep (the one that is behind
/// steps next), so a transfer clocked by one side reaches the other at the right time.
/// On error, returns which console (0 = `a`, 1 = `b`) failed.
pub fn run_linked_frame(a: &mut GameBoy, b: &mut GameBoy) -> Result<(), (usize, EmulatorError)> {
    a.bus.ppu.frame_ready = false;
    b.bus.ppu.frame_ready = false;
    let (mut ta, mut tb) = (0u32, 0u32);
    while ta < CYCLES_PER_FRAME || tb < CYCLES_PER_FRAME {
        if ta <= tb {
            ta += a.step_instruction().map_err(|e| (0, e))?;
        } else {
            tb += b.step_instruction().map_err(|e| (1, e))?;
        }
        connect(a, b);
        connect(b, a);
    }
    Ok(())
}

/// When `master` starts an internal-clock transfer and `slave` waits on the external clock, the
/// two SB registers are swapped over the same 8 bit periods. A slave that is not waiting leaves
/// the master shifting in 0xFF, like an unplugged cable.
// ponytail: byte-level exchange timed in the master's CPU cycles; a CGB in double speed linked to
// one in normal speed completes a little early. Model per-bit shifting if a game ever needs it.
fn connect(master: &mut GameBoy, slave: &mut GameBoy) {
    if master.bus.serial.take_started() && slave.bus.serial.armed_external() {
        let cycles = master.bus.serial.remaining();
        master.bus.serial.receive_byte(slave.bus.serial.get_byte());
        slave.bus.serial.clock_in(master.bus.serial.get_byte(), cycles);
    }
}

const SAVE_MAGIC: &[u8; 4] = b"GBSS";
// v3 (1.0.0) adds the mapper, HDMA/KEY1/OAM-DMA, serial, PPU/CPU latch and APU state; v2 states are
// rejected because loading them into a freshly booted ROM maps the wrong banks.
// v4 adds the console and palette bytes after the version (v3 states still load: see `state_console`).
const SAVE_VERSION: u32 = 4;
