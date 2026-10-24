//! The emulator session: one gb-core `GameBoy` kept in memory between tool calls, named
//! save-state slots, breakpoints and watchpoints, plus the routine caller (push a sentinel
//! return address, single-step the whole machine until it comes back).

use std::collections::BTreeMap;

use gb_core::debug::{Break, WATCH_READ, WATCH_WRITE};
use gb_core::gameboy::GameBoy;
use gb_core::interrupts::JOYPAD_BIT;
use gb_core::joypad::JoypadButton;
use serde_json::{json, Map, Value};

use crate::db::{banked, View};
use crate::rom::{Rom, Sweeper};
use crate::{arr, bytes, capped, hex, num, opt_num, R};

/// Upper bounds per call: the server answers one request at a time, so a call must stay short.
pub const MAX_FRAMES: u32 = 10_800; // 3 min of game time; about 1 min of wall time at ~200 fps
pub const MAX_STEPS: u32 = 50_000_000;

pub struct Wp {
    pub addr: u16,
    pub len: u16,
    pub read: bool,
    pub write: bool,
    pub bank: Option<u16>,
}

#[derive(Default)]
pub struct Emu {
    pub gb: Option<GameBoy>,
    pub slots: BTreeMap<String, Vec<u8>>,
    pub bps: Vec<(Option<u16>, u16)>,
    pub wps: Vec<Wp>,
    pub frames: u64,
}

pub type Loc = (Option<u16>, u16);

pub fn power_on(rom: &Rom) -> R<GameBoy> {
    let mut gb = GameBoy::new(rom.data.clone()).map_err(|e| format!("the emulator rejects this ROM: {e}"))?;
    gb.skip_boot_rom();
    Ok(gb)
}

/// The session's machine, powered on (boot ROM skipped, post-boot state) on first use.
pub fn machine<'a>(gb: &'a mut Option<GameBoy>, rom: &Rom) -> R<&'a mut GameBoy> {
    if gb.is_none() {
        *gb = Some(power_on(rom)?);
    }
    Ok(gb.as_mut().unwrap())
}

// ---------- locations ----------

pub fn rom_bank(gb: &GameBoy) -> u16 {
    gb.bus.cartridge.current_rom_bank()
}

pub fn wram_bank(gb: &GameBoy) -> u16 {
    (gb.bus.wram_bank as u16).max(1)
}

/// The bank mapped at `addr` right now (0 for unbanked regions).
pub fn here(gb: &GameBoy, addr: u16) -> u16 {
    match addr {
        0x4000..=0x7FFF => rom_bank(gb),
        0xD000..=0xDFFF => wram_bank(gb),
        _ => 0,
    }
}

pub fn fmt(gb: &GameBoy, view: &View, addr: u16) -> String {
    view.fmt(here(gb, addr), addr)
}

/// Is the PC at this location (bank checked only in banked regions, when given)?
fn at(gb: &GameBoy, (bank, addr): Loc) -> bool {
    gb.cpu.regs.pc == addr && bank.is_none_or(|b| !banked(addr) || here(gb, addr) == b)
}

pub fn read16(gb: &GameBoy, a: u16) -> u16 {
    u16::from_le_bytes([gb.bus.read_byte(a), gb.bus.read_byte(a.wrapping_add(1))])
}

