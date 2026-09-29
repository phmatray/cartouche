use crate::cartridge::{Cartridge, MAPPER_STATE_LEN};
use crate::cpu::Cpu;
use crate::debug::{Break, Debugger};
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
    /// Game Boy Pocket / Light: a DMG whose boot ROM hands over with A = $FF.
    Mgb,
    /// Super Game Boy, whatever the header says (`with_sgb` checks it first).
    Sgb,
    /// Super Game Boy 2: an SGB whose boot ROM hands over with A = $FF.
    Sgb2,
}

/// The hardware revision within a model's family (DMG-CPU 0, CGB E, ...). `Default` is the hybrid
/// the core has always modelled, and the only one the web app uses. Chosen before the hand-over
/// (`with_boot_revision`, or `set_revision` then `skip_boot_rom`) and read from `bus.rev`, a plain field.
#[derive(Clone, Copy, PartialEq, Eq, Debug, Default)]
pub enum Revision {
    #[default]
    Default,
    /// DMG-CPU 0: its boot ROM checks the header before showing anything, so it hands over earlier.
    Dmg0,
    DmgAbc,
    CgbA,
    Cgb0,
    CgbB,
    CgbC,
    CgbD,
    CgbE,
    Agb,
}

impl Revision {
    /// In declaration order: a save state stores the index (`as u8`).
    const ALL: [Revision; 10] = [
        Revision::Default, Revision::Dmg0, Revision::DmgAbc, Revision::CgbA, Revision::Cgb0,
        Revision::CgbB, Revision::CgbC, Revision::CgbD, Revision::CgbE, Revision::Agb,
    ];
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
    /// The model it was created as (`with_model`); only the post-boot state reads it.
    pub model: Model,
    /// The palette a colourised DMG cartridge was switched on with (`with_boot`), else 0.
    pub palette: u8,
    /// The start-up animation its boot ROM plays (`with_boot`), 0 none.
    pub boot: u8,
    /// Breakpoints, `None` until the first is set (never part of a save state).
    pub debugger: Option<Box<Debugger>>,
}

/// DIV at the hand-over from the Super Game Boy boot ROM. It sends the header ($0104-$014F) to
/// the SNES bit by bit, and a 0 bit takes one M-cycle longer than a 1, so the boot's length (and
/// DIV) follow the header, global checksum included (Mooneye boot_div-S, boot_div2-S).
fn sgb_boot_div(cart: &Cartridge) -> u16 {
    let zeros: u32 = (0x104..0x150).map(|a| cart.read_rom(a).count_zeros()).sum();
    (0xD304 + 4 * zeros) as u16
}

impl GameBoy {
    pub fn new(rom_data: Vec<u8>) -> Result<Self, EmulatorError> {
        Self::with_model(rom_data, Model::Auto)
    }

    /// Starts like the real console, with Cartouche's boot ROMs mapped (see boot_rom.rs).
    /// `colorize`: a DMG-only cartridge runs on a CGB, whose boot ROM picks its colours (always
    /// run: the palettes come from it). `palette`: 0 automatic, 1-12 the palette a real GBC gives
    /// when a combination is held at start-up (1-4 Right, Left, Up, Down; 5-8 the same + A;
    /// 9-12 + B). `animation`: the start-up animation, 1 Registration, 2 Insert, 3 Shelf pick; 0 (or
    /// anything else) starts from the post-boot state (DMG and CGB cartridges) or runs the plain CGB
    /// boot ROM unseen (`finish_boot`, colourised DMG cartridges).
    pub fn with_boot(rom_data: Vec<u8>, colorize: bool, palette: u8, animation: u8) -> Result<Self, EmulatorError> {
        Self::with_boot_revision(rom_data, colorize, palette, animation, Revision::Default)
    }

