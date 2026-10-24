//! Static analysis of the open ROM: header, banked disassembly, the cross-reference index,
//! byte / immediate search, function bounds, call graph and charmap text decoding. Nothing here
//! emulates: every byte comes straight from the ROM file (or, for RAM code, a fetch closure
//! the caller builds over the live session).

use std::collections::hash_map::DefaultHasher;
use std::collections::{BTreeMap, BTreeSet, HashMap, VecDeque};
use std::hash::{Hash, Hasher};
use std::sync::OnceLock;

use gb_core::disasm::disassemble_bytes;
use serde_json::{json, Value};

use crate::db::{banked, Conv, View};
use crate::{hex, R};

pub struct Rom {
    pub path: String,
    pub data: Vec<u8>,
    pub sha1: String,
    index: Option<(u64, Index)>,
}

impl Rom {
    pub fn new(path: String, data: Vec<u8>) -> R<Rom> {
        if data.len() < 0x150 {
            return Err(format!("{path}: {} bytes is too small for a Game Boy ROM (header ends at $014F)", data.len()));
        }
        let sha1 = sha1_smol::Sha1::from(&data).digest().to_string();
        Ok(Rom { path, data, sha1, index: None })
    }

    pub fn open(path: &str) -> R<Rom> {
        let data = std::fs::read(path).map_err(|e| format!("cannot read ROM {path}: {e}"))?;
        Rom::new(path.into(), data)
    }

    pub fn banks(&self) -> u16 {
        self.data.len().div_ceil(0x4000) as u16
    }

    /// The byte at bank:addr of the ROM file ($0000-$3FFF is bank 0 whatever `bank` says).
    pub fn byte(&self, bank: u16, addr: u16) -> Option<u8> {
        let off = match addr {
            0..=0x3FFF => addr as usize,
            0x4000..=0x7FFF => bank as usize * 0x4000 + (addr as usize - 0x4000),
            _ => return None,
        };
        self.data.get(off).copied()
    }

    pub fn header(&self) -> Value {
        let h = &self.data;
        let title = &h[0x134..0x144];
        let ascii: String = title.iter().map(|&c| if (0x20..0x7F).contains(&c) { c as char } else { '.' }).collect();
        let checksum = h[0x134..0x14D].iter().fold(0u8, |c, &b| c.wrapping_sub(b).wrapping_sub(1));
        let rom_kb = 32u32.checked_shl(h[0x148] as u32).unwrap_or(0);
        let ram_kb = match h[0x149] { 0 => 0, 1 => 2, 2 => 8, 3 => 32, 4 => 128, 5 => 64, _ => 0 };
        json!({
            "path": self.path, "sha1": self.sha1, "size": self.data.len(), "banks": self.banks(),
            "title_hex": hex(title), "title_ascii": ascii,
            "cgb": match h[0x143] { 0x80 => "cgb_compatible", 0xC0 => "cgb_only", _ => "dmg" },
            "sgb": h[0x146] == 0x03,
            "cart_type": format!("{:02X} {}", h[0x147], cart_name(h[0x147])),
            "rom_size": format!("{:02X} ({rom_kb} KiB)", h[0x148]),
            "ram_size": format!("{:02X} ({ram_kb} KiB)", h[0x149]),
            "header_checksum_ok": checksum == h[0x14D],
            "entry": hex(&h[0x100..0x104]),
        })
    }

    /// The cross-reference index for this ROM and knowledge, rebuilt only when labels or
    /// far-call conventions change.
    pub fn index(&mut self, view: &View) -> &Index {
        let fp = fingerprint(view);
        if self.index.as_ref().map(|x| x.0) != Some(fp) {
            let idx = Index::build(self, view);
            self.index = Some((fp, idx));
        }
        &self.index.as_ref().unwrap().1
    }
}