/// Maps `bank` at $4000-$7FFF through the cartridge's MBC registers (from the header type).
pub fn set_rom_bank(gb: &mut GameBoy, bank: u16) -> R<()> {
    let t = gb.bus.cartridge.read_rom(0x147);
    match t {
        0x01..=0x03 => {
            gb.bus.write_byte(0x2000, (bank & 0x1F) as u8);
            // The high bits, also cleared when a large ROM had them set (on a small ROM this
            // register may be the RAM bank: left alone).
            if bank > 0x1F || gb.bus.cartridge.read_rom(0x148) >= 5 {
                gb.bus.write_byte(0x4000, ((bank >> 5) & 3) as u8);
            }
            if bank & 0x1F == 0 && bank > 0 {
                return Err(format!("MBC1 cannot map ROM bank {bank:02X} at $4000-$7FFF (the hardware maps {:02X}); its code runs only at $0000-$3FFF in mode 1", bank + 1));
            }
        }
        0x05 | 0x06 => gb.bus.write_byte(0x2100, (bank & 0x0F) as u8),
        0x19..=0x1E => {
            gb.bus.write_byte(0x2000, bank as u8);
            gb.bus.write_byte(0x3000, (bank >> 8) as u8 & 1);
        }
        _ => gb.bus.write_byte(0x2000, bank as u8),
    }
    match rom_bank(gb) {
        b if b == bank => Ok(()),
        b => Err(format!("cannot map ROM bank {bank:02X} (cartridge type {t:02X}); bank {b:02X} is mapped")),
    }
}

/// Index into the 8 WRAM banks of bank `b` at `a` ($D000-$DFFF), as SVBK maps it (low 3 bits, 0 = 1).
fn wram_at(b: u16, a: u16) -> usize {
    ((b & 7).max(1) as usize) * 0x1000 + (a - 0xD000) as usize
}

/// The bank a range starting at `start` in `bank` gives to `a`: only inside the banked region
/// the range started in; anywhere else the live mapping applies (None).
pub fn bank_at(bank: Option<u16>, start: u16, a: u16) -> Option<u16> {
    bank.filter(|_| banked(start) && banked(a) && (a < 0x8000) == (start < 0x8000))
}

/// Reads through a location: a given bank picks the raw ROM bank ($4000-$7FFF) or the WRAM
/// bank ($D000-$DFFF) without remapping anything; otherwise the current mapping.
pub fn read_loc(gb: &GameBoy, rom: &Rom, (bank, addr): Loc, len: usize) -> Vec<u8> {
    (0..len)
        .map(|i| {
            let a = addr.wrapping_add(i as u16);
            match (bank_at(bank, addr, a), a) {
                (Some(b), 0x4000..=0x7FFF) => rom.byte(b, a).unwrap_or(0xFF),
                (Some(b), 0xD000..=0xDFFF) => gb.bus.wram[wram_at(b, a)],
                _ => gb.bus.read_byte(a),
            }
        })
        .collect()
}

/// Writes through a location: a banked $D000 write goes straight to that WRAM bank. ROM-area
/// writes reach the MBC registers, as on hardware.
pub fn write_loc(gb: &mut GameBoy, (bank, addr): Loc, data: &[u8]) {
    for (i, &b) in data.iter().enumerate() {
        let a = addr.wrapping_add(i as u16);
        match (bank_at(bank, addr, a), a) {
            (Some(k), 0xD000..=0xDFFF) => gb.bus.wram[wram_at(k, a)] = b,
            _ => gb.bus.write_byte(a, b),
        }
    }
}

/// The instruction at `pc` in the live mapping, labels substituted.
pub fn insn_text(gb: &GameBoy, view: &View, pc: u16) -> String {
    let fetch = |a: u16| Some(gb.bus.read_byte(a));
    Sweeper::default().step(&fetch, view, here(gb, pc), pc).map(|i| i.text(view)).unwrap_or_default()
}

pub fn regs_json(gb: &GameBoy, view: &View) -> Value {
    let r = &gb.cpu.regs;
    json!({
        "a": format!("{:02X}", r.a), "f": format!("{:02X}", r.f),
        "b": format!("{:02X}", r.b), "c": format!("{:02X}", r.c),
        "d": format!("{:02X}", r.d), "e": format!("{:02X}", r.e),
        "h": format!("{:02X}", r.h), "l": format!("{:02X}", r.l),
        "bc": format!("{:04X}", r.bc()), "de": format!("{:04X}", r.de()), "hl": format!("{:04X}", r.hl()),
        "sp": format!("{:04X}", r.sp), "pc": fmt(gb, view, r.pc),
        "stack_top": fmt(gb, view, read16(gb, r.sp)),
        "flags": {"z": r.zero(), "n": r.subtract(), "h": r.half_carry(), "c": r.carry()},
        "ime": gb.cpu.ime, "halted": gb.cpu.halted,
        "rom_bank": format!("{:02X}", rom_bank(gb)), "wram_bank": format!("{:02X}", wram_bank(gb)),
    })
}