    /// `with_boot` on hardware revision `rev`, chosen before the boot ROM runs or is skipped.
    pub fn with_boot_revision(rom_data: Vec<u8>, colorize: bool, palette: u8, animation: u8, rev: Revision) -> Result<Self, EmulatorError> {
        let animation = if (1..=3).contains(&animation) { animation } else { 0 };
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
            model: Model::Auto,
            palette: 0,
            boot: animation,
            debugger: None,
        };
        gb.set_revision(rev);
        gb.bus.boot_rom = crate::boot_rom::image(gb.console, animation);
        if gb.console == Console::Compat {
            gb.palette = if palette <= 12 { palette } else { 0 };
            gb.hold_palette();
            if animation == 0 {
                gb.finish_boot()?;
            }
        } else if animation == 0 {
            gb.skip_boot_rom();
        }
        Ok(gb)
    }

    /// A Super Game Boy, from its boot ROM (`animation`) or its post-boot state. The cartridge
    /// runs as on a DMG, even a Game Boy Color one; without SGB support it is an ordinary DMG.
    pub fn with_sgb(rom_data: Vec<u8>, animation: u8) -> Result<Self, EmulatorError> {
        let animation = if (1..=3).contains(&animation) { animation } else { 0 };
        // Header $0146 = $03 with the old licensee $33, as the SGB checks.
        if rom_data.get(0x146) != Some(&0x03) || rom_data.get(0x14B) != Some(&0x33) {
            return Self::with_boot(rom_data, false, 0, animation);
        }
        let mut gb = Self::with_model(rom_data, Model::Sgb)?;
        gb.boot = animation;
        gb.bus.boot_rom = crate::boot_rom::image(Console::Sgb, animation);
        if animation == 0 {
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
        self.bus.sgb.as_deref().map_or(&self.bus.ppu.front[..], |s| &s.out[..])
    }

    /// Shows `frame` (160x144 RGBA, the thumbnail of a state just loaded) and draws the next frame
    /// over it. States are taken mid-frame and do not hold the PPU's back buffer, so without this
    /// the rows drawn before that point would come from a blank or older picture.
    pub fn set_screen(&mut self, frame: &[u8]) {
        if frame.len() != crate::ppu::FRAMEBUFFER_SIZE { return; }
        let ppu = &mut self.bus.ppu;
        match self.bus.sgb.as_deref_mut() {
            Some(s) => s.set_screen(frame, &mut ppu.framebuffer),
            None => ppu.framebuffer.copy_from_slice(frame),
        }
        ppu.front.copy_from_slice(&ppu.framebuffer);
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
        let sgb = matches!(model, Model::Sgb | Model::Sgb2);
        let console = if cgb_mode { Console::Cgb } else if sgb { Console::Sgb } else { Console::Dmg };
        let mut gb = GameBoy { cpu, bus, cgb_mode, double_speed: false, frame_cycles: 0, console, model, palette: 0, boot: 0, debugger: None };
        if sgb {
            gb.bus.sgb = Some(Box::default());
        }
        // The built-in boot ROM is a DMG one: it hands over with A=$01, which CGB software reads
        // as "running on a DMG" (CGB-only titles then show their "GBC only" screen, dual-mode
        // titles fall back to monochrome). CGB carts therefore start from the CGB post-boot state.
        if cgb_mode {
            gb.skip_boot_rom();
        }
        Ok(gb)
    }

    /// The hardware revision to emulate; call it before the hand-over (`skip_boot_rom`).
    pub fn set_revision(&mut self, rev: Revision) {
        self.bus.rev = rev;
        self.bus.ppu.rev = rev;
        self.bus.apu.rev = rev;
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
            self.cpu.regs.a = if self.model == Model::Sgb2 { 0xFF } else { 0x01 };
            self.cpu.regs.f = 0x00;
            self.cpu.regs.b = 0x00;
            self.cpu.regs.c = 0x14;
            self.cpu.regs.d = 0x00;
            self.cpu.regs.e = 0x00;
            self.cpu.regs.h = 0xC0;
            self.cpu.regs.l = 0x60;
        } else if self.bus.rev == Revision::Dmg0 {
            // DMG-CPU 0 (Pan Docs "Power Up Sequence", Mooneye boot_regs-dmg0).
            self.cpu.regs.a = 0x01;
            self.cpu.regs.f = 0x00;
            self.cpu.regs.b = 0xFF;
            self.cpu.regs.c = 0x13;
            self.cpu.regs.d = 0x00;
            self.cpu.regs.e = 0xC1;
            self.cpu.regs.h = 0x84;
            self.cpu.regs.l = 0x03;
        } else {
            self.cpu.regs.a = if self.model == Model::Mgb { 0xFF } else { 0x01 };
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
        let sgb = self.console == Console::Sgb;
        // The DMG boot ROM never writes P1, which powers on with both groups selected; the SGB one
        // leaves both deselected after its packets.
        self.bus.joypad.select = if sgb { 0x30 } else { 0x00 };
        // A CGB-CPU C hands a CGB cartridge over with DIV at $1E9C: Gambatte `div/start_inc_1/2` pin
        // its M-cycle, and the APU frame-sequencer ROMs (`ch1_init_reset_sweep_counter_timing_*`,
        // `ch2_init_reset_env/length_counter_timing_*`), which count from it, agree.
        self.bus.timer.div_counter = if sgb {
            sgb_boot_div(&self.bus.cartridge)
        } else if self.cgb_mode {
            0x1E9C
        } else {
            0xABC8
        };
        self.bus.interrupts.interrupt_flag = 0xE1;
        self.bus.ppu.lcdc = 0x91;
        self.bus.ppu.bgp = 0xFC;
        self.bus.ppu.obp0 = 0xFF;
        self.bus.ppu.obp1 = 0xFF;
        self.bus.ppu.ly = 153;
        self.bus.ppu.mode = crate::ppu::PpuMode::VBlank;
        self.bus.ppu.mode_clock = 396;
        if self.console == Console::Cgb {
            // A CGB hands a CGB cartridge over in VBlank, LY $90: LY reads $90 11 M-cycles in, and
            // line 0 of the next frame shows mode 3 1162 M-cycles in, mode 0 one later, at SCX
            // 0/2/3/5 (Gambatte `display_startstate/ly`, `stat[_scxN]_1/2`). Dot 164 of line 144
            // is the one position on the M-cycle grid both agree on.
            self.bus.ppu.ly = 144;
            self.bus.ppu.mode_clock = 164;
        }
        if self.bus.rev == Revision::Dmg0 && self.console == Console::Dmg {
            // DMG-CPU 0 checks the header before it shows the logo, and hands over earlier: DIV
            // $18 (boot_div-dmg0 pins its phase: $1900 comes 53 M-cycles in), LY $91 in VBlank
            // (Pan Docs "Hardware registers"). boot_hwio-dmg0 passes for any dot 88-252 of that
            // line; ponytail: its middle, until a hardware trace pins it.
            self.bus.timer.div_counter = 0x182C;
            self.bus.ppu.ly = 145;
            self.bus.ppu.mode_clock = 168;
        }

        // The boot sound's channel 1 registers; on a DMG it is still on (silent, its envelope
        // has run down), the SGB boot ROM plays no sound.
        self.bus.apu.write_register(0xFF26, 0x80);
        self.bus.apu.write_register(0xFF11, 0x80);
        self.bus.apu.write_register(0xFF12, 0xF3);
        self.bus.apu.write_register(0xFF24, 0x77);
        self.bus.apu.write_register(0xFF25, 0xF3);
        if !sgb {
            self.bus.apu.hand_over_boot_sound(self.cgb_mode);
        }

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
    /// for the partner's byte (`bus.serial.stalled()`), and on a breakpoint (`take_break`); the
    /// next call finishes that frame.
    pub fn run_frame(&mut self) -> Result<(), EmulatorError> {
        self.bus.ir_light_in = false; // alone: no partner's light (only `run_linked_frame` sets it)
        if self.frame_cycles == 0 {
            self.bus.ppu.frame_ready = false;
            self.apply_ram_cheats();
        }
        while self.frame_cycles < CYCLES_PER_FRAME {
            if self.bus.serial.stalled() {
                return Ok(());
            }
            if let Some(d) = &mut self.debugger {
                if d.should_stop(self.cpu.regs.pc) {
                    return Ok(());
                }
            }
            self.bus.cycle_count = 0;
            let before = self.cpu.regs.pc;
            self.cpu.handle_interrupts(&mut self.bus);
            let pc = self.cpu.regs.pc;
            if let Some(d) = &mut self.debugger {
                // An interrupt dispatch lands on its vector: check the breakpoint there too.
                if pc != before && d.should_stop(pc) {
                    self.frame_cycles += self.bus.cycle_count;
                    return Ok(());
                }
            }
            let ly = self.bus.ppu.ly;
            self.cpu.step(&mut self.bus)?;
            self.frame_cycles += self.bus.cycle_count;
            self.double_speed = self.bus.double_speed;
            if self.debugger.is_some() && self.stopped_after(pc, ly) {
                return Ok(());
            }
        }
        self.frame_cycles = 0;
        Ok(())
    }

    /// After the instruction that started at `pc` with LY at `ly`: a watchpoint hit, or LY
    /// arriving at the run-to-scanline line, becomes the break.
    fn stopped_after(&mut self, pc: u16, ly: u8) -> bool {
        let watched = self.bus.watch.as_mut().and_then(|w| w.hit.take());
        let now = self.bus.ppu.ly;
        let d = self.debugger_mut();
        if let Some((addr, value, write)) = watched {
            d.hit = Some(Break::Watch { addr, value, write, pc });
            return true;
        }
        if d.stop_ly == Some(now) && ly != now {
            d.stop_ly = None;
            d.hit = Some(Break::Scanline(now));
            return true;
        }
        false
    }

    /// Runs until LY reaches `ly` (or a breakpoint or watchpoint stops it first). Bounded by the
    /// rest of this frame and the next one, reported as `Break::Frame` (LCD off).
    pub fn run_to_scanline(&mut self, ly: u8) -> Result<(), EmulatorError> {
        let pc = self.cpu.regs.pc;
        let d = self.debugger_mut();
        d.hit = None;
        d.resume_pc = Some(pc);
        d.stop_ly = Some(ly);
        for _ in 0..2 {
            self.run_frame()?;
            if self.debugger_mut().hit.is_some() || self.bus.serial.stalled() {
                break;
            }
        }
        let d = self.debugger_mut();
        if d.stop_ly.take().is_some() && d.hit.is_none() {
            d.hit = Some(Break::Frame);
        }
        Ok(())
    }

    /// Stops `run_frame` after any CPU access of `kind` (`debug::WATCH_READ` / `WATCH_WRITE` bits)
    /// to `addr`.
    pub fn watch_add(&mut self, addr: u16, kind: u8) {
        self.debugger_mut();
        self.bus.watch.get_or_insert_with(Box::default).add(addr, kind);
    }

    pub fn watch_remove(&mut self, addr: u16, kind: u8) {
        if let Some(w) = &mut self.bus.watch {
            w.remove(addr, kind);
            if w.entries.is_empty() {
                self.bus.watch = None;
            }
        }
    }

    /// GameShark writes, once per frame like the real device at VBlank.
    fn apply_ram_cheats(&mut self) {
        for i in 0..self.bus.cheats.ram.len() {
            if let crate::cheats::Cheat::Ram { addr, value, bank } = self.bus.cheats.ram[i] {
                match bank {
                    Some(b) => self.bus.wram[b as usize * 0x1000 + (addr - 0xD000) as usize] = value,
                    None => self.bus.write_byte(addr, value),
                }
            }
        }
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

    /// The debugger, created on first use.
    pub fn debugger_mut(&mut self) -> &mut Debugger {
        self.debugger.get_or_insert_with(Box::default)
    }

    /// Why the last `run_frame` / `step_frame` stopped, once.
    pub fn take_break(&mut self) -> Option<Break> {
        self.debugger.as_mut()?.hit.take()
    }

    /// Lets the instruction at the current PC run on the next `run_frame` even if it has a
    /// breakpoint (after a step, so Continue moves on).
    pub fn resume_here(&mut self) {
        if let Some(d) = &mut self.debugger {
            d.resume_pc = Some(self.cpu.regs.pc);
        }
    }

    /// Runs to the next VBlank (see `run_to_vblank`) and stops there with `Break::Frame`.
    pub fn step_frame(&mut self) -> Result<(), EmulatorError> {
        self.run_to_vblank()?;
        self.resume_here();
        self.debugger_mut().hit = Some(Break::Frame);
        Ok(())
    }

    /// Runs a `CALL`/`CALL cc`/`RST` to the instruction after it (or to a breakpoint, or to the
    /// end of this frame, reported as `Break::Frame`); anything else is one step.
    pub fn step_over(&mut self) -> Result<(), EmulatorError> {
        let pc = self.cpu.regs.pc;
        let (text, len) = crate::disasm::disassemble_one(&self.bus, pc);
        if !(text.starts_with("CALL") || text.starts_with("RST")) {
            self.step_instruction()?;
            self.resume_here();
            return Ok(());
        }
        let d = self.debugger_mut();
        d.hit = None;
        d.resume_pc = Some(pc);
        d.temp_stop = Some(pc.wrapping_add(len as u16));
        self.run_frame()?;
        let d = self.debugger_mut();
        if d.temp_stop.take().is_some() && d.hit.is_none() {
            d.hit = Some(Break::Frame);
        }
        Ok(())
    }

    /// A deterministic session: the cartridge clock starts at `epoch_seconds` (unix time) and only
    /// advances with emulated time from now on (`Cartridge::set_emulated_clock`). Solo play keeps
    /// the wall clock for catching up between sessions.
    pub fn set_emulated_clock(&mut self, epoch_seconds: f64) {
        self.bus.cartridge.set_emulated_clock(epoch_seconds.max(0.0) as u64);
    }

    pub fn step_instruction(&mut self) -> Result<u32, EmulatorError> {
        self.bus.cycle_count = 0;
        self.cpu.handle_interrupts(&mut self.bus);
        self.cpu.step(&mut self.bus)?;
        self.double_speed = self.bus.double_speed;
        if let Some(w) = &mut self.bus.watch {
            w.hit = None; // a step stops anyway: no break left over for the next run_frame
        }
        Ok(self.bus.cycle_count)
    }

    /// A stable 32-bit FNV-1a hash of `save_state()`, to check that two copies of a session agree.
    pub fn state_hash(&self) -> u32 {
        self.save_state().iter().fold(0x811C_9DC5, |h, &b| (h ^ b as u32).wrapping_mul(0x0100_0193))
    }

    pub fn save_state(&self) -> Vec<u8> {
        let mut data = Vec::with_capacity(65536);

        data.extend_from_slice(SAVE_MAGIC);
        data.extend_from_slice(&SAVE_VERSION.to_le_bytes());
        data.push(self.console as u8);
        data.push(self.palette);
        data.push(self.boot);

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
        data.extend_from_slice(&[b.dma_active as u8, 0xA0u8.saturating_sub(b.dma_index)]);
        data.extend_from_slice(&[b.ppu.window_was_active as u8, b.ppu.lcd_on_line0 as u8, b.ppu.stat_irq_line as u8]);
        data.extend_from_slice(&[self.cpu.ime_pending as u8, self.cpu.stopped as u8]);
        let sr = &self.bus.serial;
        data.extend_from_slice(&[sr.data, sr.control, sr.incoming]);
        data.extend_from_slice(&sr.remaining.to_le_bytes());
        self.bus.apu.export_state(&mut data);
        if let Some(s) = &self.bus.sgb {
            s.export_state(&mut data);
            s.audio.export_state(&mut data); // v6
            s.audio.fx.export_state(&mut data); // v7
        }
        // Optional tail (absent from older states): stop mode, KEY0 (DMG compatibility set by the boot ROM).
        data.extend_from_slice(&[self.cpu.stopped as u8, self.bus.key0]);
        // Then the mapper block: u16 LE length + `Cartridge::export_extra`.
        let extra = self.bus.cartridge.export_extra();
        data.extend_from_slice(&(extra.len() as u16).to_le_bytes());
        data.extend_from_slice(&extra);
        // Then the sub-instruction timing (TIMING_TAIL_LEN bytes, absent from older states): TIMA reload, OAM DMA.
        data.extend_from_slice(&[self.bus.timer.reload_pending as u8, b.dma_delay, b.dma_index, b.dma_source]);
        // Then the infrared port (RP; absent from older states: LED off, reading disabled).
        data.push(self.bus.rp);
        // Then the current line's mode-3 length (u32 LE; absent from older states: 172 dots).
        data.extend_from_slice(&self.bus.ppu.mode3_len.to_le_bytes());
        // Then the speed-switch aftermath (absent from older states: none): the DIV-APU event's
        // lag and the divider's hold.
        let due = self.bus.apu_event_due.map_or(0, |write| 2 | (write as u8) << 2);
        data.push(self.bus.apu_event_late as u8 | due | self.bus.timer.div_hold.min(3) << 3);
        // Then OPRI (absent from older states: 0, OBJs by OAM index).
        data.push(self.bus.ppu.opri);
        // Then the hardware revision (absent from older states: `Default`).
        data.push(self.bus.rev as u8);
        // Then the lock of an invalid opcode (absent from older states: not locked): flag, PC LE.
        let [lo, hi] = self.cpu.locked_pc.to_le_bytes();
        data.extend_from_slice(&[self.cpu.locked as u8, lo, hi]);
        // Then a Color's RAM at $FEA0-$FEFF (absent from older states: zeros).
        data.extend_from_slice(&self.bus.fea0);

        data
    }

    /// The console a state was saved on (`None`: not a state this core reads). A v3 state
    /// predates colourised DMG cartridges: it was saved on the cartridge's own console.
    pub fn state_console(&self, data: &[u8]) -> Option<Console> {
        if data.len() < 9 || &data[0..4] != SAVE_MAGIC { return None; }
        match u32::from_le_bytes([data[4], data[5], data[6], data[7]]) {
            3 => Some(if self.bus.cartridge.cgb_mode() { Console::Cgb } else { Console::Dmg }),
            4..=SAVE_VERSION => [Console::Dmg, Console::Cgb, Console::Compat, Console::Sgb].get(data[8] as usize).copied(),
            _ => None,
        }
    }

    /// A state loads on the console it was saved on, or a Game Boy one on a Super Game Boy
    /// (the same machine; the SGB side then starts fresh). All or nothing: a state refused
    /// part-way (damaged, cut short) leaves the running machine, cartridge RAM included, as it was.
    pub fn load_state(&mut self, data: &[u8]) -> bool {
        if self.state_console(data).is_none() { return false; }
        let before = self.save_state();
        if self.read_state(data) {
            if let Some(d) = &mut self.debugger {
                d.hit = None;
                d.resume_pc = None;
            }
            if let Some(w) = &mut self.bus.watch {
                w.hit = None;
            }
            return true;
        }
        let restored = self.read_state(&before);
        debug_assert!(restored, "a state this machine just saved reads back");
        false
    }

    fn read_state(&mut self, data: &[u8]) -> bool {
        let saved = match (self.state_console(data), self.console) {
            (Some(a), b) if a == b => a,
            (Some(Console::Dmg), Console::Sgb) => Console::Dmg,
            _ => return false,
        };
        let version = u32::from_le_bytes([data[4], data[5], data[6], data[7]]);

        let mut pos = match version { 3 => 8, 4 => 10, _ => 11 };
        self.palette = if version == 3 { 0 } else { *data.get(9).unwrap_or(&0) };
        let boot = if version >= 5 { *data.get(10).unwrap_or(&0) } else { 0 };

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
        self.bus.ppu.ly = read_u8!().min(153); // clamped, as the other damaged-state values below
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
        // Lines 144-153 are VBlank's: in another mode such a line would never reach VBlank.
        if self.bus.ppu.mode != crate::ppu::PpuMode::VBlank { self.bus.ppu.ly = self.bus.ppu.ly.min(143); }
        // Below one line: a larger count would run a line per M-cycle until it drained.
        self.bus.ppu.mode_clock = read_u32!().min(455);
        self.bus.ppu.line.active = false; // a DMG line in mode 3 is redrawn from its first dot
        self.bus.ppu.window_line_counter = read_u8!();
        self.bus.ppu.frame_ready = read_u8!() != 0;

        self.bus.boot_rom_active = read_u8!() != 0;
        // Saved during the start-up: its boot ROM goes on. One from before v5 ran SameBoy's, which is gone.
        if self.bus.boot_rom_active && version < 5 { return false; }
        self.boot = boot;
        self.bus.boot_rom = crate::boot_rom::image(saved, boot);

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
        self.bus.ppu.m_cycle_dots = if self.bus.double_speed { 2 } else { 4 };
        self.double_speed = self.bus.double_speed;
        self.bus.ppu.bg_cram.copy_from_slice(read_bytes!(64));
        self.bus.ppu.obj_cram.copy_from_slice(read_bytes!(64));
        self.bus.ppu.bcps = read_u8!();
        self.bus.ppu.ocps = read_u8!();

        let mapper: &[u8; MAPPER_STATE_LEN] = read_bytes!(MAPPER_STATE_LEN).try_into().unwrap();
        self.bus.cartridge.import_state(mapper);
        self.bus.hdma_source = read_u16!() & 0xFFF0;
        self.bus.hdma_dest = read_u16!() & 0x1FF0;
        self.bus.hdma_remaining = read_u8!().min(0x80);
        // An HBlank DMA with no block left would copy 255 more over VRAM.
        self.bus.hdma_active = read_u8!() != 0 && self.bus.hdma_remaining > 0;
        self.bus.hdma5 = read_u8!();
        self.bus.key1 = read_u8!();
        self.bus.dma_active = read_u8!() != 0;
        pos += 1; // the bytes the transfer had left: older states copied them all on the $FF46 write
        self.bus.ppu.window_was_active = read_u8!() != 0;
        self.bus.ppu.lcd_on_line0 = read_u8!() != 0;
        self.bus.ppu.stat_irq_line = read_u8!() != 0;
        // Not saved: at a boundary it only decides a halted CPU's wake on a mode-0 edge of the
        // M-cycle just run, where a set IF.1 is that edge's (a halted CPU with it already pending
        // would have woken); a read or write ticks first, which recomputes it.
        self.bus.if_late = crate::interrupts::VBLANK_BIT | crate::interrupts::STAT_BIT;
        self.cpu.ime_pending = read_u8!() != 0;
        // Before the tail below, STOP never stopped anything: an older state is not in stop mode.
        pos += 1;
        self.cpu.stopped = false;
        self.bus.serial.data = read_u8!();
        self.bus.serial.control = read_u8!();
        self.bus.serial.incoming = read_u8!();
        // A transfer lasts at most 8 x 512 cycles: a larger count would hold SC busy for minutes.
        self.bus.serial.remaining = read_u32!().min(8 * 512);
        if !self.bus.apu.import_state(data, &mut pos, version) { return false; }
        if let Some(s) = self.bus.sgb.as_deref_mut() {
            // A Game Boy state has no SGB side (but may have the tail): that side starts fresh.
            let mut p = if saved == Console::Sgb { pos } else { data.len() };
            if !s.import_state(data, &mut p) { return false; }
            // Older states have no SNES sound: it stays idle (as `import_state` left it).
            if saved == Console::Sgb && version >= 6 && !s.audio.import_state(data, &mut p) { return false; }
            // Nor built-in effects before v7: none plays.
            if saved == Console::Sgb && version >= 7 && !s.audio.fx.import_state(data, &mut p) { return false; }
            if saved == Console::Sgb { pos = p; }
        }
        if let Some(&[stopped, ..]) = data.get(pos..) {
            self.cpu.stopped = stopped != 0;
        }
        if let Some(&[_, key0, ..]) = data.get(pos..) {
            self.bus.key0 = key0;
        }
        let extra = match data.get(pos + 2..) {
            Some(&[lo, hi, ref rest @ ..]) => rest.get(..u16::from_le_bytes([lo, hi]) as usize).unwrap_or(&[]),
            _ => &[],
        };
        self.bus.cartridge.import_extra(extra);
        if self.bus.cartridge.rewinds_clock(extra) {
            // The clock went back with the state: its battery RAM footer is read again against it
            // (nothing to catch up), which zeroes the second's dots, so they go back once more.
            self.bus.cartridge.import_sram(ram_data);
            self.bus.cartridge.import_extra(extra);
        }
        let timing = data.get(pos + 4 + extra.len()..).unwrap_or(&[]);
        let byte = |i: usize| timing.get(i).copied();
        self.bus.timer.reload_pending = byte(0) == Some(1);
        self.bus.dma_delay = byte(1).unwrap_or(0).min(2);
        self.bus.dma_index = byte(2).unwrap_or(0xA0).min(0xA0); // older states: the transfer is done
        if let Some(source) = byte(3) { self.bus.dma_source = source; }
        self.bus.rp = byte(TIMING_TAIL_LEN).map_or(0, |rp| rp & 0xC1);
        // Clamped to what a line can hold: 172 to 172 + 7 + 6 + 10 x 11 dots.
        self.bus.ppu.mode3_len = timing.get(TIMING_TAIL_LEN + 1..TIMING_TAIL_LEN + 5)
            .map_or(172, |b| u32::from_le_bytes(b.try_into().unwrap()).clamp(172, 295));
        let spsw = byte(TIMING_TAIL_LEN + 5).unwrap_or(0);
        self.bus.apu_event_late = spsw & 1 != 0;
        self.bus.apu_event_due = (spsw & 2 != 0).then_some(spsw & 4 != 0);
        self.bus.timer.div_hold = (spsw >> 3) & 3;
        self.bus.ppu.opri = byte(TIMING_TAIL_LEN + 6).unwrap_or(0) & 1;
        self.set_revision(byte(TIMING_TAIL_LEN + 7).and_then(|r| Revision::ALL.get(r as usize)).copied().unwrap_or_default());
        let (locked, pc) = match timing.get(TIMING_TAIL_LEN + 8..TIMING_TAIL_LEN + 11) {
            Some(&[1, lo, hi]) => (true, u16::from_le_bytes([lo, hi])),
            _ => (false, 0),
        };
        (self.cpu.locked, self.cpu.locked_pc) = (locked, pc);
        self.bus.fea0 = timing.get(TIMING_TAIL_LEN + 11..TIMING_TAIL_LEN + 11 + 0x30)
            .map_or([0; 0x30], |b| b.try_into().unwrap());
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
        // Infrared: each LED shines into the other console's sensor (never its own).
        a.bus.ir_light_in = b.bus.ir_led();
        b.bus.ir_light_in = a.bus.ir_led();
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
/// Bytes after the mapper block: TIMA reload, OAM DMA start-up/index/page (then RP).
const TIMING_TAIL_LEN: usize = 4;
// v3 (1.0.0) adds the mapper, HDMA/KEY1/OAM-DMA, serial, PPU/CPU latch and APU state; v2 states are
// rejected because loading them into a freshly booted ROM maps the wrong banks.
// v4 adds the console and palette bytes after the version (v3 states still load: see `state_console`).
// v5 adds the start-up animation after them, so a state saved while it plays goes on with its own boot ROM.
// v6 adds the Super Game Boy's SNES sound side after the SGB block (v5 states load with it idle).
// v7 adds the built-in SGB sound effects playing, after the SNES sound side (v6 states load with none).
// v8 gives the APU block a length, a layout byte and its registers, and clocks the frame sequencer
// from DIV (v3-v7 APU fields still load: `Apu::import_state`).
const SAVE_VERSION: u32 = 8;

#[cfg(test)]
mod tests {
    use super::*;

    /// A CGB cartridge starts in VBlank, LY $90: LY reads $90 11 M-cycles in, and line 0 of the
    /// next frame shows mode 3 1162 M-cycles in, mode 0 one later (Gambatte `display_startstate`).
    #[test]
    fn cgb_handover_ly_stat() {
        let mut rom = vec![0u8; 0x8000];
        rom[0x100..0x102].copy_from_slice(&[0x18, 0xFE]);
        rom[0x143] = 0xC0;
        rom[0x14D] = (0x134..=0x14C).fold(0u8, |c, i| c.wrapping_sub(rom[i]).wrapping_sub(1));
        let mut gb = GameBoy::new(rom).unwrap();
        let mut reads = Vec::new();
        for m in 1..=1163u32 {
            gb.bus.cycle_tick();
            if [11, 1162, 1163].contains(&m) {
                reads.push((gb.bus.read_byte(0xFF44), gb.bus.read_byte(0xFF41)));
            }
        }
        assert_eq!(reads[0].0, 0x90);
        assert_eq!([reads[1], reads[2]], [(0, 0x87), (0, 0x84)]);
    }

    /// A damaged state's PPU line, line clock, HBlank DMA and serial transfer are clamped to values the machine can
    /// run from (release builds wrap instead of panicking: these ran a line per M-cycle for seconds,
    /// or copied 255 stray HDMA blocks over VRAM).
    #[test]
    fn a_damaged_state_is_clamped_to_a_runnable_one() {
        let mut rom = vec![0u8; 0x8000];
        rom[0x100..0x102].copy_from_slice(&[0x18, 0xFE]);
        rom[0x143] = 0xC0;
        rom[0x14D] = (0x134..=0x14C).fold(0u8, |c, i| c.wrapping_sub(rom[i]).wrapping_sub(1));
        let mut gb = GameBoy::new(rom.clone()).unwrap();
        gb.bus.ppu.mode = crate::ppu::PpuMode::HBlank;
        gb.bus.ppu.ly = 200;
        gb.bus.ppu.mode_clock = u32::MAX - 8;
        (gb.bus.hdma_active, gb.bus.hdma_remaining, gb.bus.hdma_dest) = (true, 0, 0xFFFF);
        gb.bus.serial.remaining = u32::MAX;
        let state = gb.save_state();
        let mut g = GameBoy::new(rom).unwrap();
        assert!(g.load_state(&state));
        assert!(g.bus.ppu.ly <= 143 && g.bus.ppu.mode_clock < 456);
        assert!(!g.bus.hdma_active);
        assert_eq!(g.bus.hdma_dest, 0x1FF0);
        assert!(g.bus.serial.remaining <= 8 * 512);
        g.run_frame().unwrap();
    }

    /// A TIMA reload and an OAM DMA caught mid-way go on after a load; a state without the
    /// timing tail loads with neither pending.
    #[test]
    fn save_state_round_trips_timing_fields() {
        let mut rom = vec![0u8; 0x8000];
        rom[0x100..0x102].copy_from_slice(&[0x18, 0xFE]);
        rom[0x14D] = (0x134..=0x14C).fold(0u8, |c, i| c.wrapping_sub(rom[i]).wrapping_sub(1));
        let mut gb = GameBoy::new(rom.clone()).unwrap();
        gb.skip_boot_rom();
        gb.bus.write_byte(0xFF46, 0xC1);
        for _ in 0..12 { gb.bus.cycle_tick(); }
        gb.bus.timer.reload_pending = true;
        (gb.bus.apu_event_late, gb.bus.apu_event_due, gb.bus.timer.div_hold) = (true, Some(true), 2);
        let state = gb.save_state();

        let mut g = GameBoy::new(rom.clone()).unwrap();
        assert!(g.load_state(&state));
        assert!(g.bus.timer.reload_pending);
        assert_eq!((g.bus.apu_event_late, g.bus.apu_event_due, g.bus.timer.div_hold), (true, Some(true), 2));
        assert_eq!((g.bus.dma_active, g.bus.dma_delay, g.bus.dma_index, g.bus.read_byte(0xFF46)), (true, 0, 11, 0xC1));
        assert_eq!(g.save_state(), state);

        let mut g = GameBoy::new(rom).unwrap();
        assert!(g.load_state(&state[..state.len() - TIMING_TAIL_LEN - 11 - 0x30])); // - 11: RP, mode-3 length, speed switch, OPRI, revision, CPU lock; - 0x30: $FEA0 RAM
        assert!(!g.bus.timer.reload_pending);
        assert_eq!(g.bus.dma_index, 0xA0, "an older state's transfer is already in OAM");
    }

    /// The revision goes with a state; one saved before it existed loads as `Default`.
    #[test]
    fn save_state_keeps_the_revision() {
        let mut rom = vec![0u8; 0x8000];
        rom[0x100..0x102].copy_from_slice(&[0x18, 0xFE]);
        rom[0x14D] = (0x134..=0x14C).fold(0u8, |c, i| c.wrapping_sub(rom[i]).wrapping_sub(1));
        let mut gb = GameBoy::with_model(rom.clone(), Model::Dmg).unwrap();
        gb.set_revision(Revision::Dmg0);
        gb.skip_boot_rom();
        assert_eq!((gb.cpu.regs.b, gb.bus.timer.div_counter, gb.bus.ppu.ly), (0xFF, 0x182C, 145));
        let state = gb.save_state();

        let mut g = GameBoy::new(rom.clone()).unwrap();
        assert!(g.load_state(&state));
        assert_eq!((g.bus.rev, g.bus.apu.rev), (Revision::Dmg0, Revision::Dmg0));
        assert_eq!(g.save_state(), state);

        let mut g = GameBoy::new(rom).unwrap();
        g.set_revision(Revision::CgbE);
        assert!(g.load_state(&state[..state.len() - 4 - 0x30])); // without the revision, the CPU lock and $FEA0 RAM
        assert_eq!((g.bus.rev, g.bus.ppu.rev), (Revision::Default, Revision::Default));
    }

    /// KEY0 set by the CGB boot ROM (DMG compatibility) goes with a state saved before it unmaps.
    #[test]
    fn a_state_keeps_key0_until_the_boot_rom_unmaps() {
        let mut rom = vec![0u8; 0x8000];
        rom[0x100..0x102].copy_from_slice(&[0x18, 0xFE]);
        rom[0x14D] = (0x134..=0x14C).fold(0u8, |c, i| c.wrapping_sub(rom[i]).wrapping_sub(1));
        let mut gb = GameBoy::with_boot(rom.clone(), true, 0, 1).unwrap();
        gb.run_frame().unwrap();
        gb.bus.key0 = 0x04;
        let state = gb.save_state();
        let mut g = GameBoy::with_boot(rom, true, 0, 1).unwrap();
        assert!(g.load_state(&state));
        assert_eq!(g.bus.key0, 0x04);
        g.finish_boot().unwrap();
        assert!(!g.bus.boot_rom_active && g.bus.ppu.compat && !g.bus.cgb_mode, "DMG compatibility mode");
    }

    /// A state saved in HBlank keeps its line's mode-3 length; an older state (without it) loads
    /// with the plain 172 dots.
    #[test]
    fn save_state_keeps_mode3_len() {
        let mut rom = vec![0u8; 0x8000];
        rom[0x100..0x102].copy_from_slice(&[0x18, 0xFE]);
        rom[0x14D] = (0x134..=0x14C).fold(0u8, |c, i| c.wrapping_sub(rom[i]).wrapping_sub(1));
        let mut gb = GameBoy::new(rom.clone()).unwrap();
        gb.skip_boot_rom();
        gb.bus.ppu.scx = 5;
        while gb.bus.ppu.mode != crate::ppu::PpuMode::HBlank { gb.bus.cycle_tick(); }
        assert_eq!(gb.bus.ppu.mode3_len, 177);
        let state = gb.save_state();

        let mut g = GameBoy::new(rom.clone()).unwrap();
        assert!(g.load_state(&state));
        assert_eq!(g.bus.ppu.mode3_len, 177);
        assert_eq!(g.save_state(), state);

        let mut g = GameBoy::new(rom).unwrap();
        g.bus.ppu.mode3_len = 200;
        assert!(g.load_state(&state[..state.len() - 10 - 0x30])); // without the mode-3 length, speed switch, OPRI, revision, CPU lock and $FEA0 RAM
        assert_eq!(g.bus.ppu.mode3_len, 172);
    }

    /// A HuC3 caught mid-command (mode 0xB, address set) goes on from the same place after a load;
    /// a state from before the mapper block still loads.
    #[test]
    fn a_huc3_state_keeps_its_command_registers() {
        let mut rom = vec![0u8; 0x8000];
        rom[0x100..0x102].copy_from_slice(&[0x18, 0xFE]);
        (rom[0x147], rom[0x149]) = (0xFE, 0x03);
        rom[0x14D] = (0x134..=0x14C).fold(0u8, |c, i| c.wrapping_sub(rom[i]).wrapping_sub(1));
        let mut gb = GameBoy::new(rom.clone()).unwrap();
        let c = &mut gb.bus.cartridge;
        c.write_rom(0x0000, 0x0B);
        for cmd in [0x43, 0x52, 0x37, 0x43] { c.write_ram(0, cmd); } // memory 0x23 = 7, address back to 0x23
        let state = gb.save_state();

        let mut g = GameBoy::new(rom.clone()).unwrap();
        assert!(g.load_state(&state));
        let c = &mut g.bus.cartridge;
        c.write_ram(0, 0x10); // still in mode 0xB: read memory 0x23
        c.write_rom(0x0000, 0x0C);
        assert_eq!(c.read_ram(0), 0x97);

        // The pre-change layout ends right after KEY0 (then the mapper block, the timing tail, RP
        // the mode-3 length, the speed-switch byte, OPRI, the revision and the CPU lock).
        let end = state.len() - TIMING_TAIL_LEN - 11 - 0x30;
        let extra = u16::from_le_bytes([state[end - 151], state[end - 150]]);
        assert_eq!(extra, 149, "mode, address, result, opcode, 128 bytes of nibbles, IR LED, clock tail");
        let old = &state[..end - 151];
        let mut g = GameBoy::new(rom.clone()).unwrap();
        assert!(g.load_state(old));

        // A state from before the clock tail (#222): a 133-byte block still loads, registers kept.
        let mut old = state[..end - 151].to_vec();
        old.extend(133u16.to_le_bytes());
        old.extend(&state[end - 149..end - 16]);
        old.extend(&state[end..]);
        let mut g = GameBoy::new(rom).unwrap();
        assert!(g.load_state(&old));
        let c = &mut g.bus.cartridge;
        c.write_ram(0, 0x10);
        c.write_rom(0x0000, 0x0C);
        assert_eq!(c.read_ram(0), 0x97);
    }

    /// An MBC7 saved mid-READ (address clocked in, data not yet out) sends the word after a load.
    #[test]
    fn an_mbc7_state_resumes_an_eeprom_read() {
        let mut rom = vec![0u8; 0x8000];
        rom[0x100..0x102].copy_from_slice(&[0x18, 0xFE]);
        rom[0x147] = 0x22;
        rom[0x14D] = (0x134..=0x14C).fold(0u8, |c, i| c.wrapping_sub(rom[i]).wrapping_sub(1));
        let clock = |c: &mut crate::cartridge::Cartridge, bits: &[u8]| {
            for &b in bits {
                for v in [0x80 | b << 1, 0xC0 | b << 1, 0x80 | b << 1] { c.write_ram(0x080, v); }
            }
        };
        let end = |c: &mut crate::cartridge::Cartridge| [0x00, 0x80].into_iter().for_each(|v| c.write_ram(0x080, v));
        let mut gb = GameBoy::new(rom.clone()).unwrap();
        let c = &mut gb.bus.cartridge;
        (c.write_rom(0x0000, 0x0A), c.write_rom(0x4000, 0x40));
        clock(c, &[1, 0, 0, 1, 1, 0, 0, 0, 0, 0, 0]); // EWEN
        end(c);
        clock(c, &[1, 0, 1, 0, 0, 0, 0, 0, 1, 0, 1]); // WRITE word 5
        clock(c, &[0, 1, 0, 1, 1, 0, 1, 0, 1, 1, 0, 0, 0, 0, 1, 1]); // 0x5AC3
        end(c);
        clock(c, &[1, 1, 0, 0, 0, 0, 0, 0, 1, 0, 1]); // READ word 5
        c.set_tilt(0.5, 0.0);
        (c.write_ram(0x000, 0x55), c.write_ram(0x010, 0xAA));
        let state = gb.save_state();

        let mut g = GameBoy::new(rom).unwrap();
        assert!(g.load_state(&state));
        let c = &mut g.bus.cartridge;
        let word = (0..16).fold(0u16, |w, _| {
            (c.write_ram(0x080, 0x80), c.write_ram(0x080, 0xC0));
            w << 1 | (c.read_ram(0x080) & 1) as u16
        });
        assert_eq!(word, 0x5AC3);
        assert_eq!((c.read_ram(0x020), c.read_ram(0x030)), (0x98, 0x81), "the latch survives too");
    }

    /// Writes a valid header of `cart_type` at `at`.
    fn header(rom: &mut [u8], at: usize, cart_type: u8, ram_size: u8) {
        (rom[at + 0x147], rom[at + 0x149]) = (cart_type, ram_size);
        rom[at + 0x14D] = (0x134..=0x14C).fold(0u8, |c, a| c.wrapping_sub(rom[at + a]).wrapping_sub(1));
    }

    /// Saves `gb`, loads the state into a fresh machine on `rom`, and returns it; also checks a
    /// state cut right after KEY0 (before the mapper block existed) still loads.
    fn reload(gb: &GameBoy, rom: &[u8]) -> GameBoy {
        let state = gb.save_state();
        let cut = state.len() - 11 - 0x30 - TIMING_TAIL_LEN - 2 - gb.bus.cartridge.export_extra().len(); // 11: RP, mode-3 length, speed switch, OPRI, revision, CPU lock; 0x30: $FEA0 RAM
        assert_eq!(state[cut..cut + 2], (gb.bus.cartridge.export_extra().len() as u16).to_le_bytes());
        let mut old = GameBoy::new(rom.to_vec()).unwrap();
        assert!(old.load_state(&state[..cut]), "a state without the mapper block");
        let mut g = GameBoy::new(rom.to_vec()).unwrap();
        assert!(g.load_state(&state));
        g
    }

    /// MMM01 locked to its game, MBC6 half-way through a flash program sequence, TAMA5 with a
    /// register selected: each goes on from the same place after a load.
    #[test]
    fn every_new_mapper_resumes_from_a_state() {
        // MMM01: 256 KiB, marker 0xC0 + n per 16 KiB bank, the menu header in the last 32 KiB.
        let mut rom = vec![0u8; 0x40000];
        for n in 0..16 { rom[n * 0x4000] = 0xC0 + n as u8; }
        header(&mut rom, 0, 0x01, 0x00);
        header(&mut rom, 0x38000, 0x0D, 0x03);
        let mut gb = GameBoy::new(rom.clone()).unwrap();
        let c = &mut gb.bus.cartridge;
        for (a, v) in [(0x2000, 0x04), (0x6000, 0x38), (0x4000, 0x01), (0x0000, 0x70), (0x0000, 0x7A), (0x2000, 0x02)] {
            c.write_rom(a, v);
        }
        c.write_ram(0, 0x42);
        let mut g = reload(&gb, &rom);
        let c = &mut g.bus.cartridge;
        assert_eq!((c.read_rom(0x0000), c.read_rom(0x4000), c.read_ram(0)), (0xC4, 0xC6, 0x42));
        c.write_rom(0x2000, 0x08);
        assert_eq!(c.read_rom(0x0000), 0xC4, "still locked");

        // MBC6: the unlock cycles and the program command sent, the byte not yet.
        let mut rom = vec![0u8; 0x20000];
        for n in 0..16 { rom[n * 0x2000] = 0xD0 + n as u8; }
        header(&mut rom, 0, 0x20, 0x03);
        let mut gb = GameBoy::new(rom.clone()).unwrap();
        let c = &mut gb.bus.cartridge;
        for (a, v) in [(0x0C00, 1), (0x1000, 1), (0x2800, 0x08), (0x3000, 7)] { c.write_rom(a, v); }
        for (bank, a, v) in [(2, 0x5555, 0xAA), (1, 0x4AAA, 0x55), (2, 0x5555, 0xA0)] {
            (c.write_rom(0x2000, bank), c.write_rom(a, v));
        }
        c.write_rom(0x2000, 3);
        let mut g = reload(&gb, &rom);
        let c = &mut g.bus.cartridge;
        assert_eq!(c.read_rom(0x6000), 0xD7, "window B's bank");
        c.write_rom(0x4000, 0x5A);
        c.write_rom(0x4000, 0xF0);
        assert_eq!(c.read_rom(0x4000), 0x5A, "the program sequence completes");

        // TAMA5: ROM bank 6, register D selected after a RAM read of 0x9C.
        let mut rom = vec![0u8; 0x80000];
        for n in 0..32 { rom[n * 0x4000] = n as u8; }
        header(&mut rom, 0, 0xFD, 0x00);
        let mut gb = GameBoy::new(rom.clone()).unwrap();
        let c = &mut gb.bus.cartridge;
        for (r, v) in [(0, 6), (4, 0xC), (5, 0x9), (6, 0), (7, 3), (6, 2), (7, 3)] {
            (c.write_ram(1, r), c.write_ram(0, v));
        }
        c.write_ram(1, 0xD);
        let mut g = reload(&gb, &rom);
        let c = &mut g.bus.cartridge;
        assert_eq!((c.read_rom(0x4000), c.read_ram(0)), (6, 0xF9));
    }
}