fn cart_name(t: u8) -> &'static str {
    match t {
        0x00 => "ROM ONLY", 0x01 => "MBC1", 0x02 => "MBC1+RAM", 0x03 => "MBC1+RAM+BATTERY",
        0x05 => "MBC2", 0x06 => "MBC2+BATTERY", 0x08 => "ROM+RAM", 0x09 => "ROM+RAM+BATTERY",
        0x0B => "MMM01", 0x0C => "MMM01+RAM", 0x0D => "MMM01+RAM+BATTERY",
        0x0F => "MBC3+TIMER+BATTERY", 0x10 => "MBC3+TIMER+RAM+BATTERY", 0x11 => "MBC3",
        0x12 => "MBC3+RAM", 0x13 => "MBC3+RAM+BATTERY", 0x19 => "MBC5", 0x1A => "MBC5+RAM",
        0x1B => "MBC5+RAM+BATTERY", 0x1C => "MBC5+RUMBLE", 0x1D => "MBC5+RUMBLE+RAM",
        0x1E => "MBC5+RUMBLE+RAM+BATTERY", 0x20 => "MBC6", 0x22 => "MBC7+SENSOR+RUMBLE+RAM+BATTERY",
        0xFC => "POCKET CAMERA", 0xFD => "BANDAI TAMA5", 0xFE => "HuC3", 0xFF => "HuC1+RAM+BATTERY",
        _ => "unknown",
    }
}

fn fingerprint(view: &View) -> u64 {
    let mut h = DefaultHasher::new();
    for (k, l) in &view.labels {
        (k, &l.kind, l.size(), l.table()).hash(&mut h);
    }
    for c in &view.convs {
        format!("{c:?}").hash(&mut h);
    }
    h.finish()
}

// ---------- decoding ----------

/// Opcodes the SM83 doesn't have: executing one locks the CPU, so code never flows past it.
pub fn illegal(op: u8) -> bool {
    matches!(op, 0xD3 | 0xDB | 0xDD | 0xE3 | 0xE4 | 0xEB | 0xEC | 0xED | 0xF4 | 0xFC | 0xFD)
}

fn lens() -> &'static [u8; 256] {
    static L: OnceLock<[u8; 256]> = OnceLock::new();
    L.get_or_init(|| std::array::from_fn(|op| disassemble_bytes(0, [op as u8, 0, 0]).1))
}

#[derive(Clone, Copy, PartialEq, Eq, Debug, Hash, PartialOrd, Ord)]
pub enum Kind {
    Call,
    Jp,
    Jr,
    Rst,
    /// An immediate address operand (LD rr,nn / LD [nn],A / LD A,[nn] / LD [nn],SP / LDH).
    Ld,
    /// A far call through declared convention #n.
    Far(usize),
    /// An entry of a declared jumptable / pointers table.
    Table,
}
impl Kind {
    pub fn label(&self, view: &View) -> String {
        match self {
            Kind::Call => "call".into(),
            Kind::Jp => "jp".into(),
            Kind::Jr => "jr".into(),
            Kind::Rst => "rst".into(),
            Kind::Ld => "ld".into(),
            Kind::Far(i) => format!("far:{}", view.convs.get(*i).map_or("?", |c| c.name())),
            Kind::Table => "table".into(),
        }
    }
}

#[derive(Clone, Debug)]
pub struct Ref {
    pub kind: Kind,
    pub cond: bool,
    /// None: unknown statically (bank-0 code pointing into $4000-$7FFF, or $D000-$DFFF).
    pub bank: Option<u16>,
    pub to: u16,
}

pub struct Insn {
    pub bank: u16,
    pub addr: u16,
    pub op_len: u8,
    pub bytes: [u8; 3],
    /// Bytes taken, inline far-call data included.
    pub len: u16,
    /// Unconditional RET / RETI / JP / JR / JP HL, or an illegal opcode: no fall-through.
    pub ends: bool,
    pub refs: Vec<Ref>,
}

impl Insn {
    pub fn op(&self) -> u8 {
        self.bytes[0]
    }

    /// RGBDS text with labels substituted for known targets.
    pub fn text(&self, view: &View) -> String {
        let mut t = disassemble_bytes(self.addr, self.bytes).0;
        for r in &self.refs {
            let Some(b) = r.bank else { continue };
            let Some(n) = view.exact(b, r.to) else { continue };
            t = match r.kind {
                Kind::Rst => t.replace(&format!("${:02X}", r.to), n),
                Kind::Far(_) | Kind::Table => continue,
                _ => t.replace(&format!("${:04X}", r.to), n),
            };
        }
        t
    }
}

/// A linear sweeper: decodes one instruction at a time, tracking immediate register loads so a
/// `regs` far-call convention can be resolved, and consuming inline far-call bytes.
#[derive(Default)]
pub struct Sweeper {
    regs: [Option<u8>; 8],
}

impl Sweeper {
    pub fn reset(&mut self) {
        self.regs = [None; 8];
    }