/// true/false, or a number (0 = false).
pub fn flag(v: &Value) -> R<bool> {
    v.as_bool().map_or_else(|| num(v).map(|n| n != 0), Ok)
}

/// Sets registers from {"a":..,"bc":..,"sp":..,"pc":..,"flags":{"z":true},"ime":true}.
pub fn set_regs(gb: &mut GameBoy, m: &Value) -> R<()> {
    let Some(m) = m.as_object() else { return Ok(()) };
    for (k, v) in m {
        let r = &mut gb.cpu.regs;
        match k.as_str() {
            "flags" => {
                let g = |n: &str| v.get(n).map(flag).transpose();
                if let Some(x) = g("z")? { r.set_zero(x) }
                if let Some(x) = g("n")? { r.set_subtract(x) }
                if let Some(x) = g("h")? { r.set_half_carry(x) }
                if let Some(x) = g("c")? { r.set_carry(x) }
            }
            "ime" => {
                gb.cpu.ime = flag(v)?;
                gb.cpu.ime_pending = false;
            }
            _ => {
                let n = num(v)?;
                match k.as_str() {
                    "a" => r.a = n as u8, "f" => r.f = n as u8 & 0xF0,
                    "b" => r.b = n as u8, "c" => r.c = n as u8, "d" => r.d = n as u8,
                    "e" => r.e = n as u8, "h" => r.h = n as u8, "l" => r.l = n as u8,
                    "af" => r.set_af(n as u16 & 0xFFF0), "bc" => r.set_bc(n as u16),
                    "de" => r.set_de(n as u16), "hl" => r.set_hl(n as u16),
                    "sp" => r.sp = n as u16, "pc" => r.pc = n as u16,
                    _ => return Err(format!("unknown register {k:?}")),
                }
            }
        }
    }
    Ok(())
}

// ---------- input ----------

pub type Inputs = Vec<(u32, Vec<JoypadButton>, u32)>;

pub fn buttons(s: &str) -> R<Vec<JoypadButton>> {
    s.split('+')
        .map(|b| {
            Ok(match b.trim().to_ascii_lowercase().as_str() {
                "a" => JoypadButton::A, "b" => JoypadButton::B,
                "select" => JoypadButton::Select, "start" => JoypadButton::Start,
                "up" => JoypadButton::Up, "down" => JoypadButton::Down,
                "left" => JoypadButton::Left, "right" => JoypadButton::Right,
                o => return Err(format!("unknown button {o:?} (a b start select up down left right)")),
            })
        })
        .collect()
}

/// ["frame:button[+button][:hold]", ...]; frames count from the start of the run, hold
/// defaults to 5 frames.
pub fn parse_inputs(v: &[Value]) -> R<Inputs> {
    v.iter()
        .map(|v| {
            let s = v.as_str().ok_or("inputs are strings \"frame:button[+button][:hold]\"")?;
            let mut it = s.split(':');
            let f = it.next().unwrap().trim().parse().map_err(|_| format!("bad frame in {s:?}"))?;
            let b = buttons(it.next().ok_or(format!("no button in {s:?}"))?)?;
            let h = it.next().map_or(Ok(5), |h| h.trim().parse().map_err(|_| format!("bad hold in {s:?}")))?;
            Ok((f, b, h))
        })
        .collect()
}

fn apply_inputs(gb: &mut GameBoy, inputs: &Inputs, f: u32) {
    for (at, bs, hold) in inputs {
        for &b in bs {
            if f == *at && gb.bus.joypad.set_button(b, true) {
                gb.bus.interrupts.request(JOYPAD_BIT);
            }
            if f == at.saturating_add(*hold) {
                gb.bus.joypad.set_button(b, false);
            }
        }
    }
}