    pub fn step(&mut self, fetch: &dyn Fn(u16) -> Option<u8>, view: &View, bank: u16, addr: u16) -> Option<Insn> {
        let op = fetch(addr)?;
        let n8 = fetch(addr.wrapping_add(1)).unwrap_or(0);
        let hi = fetch(addr.wrapping_add(2)).unwrap_or(0);
        let op_len = lens()[op as usize];
        let n16 = u16::from_le_bytes([n8, hi]);
        let jr = addr.wrapping_add(2).wrapping_add(n8 as i8 as u16);
        let mut refs = vec![];
        let (mut ends, mut flow) = (false, false);
        let mut push = |kind, cond, to: u16| refs.push(Ref { kind, cond, bank: target_bank(bank, addr, to), to });
        match op {
            0xCD => { push(Kind::Call, false, n16); flow = true }
            0xC4 | 0xCC | 0xD4 | 0xDC => { push(Kind::Call, true, n16); flow = true }
            0xC3 => { push(Kind::Jp, false, n16); ends = true }
            // Conditional jumps and returns keep the tracked registers: the fall-through path
            // still holds them.
            0xC2 | 0xCA | 0xD2 | 0xDA => push(Kind::Jp, true, n16),
            0x18 => { push(Kind::Jr, false, jr); ends = true }
            0x20 | 0x28 | 0x30 | 0x38 => push(Kind::Jr, true, jr),
            _ if op & 0xC7 == 0xC7 => { push(Kind::Rst, false, (op & 0x38) as u16); flow = true }
            0xC9 | 0xD9 | 0xE9 => ends = true,
            0x01 | 0x11 | 0x21 | 0x31 | 0x08 | 0xEA | 0xFA => push(Kind::Ld, false, n16),
            0xE0 | 0xF0 => push(Kind::Ld, false, 0xFF00 | n8 as u16),
            _ if illegal(op) => ends = true,
            _ => {}
        }
        let mut extra = 0u16;
        if let Some(r) = refs.first().filter(|r| matches!(r.kind, Kind::Call | Kind::Rst)).cloned() {
            for (i, c) in view.convs.iter().enumerate() {
                let (vb, va) = c.via();
                if r.to != va || (banked(va) && r.bank != Some(vb)) {
                    continue;
                }
                let far = match c {
                    Conv::Inline { layout, bank, .. } => {
                        let mut part = [0u8; 4];
                        for (j, &what) in layout.iter().enumerate() {
                            part[what as usize] = fetch(addr.wrapping_add(op_len as u16 + j as u16)).unwrap_or(0);
                        }
                        extra = layout.len() as u16;
                        Some((bank.unwrap_or(part[0] as u16), u16::from_le_bytes([part[1], part[2]])))
                    }
                    Conv::Regs { bank_reg, addr_pair, bank, .. } => {
                        let (h, l) = (self.regs[addr_pair * 2], self.regs[addr_pair * 2 + 1]);
                        match (bank.or(self.regs[*bank_reg].map(u16::from)), h, l) {
                            (Some(b), Some(h), Some(l)) => Some((b, u16::from_le_bytes([l, h]))),
                            _ => None,
                        }
                    }
                };
                if let Some((b, to)) = far {
                    let bank = if banked(to) { Some(b) } else { Some(0) };
                    refs.push(Ref { kind: Kind::Far(i), cond: r.cond, bank, to });
                }
                break;
            }
        }
        self.track(op, n8, n16, flow || ends);
        Some(Insn { bank: if banked(addr) { bank } else { 0 }, addr, op_len, bytes: [op, n8, hi], len: op_len as u16 + extra, ends, refs })
    }

    /// Updates the known register immediates after `op` (B C D E H L - A = 0-7).
    fn track(&mut self, op: u8, n8: u8, n16: u16, flow: bool) {
        if flow {
            return self.reset();
        }
        let (x, y, z) = (op >> 6, ((op >> 3) & 7) as usize, op & 7);
        let (p, q) = (y >> 1, y & 1);
        let pair = |p: usize| if p < 3 { 3u8 << (2 * p) } else { 0 };
        let a = 1u8 << 7;
        match (x, z) {
            (0, 6) if y != 6 => return self.regs[y] = Some(n8),
            // ld r, r' copies what is known (regs[6], the [hl] slot, is never known).
            (1, _) if op != 0x76 && y != 6 => return self.regs[y] = self.regs[z as usize],
            _ if op == 0xAF => return self.regs[7] = Some(0), // xor a
            (0, 1) if q == 0 => {
                if p < 3 {
                    self.regs[2 * p] = Some((n16 >> 8) as u8);
                    self.regs[2 * p + 1] = Some(n16 as u8);
                }
                return;
            }
            _ => {}
        }
        let kill = match (x, z) {
            (2, _) if y != 7 => a,
            (0, 4) | (0, 5) if y != 6 => 1 << y,
            (0, 3) => pair(p),
            (0, 1) => pair(2),
            (0, 2) => (if q == 1 { a } else { 0 }) | (if p >= 2 { pair(2) } else { 0 }),
            (0, 7) if y < 6 => a,
            (3, 1) if q == 0 => if p == 3 { a } else { pair(p) },
            (3, 6) if y != 7 => a,
            (3, 3) if y == 1 => {
                let r = n8 & 7;
                if n8 >> 6 != 1 && r != 6 { 1 << r } else { 0 }
            }
            _ => match op {
                0xF0 | 0xF2 | 0xFA => a,
                0xF8 => pair(2),
                _ => 0,
            },
        };
        for r in 0..8 {
            if kill >> r & 1 == 1 {
                self.regs[r] = None;
            }
        }
    }
}

/// The bank of a reference from `bank:from` to `to`: bank 0 below $4000, the same bank for
/// banked code pointing into $4000-$7FFF, unknown (None) from bank 0 into $4000-$7FFF or for
/// $D000-$DFFF, and 0 for the rest of the address space.
pub fn target_bank(bank: u16, from: u16, to: u16) -> Option<u16> {
    match to {
        0..=0x3FFF => Some(0),
        0x4000..=0x7FFF => (0x4000..0x8000).contains(&from).then_some(bank),
        0xD000..=0xDFFF => None,
        _ => Some(0),
    }
}

/// The entries of a 16-bit pointer table at bank:addr: (entry address, target bank, target).
/// `fixed` is the bank of targets in $4000-$7FFF when they aren't in the table's bank.
pub fn table_entries(rom: &Rom, bank: u16, addr: u16, n: u32, fixed: Option<u16>) -> Vec<(u16, Option<u16>, u16)> {
    (0..n)
        .map_while(|i| {
            // Both bytes in the table's own ROM region.
            let end = addr as u32 + 2 * i + 1;
            if (end < 0x4000) != (addr < 0x4000) || end >= 0x8000 {
                return None;
            }
            let at = (end - 1) as u16;
            let to = u16::from_le_bytes([rom.byte(bank, at)?, rom.byte(bank, at + 1)?]);
            let b = match fixed {
                Some(f) if (0x4000..0x8000).contains(&to) => Some(f),
                _ => target_bank(bank, addr, to),
            };
            Some((at, b, to))
        })
        .collect()
}

/// Linear sweep of a whole bank. Skips the cartridge header and regions labelled data, ram,
/// jumptable or pointers (their size when known, else up to the next label), resyncs on a code
/// label that falls inside an instruction, and forgets tracked registers at every code label
/// (a label is where other paths may join).
pub fn sweep_bank(rom: &Rom, view: &View, bank: u16, mut f: impl FnMut(&Insn)) {
    if bank as usize * 0x4000 >= rom.data.len() {
        return;
    }
    let (start, end) = if bank == 0 { (0u32, 0x4000u32) } else { (0x4000, 0x8000) };
    let fetch = |a: u16| rom.byte(bank, a);
    let mut s = Sweeper::default();
    let mut a = start;
    while a < end {
        let a16 = a as u16;
        if bank == 0 && (0x104..0x150).contains(&a) {
            a = 0x150;
            s.reset();
            continue;
        }
        match view.labels.get(&(bank, a16)) {
            Some(l) if l.kind != "code" => {
                a = match l.size() {
                    // Sized: code resumes right after it, or at a code label inside it. A non-code
                    // label inside it is part of it, and extends it by its own size.
                    Some(n) => {
                        let mut e = a.saturating_add(n).min(end);
                        let mut x = a + 1;
                        loop {
                            match view.labels.range((bank, x as u16)..(bank, e as u16)).next() {
                                None => break e,
                                Some(((_, y), l)) if l.kind == "code" => break *y as u32,
                                Some(((_, y), l)) => {
                                    e = e.max((*y as u32).saturating_add(l.size().unwrap_or(0)).min(end));
                                    x = *y as u32 + 1;
                                }
                            }
                        }
                    }
                    None => view.labels.range((bank, a16 + 1)..(bank, end as u16)).next().map_or(end, |((_, x), _)| *x as u32),
                };
                s.reset();
                continue;
            }
            Some(_) => s.reset(),
            None => {}
        }
        let Some(i) = s.step(&fetch, view, bank, a16) else { break };
        let after = a16.saturating_add(i.len);
        if after > a16 + 1 {
            if let Some(((_, x), _)) = view.labels.range((bank, a16 + 1)..(bank, after)).find(|(_, l)| l.kind == "code") {
                a = *x as u32;
                s.reset();
                continue;
            }
        }
        if a + i.len as u32 > end {
            break;
        }
        f(&i);
        a += i.len as u32;
    }
}