fn release(gb: &mut GameBoy, inputs: &Inputs) {
    for (_, bs, _) in inputs {
        for &b in bs {
            gb.bus.joypad.set_button(b, false);
        }
    }
}

// ---------- running ----------

fn sync_debugger(gb: &mut GameBoy, bps: &[Loc], wps: &[Wp]) {
    let d = gb.debugger_mut();
    d.breakpoints = bps.iter().map(|b| b.1).collect();
    d.hit = None;
    gb.bus.watch = None;
    for w in wps {
        let kind = if w.read { WATCH_READ } else { 0 } | if w.write { WATCH_WRITE } else { 0 };
        for i in 0..w.len {
            gb.watch_add(w.addr.wrapping_add(i), kind);
        }
    }
}

/// Power on and run `frames` frames with an input script.
pub fn boot(emu: &mut Emu, rom: &Rom, view: &View, frames: u32, inputs: &Inputs) -> R<Value> {
    emu.gb = Some(power_on(rom)?);
    emu.frames = 0;
    run_frames(emu, rom, view, frames, inputs)
}

/// Runs whole frames with an input script, stopping early on a breakpoint or watchpoint.
pub fn run_frames(emu: &mut Emu, rom: &Rom, view: &View, frames: u32, inputs: &Inputs) -> R<Value> {
    let Emu { gb, bps, wps, frames: total, .. } = emu;
    let gb = machine(gb, rom)?;
    sync_debugger(gb, bps, wps);
    gb.resume_here();
    let (mut done, mut mid, mut stop) = (0u32, false, None);
    while done < frames {
        if !mid {
            apply_inputs(gb, inputs, done);
        }
        gb.run_frame().map_err(|e| format!("frame {done}: {e}"))?;
        match gb.take_break() {
            None => {
                done += 1;
                *total += 1;
                mid = false;
            }
            Some(Break::Breakpoint(pc)) => {
                mid = true;
                if bps.iter().any(|b| at(gb, *b)) {
                    stop = Some(json!({"reason": "breakpoint", "at": fmt(gb, view, pc), "insn": insn_text(gb, view, pc),
                                       "caller": fmt(gb, view, read16(gb, gb.cpu.regs.sp))}));
                    break;
                }
                gb.resume_here(); // same address, other bank: keep going
            }
            Some(Break::Watch { addr, value, write, pc }) => {
                mid = true;
                let hit = wps.iter().any(|w| {
                    addr.wrapping_sub(w.addr) < w.len && if write { w.write } else { w.read }
                        && w.bank.is_none_or(|b| !banked(addr) || here(gb, addr) == b)
                });
                if hit {
                    stop = Some(json!({"reason": "watchpoint", "kind": if write { "write" } else { "read" },
                        "addr": fmt(gb, view, addr), "value": format!("{value:02X}"), "pc": fmt(gb, view, pc),
                        "insn": insn_text(gb, view, pc), "caller": fmt(gb, view, read16(gb, gb.cpu.regs.sp))}));
                    break;
                }
            }
            Some(_) => mid = true,
        }
    }
    release(gb, inputs);
    Ok(json!({"stop": stop.unwrap_or(json!({"reason": "frames"})), "frames_run": done, "total_frames": *total, "regs": regs_json(gb, view)}))
}