pub struct Index {
    refs: Vec<(u16, u16, Ref)>,
    by_to: HashMap<u16, Vec<u32>>,
}

impl Index {
    fn build(rom: &Rom, view: &View) -> Index {
        let mut refs = vec![];
        for bank in 0..rom.banks() {
            sweep_bank(rom, view, bank, |i| refs.extend(i.refs.iter().map(|r| (i.bank, i.addr, r.clone()))));
        }
        for (&(b, a), l) in &view.labels {
            if let (Some((n, fixed)), true) = (l.table(), a < 0x8000) {
                for (at, tb, to) in table_entries(rom, b, a, n, fixed) {
                    refs.push((b, at, Ref { kind: Kind::Table, cond: false, bank: tb, to }));
                }
            }
        }
        let mut by_to: HashMap<u16, Vec<u32>> = HashMap::new();
        for (n, (_, _, r)) in refs.iter().enumerate() {
            by_to.entry(r.to).or_default().push(n as u32);
        }
        Index { refs, by_to }
    }
}

pub fn fmt_ref(view: &View, bank: Option<u16>, to: u16) -> String {
    match bank {
        Some(b) => view.fmt_exact(b, to),
        None => format!("??:{to:04X}"),
    }
}

// ---------- tools ----------

/// Disassembles `count` instructions (or up to the first unconditional return/jump).
pub fn disasm(fetch: &dyn Fn(u16) -> Option<u8>, view: &View, bank: u16, start: u16, count: u32, until_ret: bool) -> Vec<String> {
    let mut s = Sweeper::default();
    let mut lines = vec![];
    let mut a = start;
    for _ in 0..count {
        if (0x104..0x150).contains(&a) {
            lines.push(format!("00:{a:04X}  (cartridge header to $014F: see rom_open)"));
            a = 0x150;
            s.reset();
            continue;
        }
        let here = if banked(a) { bank } else { 0 };
        if a != start && view.labels.get(&(here, a)).is_some_and(|l| l.kind == "code") {
            s.reset();
        }
        let Some(i) = s.step(fetch, view, bank, a) else { break };
        if let Some(n) = view.exact(i.bank, a) {
            lines.push(format!("{n}:"));
        }
        let raw: Vec<u8> = (0..i.len).filter_map(|k| fetch(a.wrapping_add(k))).collect();
        let mut line = format!("{:02X}:{a:04X}  {:<10} {}", i.bank, hex(&raw).replace(' ', ""), i.text(view));
        for r in i.refs.iter().filter(|r| matches!(r.kind, Kind::Far(_))) {
            line += &format!("  ; {} -> {}", r.kind.label(view), fmt_ref(view, r.bank, r.to));
        }
        if let Some(c) = view.comments.get(&(i.bank, a)) {
            line += &format!("  ; {c}");
        }
        lines.push(line);
        let next = a as u32 + i.len as u32;
        if (until_ret && i.ends) || next > 0xFFFF || (a < 0x8000 && (a < 0x4000) != (next < 0x4000)) || (a < 0x8000 && next >= 0x8000) {
            break;
        }
        a = next as u16;
    }
    lines
}

pub fn xrefs(rom: &mut Rom, view: &View, bank: u16, addr: u16, kinds: &[String], limit: usize) -> Value {
    rom.index(view);
    let rom = &*rom;
    let idx = &rom.index.as_ref().unwrap().1;
    let mut out = vec![];
    let mut total = 0;
    let mut ambiguous = false;
    for &n in idx.by_to.get(&addr).map(Vec::as_slice).unwrap_or(&[]) {
        let (fb, fa, r) = &idx.refs[n as usize];
        let kind = r.kind.label(view);
        if r.bank.is_some_and(|b| b != bank) || (!kinds.is_empty() && !kinds.iter().any(|k| kind.starts_with(k.as_str()))) {
            continue;
        }
        total += 1;
        if out.len() < limit {
            let mut e = json!({"from": view.fmt(*fb, *fa), "kind": kind});
            if r.kind != Kind::Table {
                let fetch = |x: u16| rom.byte(*fb, x);
                if let Some(i) = Sweeper::default().step(&fetch, view, *fb, *fa) {
                    e["insn"] = json!(i.text(view));
                }
            }
            if r.cond {
                e["cond"] = json!(true);
            }
            if r.bank.is_none() {
                e["ambiguous_bank"] = json!(true);
                ambiguous = true;
            }
            out.push(e);
        }
    }
    let mut v = json!({"target": view.fmt_exact(bank, addr), "count": total, "refs": out, "truncated": total > limit});
    if ambiguous {
        v["note"] = json!("ambiguous_bank: code outside the target's bank points at its address; the bank it maps at run time is unknown statically");
    }
    v
}

/// Parses "3E ?? CD" / "3E??CD" into byte-or-wildcard tokens.
pub fn pattern(p: &str) -> R<Vec<Option<u8>>> {
    let h: String = p.chars().filter(|c| !c.is_whitespace()).collect();
    if h.is_empty() || !h.len().is_multiple_of(2) {
        return Err(format!("bad pattern {p:?}: hex byte pairs, ?? for any byte"));
    }
    (0..h.len())
        .step_by(2)
        .map(|i| match &h[i..i + 2] {
            "??" => Ok(None),
            b => u8::from_str_radix(b, 16).map(Some).map_err(|_| format!("bad pattern byte {b:?}")),
        })
        .collect()
}

pub fn loc_of_offset(off: usize) -> (u16, u16) {
    let bank = (off / 0x4000) as u16;
    (bank, if bank == 0 { off as u16 } else { 0x4000 + (off % 0x4000) as u16 })
}

pub fn find_bytes(rom: &Rom, view: &View, pat: &[Option<u8>], banks: (u16, u16), limit: usize) -> Value {
    let lo = banks.0 as usize * 0x4000;
    let hi = ((banks.1 as usize + 1) * 0x4000).min(rom.data.len());
    let mut hits = vec![];
    let mut total = 0;
    if lo < hi && hi - lo >= pat.len() {
        for off in lo..=hi - pat.len() {
            if pat.iter().enumerate().all(|(i, b)| b.is_none_or(|b| rom.data[off + i] == b)) {
                total += 1;
                if hits.len() < limit {
                    let (b, a) = loc_of_offset(off);
                    hits.push(json!(view.fmt(b, a)));
                }
            }
        }
    }
    json!({"count": total, "hits": hits, "truncated": total > limit})
}

/// Instructions whose immediate (n8 for 2-byte, n16 for 3-byte; never a JR offset) equals
/// `value`, optionally only those whose text starts with `mnemonic` (spaces ignored, so
/// "cp" or "ld a" match "CP A, $05" / "LD A, $05").
pub fn find_immediate(rom: &Rom, view: &View, value: u16, mnemonic: Option<&str>, banks: (u16, u16), limit: usize) -> Value {
    let norm = |s: &str| s.chars().filter(|c| !c.is_whitespace()).collect::<String>().to_ascii_uppercase();
    let want = mnemonic.map(norm);
    let mut hits = vec![];
    let mut total = 0;
    for bank in banks.0..=banks.1.min(rom.banks().saturating_sub(1)) {
        sweep_bank(rom, view, bank, |i| {
            let imm = match i.op_len {
                2 if !matches!(i.op(), 0xCB | 0x18 | 0x20 | 0x28 | 0x30 | 0x38) => i.bytes[1] as u16,
                3 => u16::from_le_bytes([i.bytes[1], i.bytes[2]]),
                _ => return,
            };
            if imm != value {
                return;
            }
            let raw = disassemble_bytes(i.addr, i.bytes).0;
            if want.as_ref().is_some_and(|w| !norm(&raw).starts_with(w.as_str())) {
                return;
            }
            total += 1;
            if hits.len() < limit {
                hits.push(json!({"at": view.fmt(i.bank, i.addr), "insn": i.text(view)}));
            }
        });
    }
    json!({"count": total, "hits": hits, "truncated": total > limit})
}