/// Single-steps `count` instructions; stops at a breakpoint (not on the first step) or when a
/// write watchpoint's value changes (reads are not seen in step mode).
pub fn step(emu: &mut Emu, rom: &Rom, view: &View, count: u32) -> R<Value> {
    let Emu { gb, bps, wps, .. } = emu;
    let gb = machine(gb, rom)?;
    let mut shadow: Vec<(u16, u8)> =
        wps.iter().filter(|w| w.write).flat_map(|w| (0..w.len).map(move |i| w.addr.wrapping_add(i))).map(|a| (a, gb.bus.read_byte(a))).collect();
    let (mut log, mut stop, mut done) = (vec![], None, 0u32);
    while done < count {
        let pc = gb.cpu.regs.pc;
        if done > 0 && bps.iter().any(|b| at(gb, *b)) {
            stop = Some(json!({"reason": "breakpoint", "at": fmt(gb, view, pc)}));
            break;
        }
        if gb.cpu.locked {
            stop = Some(json!({"reason": "cpu_locked", "at": format!("{:04X}", gb.cpu.locked_pc)}));
            break;
        }
        if log.len() < 64 {
            log.push(format!("{}  {}", fmt(gb, view, pc), insn_text(gb, view, pc)));
        }
        let pc_loc = fmt(gb, view, pc);
        gb.step_instruction().map_err(|e| e.to_string())?;
        done += 1;
        for (a, old) in shadow.iter_mut() {
            let new = gb.bus.read_byte(*a);
            if new != *old && stop.is_none() {
                stop = Some(json!({"reason": "watchpoint", "addr": fmt(gb, view, *a), "old": format!("{old:02X}"), "new": format!("{new:02X}"), "pc": pc_loc}));
            }
            *old = new;
        }
        if stop.is_some() {
            break;
        }
    }
    let pc = gb.cpu.regs.pc;
    Ok(json!({"steps": done, "stop": stop.unwrap_or(json!({"reason": "count"})), "executed": log, "executed_truncated": done as usize > log.len(),
              "next": format!("{}  {}", fmt(gb, view, pc), insn_text(gb, view, pc)), "regs": regs_json(gb, view)}))
}