pub struct Func {
    pub entry: (u16, u16),
    pub insns: BTreeMap<u16, u16>,
    /// (kind, cond, target bank, target, call site)
    pub callees: Vec<(Kind, Option<u16>, u16, u16)>,
    pub exits: Vec<u16>,
    pub jump_tables: Vec<u16>,
    /// Paths that ran into an illegal opcode (probably data, or a wrong entry point).
    pub illegal: Vec<u16>,
    pub truncated: bool,
}

/// Explores a function from its entry, following JR and local JP branches (forward, within
/// $1000 bytes, not onto another code label); ends paths at RET/RETI/JP HL/unconditional jumps.
pub fn function(rom: &Rom, view: &View, bank: u16, entry: u16) -> Func {
    let fetch = |a: u16| rom.byte(bank, a);
    let region = |a: u16| a >> 14;
    let local = |t: u16| region(t) == region(entry) && t >= entry && t - entry < 0x1000 && (t == entry || view.exact(bank, t).is_none());
    let mut f = Func { entry: (if entry < 0x4000 { 0 } else { bank }, entry), insns: BTreeMap::new(), callees: vec![], exits: vec![], jump_tables: vec![], illegal: vec![], truncated: false };
    let mut queue = VecDeque::from([entry]);
    let mut seen_callee = BTreeSet::new();
    while let Some(mut a) = queue.pop_front() {
        let mut s = Sweeper::default();
        while !f.insns.contains_key(&a) {
            if f.insns.len() >= 4000 {
                f.truncated = true;
                break;
            }
            let Some(i) = s.step(&fetch, view, bank, a) else { break };
            f.insns.insert(a, i.len);
            let far = i.refs.iter().any(|r| matches!(r.kind, Kind::Far(_)));
            let mut refs = i.refs.clone();
            // `ld rr, Table` of a declared jumptable: its entries are callees of this function.
            for r in i.refs.iter().filter(|r| r.kind == Kind::Ld && matches!(i.bytes[0], 0x01 | 0x11 | 0x21)) {
                let Some(tb) = r.bank else { continue };
                if let Some((n, fixed)) = view.labels.get(&(tb, r.to)).filter(|l| l.kind == "jumptable").and_then(|l| l.table()) {
                    refs.extend(table_entries(rom, tb, r.to, n, fixed).into_iter().map(|(_, b, to)| Ref { kind: Kind::Table, cond: false, bank: b, to }));
                }
            }
            for r in &refs {
                let callee = match r.kind {
                    Kind::Call | Kind::Rst => !far,
                    Kind::Far(_) | Kind::Table => true,
                    Kind::Jr | Kind::Jp if local(r.to) => {
                        queue.push_back(r.to);
                        false
                    }
                    Kind::Jr | Kind::Jp => true,
                    Kind::Ld => false,
                };
                if callee && seen_callee.insert((r.bank, r.to)) {
                    f.callees.push((r.kind, r.bank, r.to, a));
                }
            }
            match i.op() {
                0xE9 => f.jump_tables.push(a),
                0xC9 | 0xD9 => f.exits.push(a),
                op if illegal(op) => f.illegal.push(a),
                _ => {}
            }
            let next = a as u32 + i.len as u32;
            if i.ends || region(a) != region(next.min(0xFFFF) as u16) || next > 0x7FFF {
                break;
            }
            a = next as u16;
        }
    }
    f
}

pub fn function_json(view: &View, f: &Func) -> Value {
    let (b, e) = f.entry;
    let end = f.insns.iter().map(|(a, l)| *a as u32 + *l as u32).max().unwrap_or(e as u32);
    let size: u32 = f.insns.values().map(|&l| l as u32).sum();
    json!({
        "entry": view.fmt_exact(b, e), "end": format!("{b:02X}:{:04X}", end.min(0xFFFF)), "bytes": size,
        "instructions": f.insns.len(),
        "callees": f.callees.iter().map(|(k, cb, t, at)| json!({"to": fmt_ref(view, *cb, *t), "kind": k.label(view), "at": view.fmt(b, *at)})).collect::<Vec<_>>(),
        "exits": f.exits.iter().map(|a| view.fmt(b, *a)).collect::<Vec<_>>(),
        "jump_tables": f.jump_tables.iter().map(|a| view.fmt(b, *a)).collect::<Vec<_>>(),
        "illegal_opcodes": f.illegal.iter().map(|a| view.fmt(b, *a)).collect::<Vec<_>>(),
        "truncated": f.truncated,
    })
}