/// Calls one routine: optional slot restore, setup (rom_bank, svbk, writes, regs), push a
/// sentinel return address, jump, and single-step (whole machine clocked, so VBlank waits and
/// interrupts run) until the sentinel comes back, a breakpoint hits or max_steps runs out.
pub fn call(emu: &mut Emu, rom: &Rom, view: &View, p: &Value) -> R<Value> {
    if let Some(s) = p.get("from_slot").and_then(Value::as_str) {
        let data = emu.slots.get(s).ok_or(format!("no state slot {s:?}"))?.clone();
        let gb = machine(&mut emu.gb, rom)?;
        if !gb.load_state(&data) {
            return Err(format!("slot {s:?} rejected by the core"));
        }
    }
    let gb = machine(&mut emu.gb, rom)?;
    let loc = |v: &Value| view.loc(v);
    if let Some(v) = p.get("ime") {
        gb.cpu.ime = flag(v)?;
        gb.cpu.ime_pending = false;
    }
    let halted = std::mem::replace(&mut gb.cpu.halted, false);
    if let Some(b) = p.get("rom_bank") {
        set_rom_bank(gb, num(b)? as u16)?;
    }
    if let Some(b) = p.get("svbk") {
        gb.bus.write_byte(0xFF70, num(b)? as u8);
    }
    for w in arr(p, "writes") {
        write_loc(gb, loc(&w["addr"])?, &bytes(&w["bytes"])?);
    }
    if let Some(r) = p.get("regs") {
        set_regs(gb, r)?;
    }
    let (bank, addr) = loc(p.get("addr").ok_or("call_routine needs \"addr\"")?)?;
    if let (Some(b), 0x4000..=0x7FFF) = (bank, addr) {
        set_rom_bank(gb, b)?;
    }
    let sentinel = opt_num(p, "sentinel", 0xFEFF)? as u16;
    let resume = (gb.cpu.regs.pc, gb.cpu.regs.sp, halted);
    let sp = gb.cpu.regs.sp.wrapping_sub(2);
    gb.bus.write_byte(sp, sentinel as u8);
    gb.bus.write_byte(sp.wrapping_add(1), (sentinel >> 8) as u8);
    gb.cpu.regs.sp = sp;
    gb.cpu.regs.pc = addr;

    let max_steps = capped(p, "max_steps", 5_000_000, MAX_STEPS)? as u64;
    let trace_on = p.get("trace").is_some_and(|v| v.as_bool().unwrap_or(true));
    let trace_max = p.get("trace").and_then(Value::as_u64).unwrap_or(2000).min(100_000) as usize;
    let trace_steps = p.get("trace_steps").and_then(Value::as_u64).unwrap_or(0).min(100_000) as usize;
    let bps = arr(p, "breakpoints").iter().map(loc).collect::<R<Vec<_>>>()?;
    let stubs = arr(p, "stubs").iter().map(|s| Ok((loc(&s["addr"])?, s.get("regs").cloned()))).collect::<R<Vec<_>>>()?;
    let forces = arr(p, "forces").iter().map(|f| Ok((loc(&f["addr"])?, bytes(&f["bytes"])?))).collect::<R<Vec<_>>>()?;
    let mut watch = vec![];
    for w in arr(p, "watch") {
        let (b, a) = loc(&w["addr"])?;
        for i in 0..opt_num(w, "len", 1)?.clamp(1, 0x1000) as u16 {
            let l = (b, a.wrapping_add(i));
            watch.push((l, read_loc(gb, rom, l, 1)[0]));
        }
    }
    let (mut trace, mut steplog, mut changes, mut stub_hits) = (vec![], vec![], vec![], 0u64);
    let (mut steps, mut cycles, mut vblanks) = (0u64, 0u64, 0u64);
    let pcloc = |gb: &GameBoy, pc: u16, bank: u16| view.fmt(if pc < 0x4000 { 0 } else if pc < 0x8000 { bank } else { here(gb, pc) }, pc);

    let reason = loop {
        let pc = gb.cpu.regs.pc;
        if pc == sentinel {
            break "returned".to_string();
        }
        if steps >= max_steps {
            break "max_steps".into();
        }
        if gb.cpu.locked {
            break format!("cpu_locked at {:04X}", gb.cpu.locked_pc);
        }
        for (l, b) in &forces {
            write_loc(gb, *l, b);
        }
        if steps > 0 && bps.iter().any(|b| at(gb, *b)) {
            break format!("breakpoint {}", fmt(gb, view, pc));
        }
        if let Some((_, regs)) = stubs.iter().find(|(l, _)| at(gb, *l)) {
            let from = fmt(gb, view, pc);
            let ret = read16(gb, gb.cpu.regs.sp);
            gb.cpu.regs.sp = gb.cpu.regs.sp.wrapping_add(2);
            gb.cpu.regs.pc = ret;
            if let Some(r) = regs {
                set_regs(gb, r)?;
            }
            stub_hits += 1;
            steps += 1;
            if trace_on && trace.len() < trace_max {
                trace.push(json!({"step": steps, "kind": "stub", "at": from, "ret": fmt(gb, view, ret)}));
            }
            continue;
        }
        let bank_before = rom_bank(gb);
        let ly_before = gb.bus.ppu.ly;
        let pending = gb.bus.interrupts.interrupt_enable & gb.bus.interrupts.interrupt_flag & 0x1F;
        let irq = gb.cpu.ime && pending != 0; // dispatched before this step's instruction
        let (text, len) = gb_core::disasm::disassemble_one(&gb.bus, pc);
        if steplog.len() < trace_steps {
            steplog.push(format!("{} {}", pcloc(gb, pc, bank_before), insn_text(gb, view, pc)));
        }
        match gb.step_instruction() {
            Ok(c) => cycles += c as u64,
            Err(e) => break format!("error: {e}"),
        }
        steps += 1;
        if gb.bus.ppu.ly == 144 && ly_before != 144 {
            vblanks += 1;
        }
        let npc = gb.cpu.regs.pc;
        if trace_on && trace.len() < trace_max {
            let dispatched = irq && !gb.cpu.ime;
            if dispatched {
                let vector = 0x40 + 8 * pending.trailing_zeros() as u16;
                trace.push(json!({"step": steps, "kind": "irq", "from": pcloc(gb, pc, bank_before), "to": view.fmt(0, vector)}));
            } else if npc != pc.wrapping_add(len as u16) && (text.starts_with("CALL") || text.starts_with("RST")) {
                let kind = if text.starts_with("RST") { "rst" } else { "call" };
                trace.push(json!({"step": steps, "kind": kind, "from": pcloc(gb, pc, bank_before), "to": fmt(gb, view, npc),
                                  "sp": format!("{:04X}", gb.cpu.regs.sp)}));
            } else if text == "JP HL" {
                trace.push(json!({"step": steps, "kind": "jp_hl", "from": pcloc(gb, pc, bank_before), "to": fmt(gb, view, npc)}));
            }
            if rom_bank(gb) != bank_before {
                trace.push(json!({"step": steps, "kind": "bank", "at": pcloc(gb, pc, bank_before),
                                  "from": format!("{bank_before:02X}"), "to": format!("{:02X}", rom_bank(gb))}));
            }
        }
        for (l, old) in watch.iter_mut() {
            let new = read_loc(gb, rom, *l, 1)[0];
            if new != *old {
                if changes.len() < 10_000 {
                    changes.push(json!({"step": steps, "pc": pcloc(gb, pc, bank_before), "addr": view.fmt(l.0.unwrap_or(here(gb, l.1)), l.1),
                                        "old": format!("{old:02X}"), "new": format!("{new:02X}")}));
                }
                *old = new;
            }
        }
    };
    if reason == "returned" {
        // Back where the session was, so run/step carry on from there, not from the sentinel.
        (gb.cpu.regs.pc, gb.cpu.regs.sp, gb.cpu.halted) = resume;
    }
    let mut out = Map::new();
    out.insert("stop_reason".into(), json!(reason));
    out.insert("steps".into(), json!(steps));
    out.insert("cycles".into(), json!(cycles));
    out.insert("vblanks".into(), json!(vblanks));
    out.insert("stub_hits".into(), json!(stub_hits));
    out.insert("regs".into(), regs_json(gb, view));
    out.insert("dumps".into(), dumps(gb, rom, view, arr(p, "dumps"))?);
    if trace_on {
        out.insert("trace".into(), json!(trace));
    }
    if trace_steps > 0 {
        out.insert("steplog".into(), json!(steplog));
    }
    if !watch.is_empty() {
        out.insert("watch".into(), json!(changes));
    }
    Ok(Value::Object(out))
}