pub fn callgraph(rom: &Rom, view: &View, bank: u16, entry: u16, depth: u32) -> Value {
    let mut nodes = vec![];
    let mut seen = BTreeSet::from([(bank, entry)]);
    let mut queue = VecDeque::from([(bank, entry, 0u32)]);
    let mut unresolved = 0;
    let mut truncated = false;
    while let Some((b, a, d)) = queue.pop_front() {
        if nodes.len() >= 300 {
            truncated = true;
            break;
        }
        let f = function(rom, view, b, a);
        let mut callees = vec![];
        for (k, cb, t, _) in &f.callees {
            callees.push(json!(format!("{} ({})", fmt_ref(view, *cb, *t), k.label(view))));
            match cb {
                Some(cb) if *t < 0x8000 => {
                    if d + 1 < depth && seen.insert((*cb, *t)) {
                        queue.push_back((*cb, *t, d + 1));
                    }
                }
                Some(_) => {}
                None => unresolved += 1,
            }
        }
        nodes.push(json!({"fn": view.fmt_exact(f.entry.0, a), "depth": d, "callees": callees}));
    }
    json!({"root": view.fmt_exact(if entry < 0x4000 { 0 } else { bank }, entry), "nodes": nodes, "unresolved_bank_callees": unresolved, "truncated": truncated})
}

// ---------- text ----------

/// A `.tbl` charmap: "HH=text" or "HHHH=text" lines (a leading '/' or '*' marker is accepted;
/// lines starting with '#' or ';' are comments).
pub struct Charmap {
    map: HashMap<Vec<u8>, String>,
    max: usize,
}

impl Charmap {
    pub fn parse(text: &str) -> R<Charmap> {
        let mut map = HashMap::new();
        for (n, line) in text.lines().enumerate() {
            let line = line.trim_end_matches(['\r', '\n']);
            if line.trim().is_empty() || line.starts_with('#') || line.starts_with(';') {
                continue;
            }
            let line = line.trim_start_matches(['/', '*']);
            let (k, v) = line.split_once('=').ok_or(format!("charmap line {}: want HH=text", n + 1))?;
            let k = crate::bytes(&Value::String(k.trim().into())).map_err(|e| format!("charmap line {}: {e}", n + 1))?;
            if !k.is_empty() {
                map.insert(k, v.to_string());
            }
        }
        let max = map.keys().map(Vec::len).max().unwrap_or(1);
        Ok(Charmap { map, max })
    }

    pub fn len(&self) -> usize {
        self.map.len()
    }

    pub fn is_empty(&self) -> bool {
        self.map.is_empty()
    }

    pub fn load(path: &str) -> R<Charmap> {
        let raw = std::fs::read(path).map_err(|e| format!("charmap {path}: {e}"))?;
        Charmap::parse(&String::from_utf8_lossy(&raw))
    }

    /// Decodes up to `len` bytes, stopping after a `terminator` byte (not included in the text).
    pub fn decode(&self, fetch: &dyn Fn(u16) -> Option<u8>, start: u16, len: usize, terminator: Option<u8>) -> (String, Vec<u8>) {
        let mut text = String::new();
        let mut raw = vec![];
        let mut a = start;
        while raw.len() < len {
            let Some(b) = fetch(a) else { break };
            if Some(b) == terminator {
                raw.push(b);
                break;
            }
            let window: Vec<u8> = (0..self.max.min(len - raw.len())).map_while(|i| fetch(a.wrapping_add(i as u16))).collect();
            let hit = (1..=window.len()).rev().find_map(|n| self.map.get(&window[..n]).map(|s| (n, s)));
            let n = match hit {
                Some((n, s)) => {
                    text += s;
                    n
                }
                None => {
                    text += &format!("[{b:02X}]");
                    1
                }
            };
            raw.extend_from_slice(&window[..n.min(window.len()).max(1)]);
            a = a.wrapping_add(n as u16);
        }
        (text, raw)
    }
}