/// [{"addr": "C000", "len": 16}, ...] -> [{"addr", "hex"}].
pub fn dumps(gb: &GameBoy, rom: &Rom, view: &View, list: &[Value]) -> R<Value> {
    list.iter()
        .map(|d| {
            let l = view.loc(&d["addr"])?;
            let len = opt_num(d, "len", 1)?.clamp(1, 0x10000) as usize;
            let bank = l.0.filter(|_| banked(l.1)).unwrap_or(here(gb, l.1));
            Ok(json!({"addr": view.fmt(bank, l.1), "hex": hex(&read_loc(gb, rom, l, len))}))
        })
        .collect::<R<Vec<_>>>()
        .map(Value::Array)
}

/// The screen as a PNG, scaled by an integer factor (nearest neighbour).
pub fn screenshot(gb: &GameBoy, scale: u32) -> R<Vec<u8>> {
    let s = scale.clamp(1, 8) as usize;
    let src = gb.screen();
    let (w, h) = (160 * s, 144 * s);
    let mut img = Vec::with_capacity(w * h * 4);
    for y in 0..h {
        for x in 0..w {
            let i = ((y / s) * 160 + x / s) * 4;
            img.extend_from_slice(&src[i..i + 4]);
        }
    }
    let mut out = vec![];
    let mut enc = png::Encoder::new(&mut out, w as u32, h as u32);
    enc.set_color(png::ColorType::Rgba);
    enc.set_depth(png::BitDepth::Eight);
    let mut wr = enc.write_header().map_err(|e| e.to_string())?;
    wr.write_image_data(&img).map_err(|e| e.to_string())?;
    wr.finish().map_err(|e| e.to_string())?;
    Ok(out)
}
