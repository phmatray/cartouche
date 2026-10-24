//! gb-mcp: a Model Context Protocol server (stdio, newline-delimited JSON-RPC 2.0) that gives
//! AI agents stateful reverse-engineering and debugging of Game Boy / Game Boy Color ROMs on
//! top of gb-core. The ROM, one emulator session, save-state slots, breakpoints and the
//! shared knowledge DB stay in memory between calls. See README.md for every tool.
//!
//! Value rules: a JSON number is decimal; a string is hex (optional `0x` / `$`); a location
//! is a label name, "BB:AAAA" (bank:addr, hex) or a plain address.

pub mod db;
pub mod emu;
pub mod rom;

use std::io::{BufRead, Write};
use std::panic::{catch_unwind, AssertUnwindSafe};
use std::path::Path;
use std::sync::OnceLock;

use serde_json::{json, Value};

use db::{banked, key, Db, FarCall, Label, View};
use emu::{machine, Emu};
use rom::{Charmap, Rom};

pub type R<T> = Result<T, String>;
pub const PROTOCOL_VERSION: &str = "2025-06-18";

// ---------- value helpers ----------

/// JSON number (decimal) or string (hex, optional 0x/$).
pub fn num(v: &Value) -> R<u32> {
    match v {
        Value::Number(n) => n.as_u64().filter(|&n| n <= u32::MAX as u64).map(|n| n as u32).ok_or(format!("bad number {v}")),
        Value::String(s) => {
            let t = s.trim();
            let t = t.strip_prefix("0x").or_else(|| t.strip_prefix("0X")).or_else(|| t.strip_prefix('$')).unwrap_or(t);
            u32::from_str_radix(t, 16).map_err(|_| format!("bad hex {s:?}"))
        }
        Value::Bool(b) => Ok(*b as u32),
        _ => Err(format!("expected a number, got {v}")),
    }
}

/// "01 02 ff" / "0102ff" / "0x11" / "$11, $22" / [1, 2, "ff"]. A token with a 0x or $ prefix is
/// one byte; any other token is hex byte pairs.
pub fn bytes(v: &Value) -> R<Vec<u8>> {
    match v {
        Value::String(s) => {
            let bad = || format!("bad hex bytes {s:?}: \"01 02 FF\", \"0102FF\" or \"$01, 0x02\"");
            let mut out = vec![];
            for t in s.split(|c: char| c.is_whitespace() || c == ',').filter(|t| !t.is_empty()) {
                match t.strip_prefix("0x").or_else(|| t.strip_prefix("0X")).or_else(|| t.strip_prefix('$')) {
                    Some(h) if (1..=2).contains(&h.len()) => out.push(u8::from_str_radix(h, 16).map_err(|_| bad())?),
                    Some(_) => return Err(bad()),
                    None if t.len().is_multiple_of(2) && t.is_ascii() => {
                        for i in (0..t.len()).step_by(2) {
                            out.push(u8::from_str_radix(&t[i..i + 2], 16).map_err(|_| bad())?);
                        }
                    }
                    None => return Err(bad()),
                }
            }
            Ok(out)
        }
        Value::Array(a) => a.iter().map(|x| num(x).map(|n| n as u8)).collect(),
        Value::Number(_) => Ok(vec![num(v)? as u8]),
        _ => Err(format!("expected bytes, got {v}")),
    }
}

pub fn opt_num(p: &Value, k: &str, d: u32) -> R<u32> {
    match p.get(k) {
        None | Some(Value::Null) => Ok(d),
        Some(v) => num(v).map_err(|e| format!("{k}: {e}")),
    }
}

/// An optional count that must not exceed `max`: refused rather than clamped, so the caller
/// knows to split the work.
pub fn capped(p: &Value, k: &str, d: u32, max: u32) -> R<u32> {
    let n = opt_num(p, k, d)?;
    if n > max {
        return Err(format!("{k}: at most {max} per call (the server answers one call at a time); split it into several calls"));
    }
    Ok(n)
}

pub fn arr<'a>(p: &'a Value, k: &str) -> &'a [Value] {
    p.get(k).and_then(Value::as_array).map(Vec::as_slice).unwrap_or(&[])
}

pub fn hex(b: &[u8]) -> String {
    b.iter().map(|x| format!("{x:02X}")).collect::<Vec<_>>().join(" ")
}

pub fn base64(data: &[u8]) -> String {
    const T: &[u8; 64] = b"ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/";
    let mut s = String::with_capacity(data.len().div_ceil(3) * 4);
    for c in data.chunks(3) {
        let n = (c[0] as u32) << 16 | (*c.get(1).unwrap_or(&0) as u32) << 8 | *c.get(2).unwrap_or(&0) as u32;
        for i in 0..4 {
            s.push(if i <= c.len() { T[(n >> (18 - 6 * i) & 63) as usize] as char } else { '=' });
        }
    }
    s
}

/// The enclosing git work tree of a path, if any: game-derived files never go in one.
pub fn inside_git_repo(path: &Path) -> Option<std::path::PathBuf> {
    let abs = if path.is_absolute() { path.to_path_buf() } else { std::env::current_dir().ok()?.join(path) };
    let existing = abs.ancestors().find(|a| a.exists())?.canonicalize().ok()?;
    existing.ancestors().find(|a| a.join(".git").exists()).map(Path::to_path_buf)
}

/// Bank range: absent = every bank; a number / "05" = one bank; "02-05" = an inclusive range
/// (its end is clipped to the last bank, its start must exist).
fn bank_range(v: Option<&Value>, banks: u16) -> R<(u16, u16)> {
    let last = banks.saturating_sub(1) as u32;
    let (a, b) = match v {
        None | Some(Value::Null) => return Ok((0, last as u16)),
        Some(Value::String(s)) if s.contains('-') => {
            let (a, b) = s.split_once('-').unwrap();
            (num(&json!(a))?, num(&json!(b))?.min(last))
        }
        Some(v) => (num(v)?, num(v)?),
    };
    if a > b || b > last {
        return Err(format!("banks: the ROM has banks 00-{last:02X}"));
    }
    Ok((a as u16, b as u16))
}

// ---------- server ----------

pub enum Out {
    Json(Value),
    /// An image, with an optional note shown next to it.
    Png(Vec<u8>, Option<&'static str>),
}

pub struct Server {
    pub db: Db,
    pub rom: Option<Rom>,
    pub emu: Emu,
}

/// A location argument with its bank resolved: given, else the live mapping, else bank 1.
fn resolve(view: &View, emu: &Emu, v: &Value) -> R<(u16, u16)> {
    let (b, a) = view.loc(v)?;
    Ok((b.unwrap_or_else(|| emu.gb.as_ref().map_or(1, |g| emu::here(g, a))), a))
}

/// A location that names a bank whenever the region is banked (for the knowledge DB).
fn db_loc(view: &View, v: &Value) -> R<(u16, u16)> {
    match view.loc(v)? {
        (Some(b), a) => Ok((b, a)),
        (None, a) => Err(format!("{v}: ${a:04X} is banked; give the bank as \"BB:{a:04X}\"")),
    }
}

/// "tool needs \"k\"", naming the arguments the tool doesn't take (a misspelt key, usually).
fn missing(name: &str, k: &str, a: &Value) -> String {
    let props = tools().iter().find(|t| t["name"] == name).and_then(|t| t["inputSchema"]["properties"].as_object());
    let unknown: Vec<&str> = a.as_object().map_or(vec![], |m| m.keys().map(String::as_str).filter(|x| props.is_some_and(|p| !p.contains_key(*x))).collect());
    if unknown.is_empty() {
        format!("{name} needs \"{k}\"")
    } else {
        format!("{name} needs \"{k}\" (it doesn't take {})", unknown.iter().map(|x| format!("\"{x}\"")).collect::<Vec<_>>().join(", "))
    }
}

/// An existing comment followed by a new one (append mode).
fn joined(old: Option<&String>, new: String) -> String {
    match old {
        Some(o) if !o.is_empty() && *o != new => format!("{o} | {new}"),
        _ => new,
    }
}

fn label_name(n: &str) -> R<String> {
    let n = n.trim();
    if n.is_empty() || n.chars().any(|c| c.is_whitespace() || c == ':' || c == '"') {
        return Err(format!("label {n:?}: no spaces, ':' or quotes"));
    }
    // A location argument looks names up first: a hex-looking name would hide that address.
    if num(&json!(n)).is_ok() {
        return Err(format!("label {n:?} reads as a hex address; pick a name that isn't hex"));
    }
    Ok(n.into())
}

impl Server {
    pub fn new(db: Db) -> Server {
        Server { db, rom: None, emu: Emu::default() }
    }

    /// Handles one JSON-RPC message; `None` for notifications and stray responses.
    pub fn handle(&mut self, msg: &Value) -> Option<Value> {
        let Some(method) = msg.get("method").and_then(Value::as_str) else {
            let stray = msg.get("result").is_some() || msg.get("error").is_some();
            return (!stray).then(|| rpc_error(msg.get("id").cloned().unwrap_or(Value::Null), -32600, "Invalid Request"));
        };
        let id = msg.get("id").cloned()?; // a notification (initialized, cancelled, ...): nothing to answer
        let params = msg.get("params").cloned().unwrap_or(json!({}));
        let r = match method {
            "initialize" => Ok(json!({
                "protocolVersion": PROTOCOL_VERSION,
                "capabilities": {"tools": {"listChanged": false}},
                "serverInfo": {"name": "gb-mcp", "version": env!("CARGO_PKG_VERSION")},
                "instructions": instructions(),
            })),
            "ping" => Ok(json!({})),
            "tools/list" => Ok(json!({"tools": tools()})),
            "tools/call" => self.tools_call(&params),
            _ => Err((-32601, format!("Method not found: {method}"))),
        };
        Some(match r {
            Ok(v) => json!({"jsonrpc": "2.0", "id": id, "result": v}),
            Err((c, m)) => rpc_error(id, c, &m),
        })
    }

    fn tools_call(&mut self, p: &Value) -> Result<Value, (i64, String)> {
        let name = p.get("name").and_then(Value::as_str).ok_or((-32602, "tools/call needs \"name\"".to_string()))?;
        if !tools().iter().any(|t| t["name"] == name) {
            return Err((-32602, format!("Unknown tool: {name}")));
        }
        let args = p.get("arguments").cloned().filter(Value::is_object).unwrap_or(json!({}));
        let r = catch_unwind(AssertUnwindSafe(|| self.call_tool(name, &args)))
            .unwrap_or_else(|e| Err(format!("internal error: {}", e.downcast_ref::<&str>().copied().or(e.downcast_ref::<String>().map(String::as_str)).unwrap_or("panic"))));
        Ok(match r {
            Ok(Out::Json(v)) => json!({"content": [{"type": "text", "text": v.to_string()}], "isError": false}),
            Ok(Out::Png(png, note)) => {
                let mut c = vec![json!({"type": "image", "data": base64(&png), "mimeType": "image/png"})];
                c.extend(note.map(|n| json!({"type": "text", "text": n})));
                json!({"content": c, "isError": false})
            }
            Err(e) => json!({"content": [{"type": "text", "text": e}], "isError": true}),
        })
    }

    /// Runs one tool; errors become `isError` tool results.
    pub fn call_tool(&mut self, name: &str, a: &Value) -> R<Out> {
        self.db.refresh()?;
        let Server { db, rom, emu } = self;
        let summary = |r: &Rom, db: &Db| {
            let mut h = r.header();
            let k = db.knowledge(&r.sha1);
            h["knowledge"] = json!({"db": db.path(), "labels": k.labels.len(), "comments": k.comments.len(),
                                    "far_calls": k.far_calls.len(), "charmap": k.charmap});
            h
        };
        if name == "rom_open" {
            let path = a.get("path").and_then(Value::as_str).ok_or("rom_open needs \"path\"")?;
            let r = Rom::open(path)?;
            // The same ROM again leaves the session alone, unless asked to reset it.
            let keep = rom.as_ref().is_some_and(|o| o.sha1 == r.sha1) && a.get("reset").and_then(Value::as_bool) != Some(true);
            let mut h = summary(&r, db);
            h["session"] = json!(if keep { "kept" } else { "reset" });
            if keep {
                rom.as_mut().unwrap().path = r.path;
            } else {
                *rom = Some(r);
                *emu = Emu::default();
            }
            return Ok(Out::Json(h));
        }
        if name == "rom_info" {
            let Some(r) = rom.as_ref() else { return Ok(Out::Json(json!({"open": false, "db": db.path()}))) };
            let mut h = summary(r, db);
            h["open"] = json!(true);
            let view = View::new(&db.knowledge(&r.sha1));
            h["session"] = match &emu.gb {
                None => json!({"powered": false, "slots": emu.slots.keys().collect::<Vec<_>>()}),
                Some(gb) => json!({
                    "powered": true, "frames": emu.frames, "pc": emu::fmt(gb, &view, gb.cpu.regs.pc),
                    "rom_bank": format!("{:02X}", emu::rom_bank(gb)), "slots": emu.slots.keys().collect::<Vec<_>>(),
                    "breakpoints": emu.bps.len(), "watchpoints": emu.wps.len(), "call_stopped": emu.pending_call.is_some(),
                }),
            };
            return Ok(Out::Json(h));
        }
        if name == "db_dump" && a.get("all").and_then(Value::as_bool) == Some(true) {
            return Ok(Out::Json(json!({"db": db.path(), "file": db.file()})));
        }
        let rom = rom.as_mut().ok_or("no ROM open: call rom_open first")?;
        let sha = rom.sha1.clone();
        let mut view = View::new(&db.knowledge(&sha));
        view.rom_banks = rom.banks();
        view.ends = rom.ends(&view).clone();
        let v = |k: &str| a.get(k).ok_or_else(|| missing(name, k, a));
        let s = |k: &str| a.get(k).and_then(Value::as_str);
        let limit = |d: u32| opt_num(a, "limit", d).map(|n| n.clamp(1, 100_000) as usize);
        let j = match name {
            // ---- static analysis ----
            "disasm" => {
                let until = a.get("until_ret").and_then(Value::as_bool).unwrap_or(false);
                let count = opt_num(a, "count", if until { 1000 } else { 32 })?.min(5000);
                let mut one = |at: &Value| -> R<Value> {
                    let (b, addr) = resolve(&view, emu, at)?;
                    Ok(if addr < 0x8000 {
                        json!(rom::disasm(&|x| rom.byte(b, x), &view, b, addr, count, until))
                    } else {
                        let gb = machine(&mut emu.gb, rom)?;
                        let l = banked(addr).then_some(b); // "BB:Dxxx": that WRAM bank, not the mapped one
                        json!(rom::disasm(&|x| Some(emu::read_loc(gb, rom, (l, x), 1)[0]), &view, b, addr, count, until))
                    })
                };
                match a.get("addrs").and_then(Value::as_array) {
                    Some(list) if list.len() > 64 => return Err("addrs: at most 64 per call".into()),
                    Some(list) => json!(list.iter().map(|x| Ok(json!({"addr": x, "lines": one(x)?}))).collect::<R<Vec<_>>>()?),
                    None => one(v("addr")?)?,
                }
            }
            "xrefs" => {
                // "addr", as every other tool calls a location, works too.
                let (b, addr) = resolve(&view, emu, a.get("target").or(a.get("addr")).ok_or_else(|| missing(name, "target", a))?)?;
                let kinds: Vec<String> = match a.get("kind") {
                    Some(Value::String(k)) => vec![k.to_ascii_lowercase()],
                    Some(Value::Array(ks)) => ks.iter().filter_map(Value::as_str).map(str::to_ascii_lowercase).collect(),
                    _ => vec![],
                };
                let flag = |k: &str| a.get(k).and_then(Value::as_bool) == Some(true);
                let opts = rom::XrefOpts {
                    reached_only: flag("reached_only"),
                    words: flag("words").then(|| bank_range(a.get("banks"), rom.banks())).transpose()?,
                };
                rom::xrefs(rom, &view, if addr < 0x4000 || (!banked(addr)) { 0 } else { b }, addr, &kinds, limit(200)?, &opts)
            }
            "find_bytes" => {
                let pat = rom::pattern(s("pattern").ok_or("find_bytes needs \"pattern\"")?)?;
                let banks = bank_range(a.get("banks"), rom.banks())?;
                rom::find_bytes(rom, &view, &pat, banks, limit(100)?, a.get("insn_start").and_then(Value::as_bool) == Some(true))
            }
            "records" => {
                let (b, addr) = resolve(&view, emu, v("addr")?)?;
                if addr >= 0x8000 {
                    return Err("records reads ROM data ($0000-$7FFF)".into());
                }
                let fields: Vec<String> = arr(a, "fields").iter().filter_map(Value::as_str).map(str::to_ascii_lowercase).collect();
                let term = a.get("terminator").filter(|t| !t.is_null()).map(|t| num(t).map(|n| n as u8)).transpose()?;
                let fixed = a.get("target_bank").filter(|x| !x.is_null()).map(|x| num(x).map(|n| n as u16)).transpose()?;
                rom::records(rom, &view, if addr < 0x4000 { 0 } else { b }, addr, &fields, term, opt_num(a, "count", 256)?.min(4096), fixed)?
            }
            "find_immediate" => {
                let value = num(v("value")?)?;
                if value > 0xFFFF {
                    return Err("value: at most $FFFF".into());
                }
                rom::find_immediate(rom, &view, value as u16, s("mnemonic"), bank_range(a.get("banks"), rom.banks())?, limit(100)?)
            }
            "function_bounds" => {
                let (b, addr) = resolve(&view, emu, v("addr")?)?;
                if addr >= 0x8000 {
                    return Err("function_bounds works on ROM code ($0000-$7FFF)".into());
                }
                rom::function_json(&view, &rom::function(rom, &view, b, addr))
            }
            "table_entries" => {
                let (b, addr) = resolve(&view, emu, v("addr")?)?;
                if addr >= 0x8000 {
                    return Err("table_entries reads ROM tables ($0000-$7FFF)".into());
                }
                let b = if addr < 0x4000 { 0 } else { b };
                let declared = view.labels.get(&(b, addr)).and_then(Label::table);
                let n = match a.get("entries") {
                    Some(x) if !x.is_null() => num(x)?,
                    _ => declared.ok_or("not a declared jumptable/pointers label: pass \"entries\"")?.0,
                }
                .min(0x2000);
                let fixed = match a.get("target_bank") {
                    Some(x) if !x.is_null() => Some(num(x).ok().filter(|&tb| tb < rom.banks() as u32).ok_or(format!("target_bank {x} (the ROM has {:X} banks)", rom.banks()))? as u16),
                    _ => declared.and_then(|d| d.1),
                };
                let list: Vec<Value> = rom::table_entries(rom, b, addr, n, fixed)
                    .into_iter()
                    .map(|(at, tb, to)| json!({"at": view.fmt(b, at), "to": match tb { Some(tb) => view.fmt(tb, to), None => format!("??:{to:04X}") }}))
                    .collect();
                json!({"table": view.fmt_exact(b, addr), "entries": list})
            }
            "callgraph" => {
                let (b, addr) = resolve(&view, emu, v("addr")?)?;
                if addr >= 0x8000 {
                    return Err("callgraph works on ROM code ($0000-$7FFF)".into());
                }
                rom::callgraph(rom, &view, b, addr, opt_num(a, "depth", 2)?.clamp(1, 8))
            }
            "text_decode" => {
                let path = s("charmap").map(String::from).or(view.charmap.clone()).ok_or("no charmap: pass \"charmap\" or set one with charmap_set")?;
                let cm = Charmap::load(&path)?;
                let (b, addr) = resolve(&view, emu, v("addr")?)?;
                let term = match a.get("terminator") {
                    Some(t) if !t.is_null() => Some(num(t)? as u8),
                    _ => None,
                };
                let len = opt_num(a, "len", if term.is_some() { 1024 } else { 256 })?.min(0x4000) as usize;
                let (text, raw) = if addr < 0x8000 {
                    cm.decode(&|x| rom.byte(b, x), addr, len, term)
                } else {
                    let gb = machine(&mut emu.gb, rom)?;
                    let l = banked(addr).then_some(b);
                    cm.decode(&|x| Some(emu::read_loc(gb, rom, (l, x), 1)[0]), addr, len, term)
                };
                json!({"addr": view.fmt(b, addr), "text": text, "bytes": raw.len(), "hex": hex(&raw)})
            }
            // ---- knowledge DB ----
            "label_set" => {
                let items: Vec<Value> = match a.get("labels") {
                    Some(Value::Array(l)) => l.clone(),
                    _ => vec![a.clone()],
                };
                let mut parsed = vec![];
                let mut warnings = vec![];
                let mut code = std::collections::BTreeMap::new(); // bank -> code labels to check
                let append_all = a.get("append").and_then(Value::as_bool) == Some(true);
                for it in &items {
                    let (b, addr) = db_loc(&view, it.get("addr").ok_or("label_set needs \"addr\" (or \"labels\": [...])")?)?;
                    let name = label_name(it.get("name").and_then(Value::as_str).ok_or("label_set needs \"name\"")?)?;
                    let kind = it.get("kind").and_then(Value::as_str).unwrap_or(if addr < 0x8000 { "code" } else { "ram" });
                    if !["code", "data", "ram", "jumptable", "pointers"].contains(&kind) {
                        return Err(format!("kind {kind:?}: code|data|ram|jumptable|pointers"));
                    }
                    let field = |k: &str| it.get(k).filter(|x| !x.is_null()).map(|x| num(x).map_err(|e| format!("{k}: {e}"))).transpose();
                    let (size, entries, target_bank) = (field("size")?, field("entries")?, field("target_bank")?);
                    let table = matches!(kind, "jumptable" | "pointers");
                    if size.is_some_and(|n| n == 0 || addr as u32 + n > 0x10000) {
                        return Err(format!("size: 1 to ${:X} bytes from ${addr:04X}", 0x10000 - addr as u32));
                    }
                    if table && (addr >= 0x8000 || !entries.is_some_and(|n| (1..=0x2000).contains(&n))) {
                        return Err(format!("kind {kind}: a ROM table ($0000-$7FFF) with \"entries\" (1-8192 16-bit pointers)"));
                    }
                    if !table && (entries.is_some() || target_bank.is_some()) {
                        return Err("entries / target_bank: only for kind jumptable or pointers".into());
                    }
                    if target_bank.is_some_and(|tb| tb >= rom.banks() as u32) {
                        return Err(format!("target_bank: the ROM has banks 00-{:02X}", rom.banks() - 1));
                    }
                    let comment = it.get("comment").and_then(Value::as_str).map(String::from);
                    let append = append_all || it.get("append").and_then(Value::as_bool) == Some(true);
                    if kind == "code" && addr < 0x8000 {
                        code.entry(b).or_insert_with(std::collections::BTreeSet::new).insert(addr);
                    }
                    let label = Label {
                        name, kind: kind.into(), size: size.map(|n| json!(n)), entries: entries.map(|n| json!(n)),
                        target_bank: target_bank.map(|b| json!(format!("{b:02X}"))), ..Label::default()
                    };
                    parsed.push((key(b, addr), label, comment, append));
                }
                // A code label inside an instruction of the linear sweep: probably a wrong entry.
                for (b, addrs) in &code {
                    for (addr, at) in rom::inside(rom, &view, *b, addrs) {
                        let fetch = |x: u16| rom.byte(*b, x);
                        let insn = rom::Sweeper::default().step(&fetch, &view, *b, at).map(|i| i.text(&view)).unwrap_or_default();
                        warnings.push(format!("{} is inside the instruction {insn} at {} of the linear sweep: check the entry point (disasm and xrefs restart decoding at a label)",
                                              key(*b, addr), view.fmt(*b, at)));
                    }
                }
                let (moved, replaced) = db.update(&sha, |k| {
                    let (mut moved, mut replaced) = (vec![], vec![]);
                    for (key, label, comment, append) in parsed {
                        let old: Vec<String> = k.labels.iter().filter(|(kk, l)| l.name == label.name && **kk != key).map(|(kk, _)| kk.clone()).collect();
                        for o in old {
                            k.labels.remove(&o);
                            moved.push(json!({"name": label.name, "from": o}));
                        }
                        let mut r = json!({});
                        if let Some(c) = comment {
                            let c = if append { joined(k.comments.get(&key), c) } else { c };
                            if let Some(o) = k.comments.insert(key.clone(), c.clone()).filter(|o| *o != c && !append) {
                                r["comment"] = json!(o);
                            }
                        }
                        if let Some(o) = k.labels.get(&key).filter(|o| o.name != label.name) {
                            r["name"] = json!(o.name);
                        }
                        if r != json!({}) {
                            r["addr"] = json!(key);
                            replaced.push(r);
                        }
                        k.labels.insert(key, label);
                    }
                    Ok((moved, replaced))
                })?;
                let mut out = json!({"ok": true, "set": items.len(), "moved": moved});
                if !replaced.is_empty() {
                    out["replaced"] = json!(replaced);
                }
                if !warnings.is_empty() {
                    out["warnings"] = json!(warnings);
                }
                out
            }
            "label_delete" => {
                let (b, addr) = db_loc(&view, v("addr")?)?;
                let removed = db.update(&sha, |k| Ok(k.labels.remove(&key(b, addr))))?;
                json!({"removed": removed.map(|l| l.name)})
            }
            "label_search" => {
                let q = s("query").unwrap_or("");
                let re = if a.get("regex").and_then(Value::as_bool) == Some(true) {
                    Some(regex_lite::Regex::new(q).map_err(|e| format!("regex: {e}"))?)
                } else {
                    None
                };
                let ql = q.to_ascii_lowercase();
                let hit = |t: &str| re.as_ref().map_or_else(|| t.to_ascii_lowercase().contains(&ql), |r| r.is_match(t));
                let in_comments = a.get("in_comments").and_then(Value::as_bool).unwrap_or(false);
                let kind = s("kind");
                let max = limit(200)?;
                let k = db.knowledge(&sha);
                let show = |b: u16, x: u16, l: &Label| {
                    let mut e = json!({"addr": key(b, x), "name": l.name, "kind": l.kind});
                    for (f, val) in [("size", &l.size), ("entries", &l.entries), ("target_bank", &l.target_bank)] {
                        if let Some(val) = val {
                            e[f] = val.clone();
                        }
                    }
                    if let Some(c) = k.comments.get(&key(b, x)) {
                        e["comment"] = json!(c);
                    }
                    e
                };
                if let Some(near) = a.get("near") {
                    // The labels around a location, in its bank and ROM/RAM region: "what routine is this in?"
                    let (b, x) = resolve(&view, emu, near)?;
                    let b = if banked(x) { b } else { 0 };
                    let region = |y: u16| if y < 0x4000 { 0 } else if y < 0x8000 { 1 } else { 2 + (y >= 0xD000) as u8 };
                    let ok = |(&(lb, la), l): &(&(u16, u16), &Label)| lb == b && region(la) == region(x) && kind.is_none_or(|kd| kd == l.kind);
                    let before: Vec<Value> = view.labels.range(..=(b, x)).rev().filter(ok).take(limit(1)?).map(|(&(lb, la), l)| {
                        let mut e = show(lb, la, l);
                        e["offset"] = json!(format!("{:X}", x - la));
                        e
                    }).collect();
                    let after = view.labels.range((b, x.saturating_add(1))..).find(ok).map(|(&(lb, la), l)| show(lb, la, l));
                    return Ok(Out::Json(json!({"at": view.fmt(b, x), "before": before, "after": after})));
                }
                let mut out = vec![];
                let mut total = 0;
                for (loc, l) in &k.labels {
                    let c = k.comments.get(loc);
                    if kind.is_some_and(|x| x != l.kind) || !(hit(&l.name) || (in_comments && c.is_some_and(|c| hit(c)))) {
                        continue;
                    }
                    total += 1;
                    if out.len() < max {
                        // A hand-written key that doesn't parse is still listed, as written.
                        out.push(match db::parse_key(loc) {
                            Ok((b, x)) => show(b, x, l),
                            Err(_) => json!({"addr": loc, "name": l.name, "kind": l.kind}),
                        });
                    }
                }
                if in_comments {
                    for (loc, c) in k.comments.iter().filter(|(loc, c)| !k.labels.contains_key(*loc) && hit(c)) {
                        total += 1;
                        if out.len() < max {
                            out.push(json!({"addr": loc, "comment": c}));
                        }
                    }
                }
                json!({"count": total, "results": out, "truncated": total > max})
            }
            "comment_set" => {
                let (b, addr) = db_loc(&view, v("addr")?)?;
                let text = s("text").unwrap_or("").to_string();
                let append = a.get("append").and_then(Value::as_bool) == Some(true);
                let (old, now) = db.update(&sha, |k| {
                    let old = k.comments.get(&key(b, addr)).cloned();
                    if text.is_empty() {
                        k.comments.remove(&key(b, addr));
                    } else {
                        k.comments.insert(key(b, addr), if append { joined(old.as_ref(), text.clone()) } else { text.clone() });
                    }
                    Ok((old, k.comments.get(&key(b, addr)).cloned()))
                })?;
                let mut out = json!({"ok": true, "addr": view.fmt(b, addr)});
                if append {
                    out["comment"] = json!(now);
                } else if let Some(o) = old.filter(|o| *o != text) {
                    out["replaced"] = json!(o);
                }
                out
            }
            "farcall_set" => {
                let (vb, va) = db_loc(&view, v("via")?)?;
                let f = FarCall {
                    name: label_name(s("name").ok_or("farcall_set needs \"name\"")?)?,
                    via: key(vb, va),
                    kind: s("kind").unwrap_or("inline").into(),
                    layout: arr(a, "layout").iter().filter_map(Value::as_str).map(String::from).collect(),
                    bank_reg: s("bank_reg").map(String::from),
                    addr_reg: s("addr_reg").map(String::from),
                    bank: a.get("bank").filter(|x| !x.is_null()).map(|x| num(x).map(|b| json!(format!("{b:02X}")))).transpose()?,
                    extra: Default::default(),
                };
                if let db::Conv::Inline { bank: Some(b), .. } | db::Conv::Regs { bank: Some(b), .. } | db::Conv::Switch { bank: Some(b), .. } = db::conv(&f)? {
                    if b >= rom.banks() {
                        return Err(format!("bank {b:02X}: the ROM has {:X} banks", rom.banks()));
                    }
                }
                let name = f.name.clone();
                db.update(&sha, |k| {
                    k.far_calls.retain(|x| x.name != name);
                    k.far_calls.push(f);
                    Ok(())
                })?;
                json!({"ok": true, "far_calls": db.knowledge(&sha).far_calls})
            }
            "farcall_delete" => {
                let name = s("name").ok_or("farcall_delete needs \"name\"")?.to_string();
                let n = db.update(&sha, |k| {
                    let before = k.far_calls.len();
                    k.far_calls.retain(|x| x.name != name);
                    Ok(before - k.far_calls.len())
                })?;
                json!({"removed": n})
            }
            "charmap_set" => {
                let path = s("path").unwrap_or("").to_string();
                let entries = if path.is_empty() { 0 } else { Charmap::load(&path).map(|c| c.len())? };
                db.update(&sha, |k| {
                    k.charmap = (!path.is_empty()).then(|| path.clone());
                    Ok(())
                })?;
                json!({"ok": true, "charmap": (!path.is_empty()).then_some(path), "entries": entries})
            }
            "db_dump" => {
                let mut k = db.knowledge(&sha);
                let sections = arr(a, "sections");
                let filtered = !sections.is_empty() || ["banks", "range", "limit", "offset"].iter().any(|x| a.get(*x).is_some());
                if !filtered {
                    return Ok(Out::Json(json!({"db": db.path(), "sha1": sha, "knowledge": k})));
                }
                let want: Vec<&str> = sections.iter().filter_map(Value::as_str).collect();
                for w in &want {
                    if !["labels", "comments", "far_calls", "charmap"].contains(w) {
                        return Err(format!("sections: {w:?} (labels comments far_calls charmap)"));
                    }
                }
                let shown = |x: &str| want.is_empty() || want.contains(&x);
                let banks = a.get("banks").map(|_| bank_range(a.get("banks"), 0x200)).transpose()?;
                let range = match s("range") {
                    Some(r) => {
                        let (x, y) = r.split_once('-').ok_or("range: \"AAAA-BBBB\" (hex, inclusive)")?;
                        Some((num(&json!(x))?, num(&json!(y))?))
                    }
                    None => None,
                };
                let keep = |loc: &String| {
                    let Ok((b, x)) = db::parse_key(loc) else { return banks.is_none() && range.is_none() };
                    banks.is_none_or(|(lo, hi)| (lo..=hi).contains(&b)) && range.is_none_or(|(lo, hi)| (lo..=hi).contains(&(x as u32)))
                };
                let (offset, max) = (opt_num(a, "offset", 0)? as usize, limit(100_000)?);
                let mut counts = json!({});
                let mut page = |m: &mut std::collections::BTreeMap<String, Value>, what: &str| {
                    let all: Vec<(String, Value)> = std::mem::take(m).into_iter().filter(|(l, _)| keep(l)).collect();
                    counts[what] = json!(all.len());
                    m.extend(all.into_iter().skip(offset).take(max));
                };
                let mut labels = k.labels.iter().map(|(l, x)| (l.clone(), serde_json::to_value(x).unwrap_or_default())).collect();
                let mut comments = k.comments.iter().map(|(l, x)| (l.clone(), json!(x))).collect();
                page(&mut labels, "labels");
                page(&mut comments, "comments");
                let mut out = json!({});
                if shown("labels") {
                    out["labels"] = json!(labels);
                }
                if shown("comments") {
                    out["comments"] = json!(comments);
                }
                if shown("far_calls") {
                    out["far_calls"] = json!(std::mem::take(&mut k.far_calls));
                }
                if shown("charmap") {
                    out["charmap"] = json!(k.charmap);
                }
                json!({"db": db.path(), "sha1": sha, "knowledge": out, "counts": counts, "offset": offset})
            }
            // ---- emulation ----
            "emu_boot" => emu::boot(emu, rom, &view, capped(a, "frames", 0, emu::MAX_FRAMES)?, &emu::parse_inputs(arr(a, "inputs"))?)?,
            "run" => {
                let stubs = emu::parse_stubs(&view, arr(a, "stubs"))?;
                emu::run_frames(emu, rom, &view, capped(a, "frames", 60, emu::MAX_FRAMES)?, &emu::parse_inputs(arr(a, "inputs"))?, &stubs)?
            }
            "step" => emu::step(emu, rom, &view, capped(a, "count", 1, 10_000_000)?.max(1))?,
            "input" => {
                let b = match v("buttons")? {
                    Value::Array(x) => x.iter().filter_map(Value::as_str).collect::<Vec<_>>().join("+"),
                    x => x.as_str().unwrap_or("").to_string(),
                };
                let hold = capped(a, "hold", 5, emu::MAX_FRAMES)?.max(1);
                let total = hold + capped(a, "after", 0, emu::MAX_FRAMES)?;
                if total > emu::MAX_FRAMES {
                    return Err(format!("hold + after: at most {} frames per call", emu::MAX_FRAMES));
                }
                emu::run_frames(emu, rom, &view, total, &vec![(0, emu::buttons(&b)?, hold)], &[])?
            }
            "call_routine" => emu::call(emu, rom, &view, a)?,
            "mem_read" => {
                let len = opt_num(a, "len", 16)?.clamp(1, 0x10000) as usize;
                if let Some(at) = emu::space(v("addr")?)? {
                    let data = emu::space_read(machine(&mut emu.gb, rom)?, at, len)?;
                    let rows: Vec<String> = data.chunks(16).enumerate().map(|(i, c)| format!("{}  {}", emu::space_name((at.0, at.1, at.2 + 16 * i as u16)), hex(c))).collect();
                    return Ok(Out::Json(json!({"addr": emu::space_name(at), "len": len, "rows": rows})));
                }
                let (b, addr) = view.loc(v("addr")?)?;
                let data = match &emu.gb {
                    // Straight from the ROM file only while the whole read stays in ROM.
                    None if addr as usize + len <= 0x8000 => (0..len).map(|i| rom.byte(b.unwrap_or(1), addr + i as u16).unwrap_or(0xFF)).collect(),
                    _ => {
                        let gb = machine(&mut emu.gb, rom)?;
                        emu::read_loc(gb, rom, (b, addr), len)
                    }
                };
                let live = |x: u16| if banked(x) { emu.gb.as_ref().map_or(1, |g| emu::here(g, x)) } else { 0 };
                let bank = b.unwrap_or_else(|| live(addr));
                let rows: Vec<String> = data
                    .chunks(16)
                    .enumerate()
                    .map(|(i, c)| {
                        let ascii: String = c.iter().map(|&x| if (0x20..0x7F).contains(&x) { x as char } else { '.' }).collect();
                        let ra = addr.wrapping_add(16 * i as u16);
                        format!("{:02X}:{ra:04X}  {:<47}  {ascii}", emu::bank_at(Some(bank), addr, ra).unwrap_or_else(|| live(ra)), hex(c))
                    })
                    .collect();
                json!({"addr": view.fmt(bank, addr), "len": len, "rows": rows})
            }
            "mem_write" => {
                let data = bytes(v("bytes")?)?;
                if let Some(at) = emu::space(v("addr")?)? {
                    let gb = machine(&mut emu.gb, rom)?;
                    emu::space_write(gb, at, &data)?;
                    return Ok(Out::Json(json!({"ok": true, "written": data.len(), "now": hex(&emu::space_read(gb, at, data.len())?)})));
                }
                let l = view.loc(v("addr")?)?;
                let gb = machine(&mut emu.gb, rom)?;
                emu::write_loc(gb, l, &data);
                json!({"ok": true, "written": data.len(), "now": hex(&emu::read_loc(gb, rom, l, data.len()))})
            }
            "regs_get" => emu::regs_json(machine(&mut emu.gb, rom)?, &view),
            "regs_set" => {
                let gb = machine(&mut emu.gb, rom)?;
                emu::set_regs(gb, a.get("regs").unwrap_or(a))?;
                emu::regs_json(gb, &view)
            }
            "state_save" => {
                let slot = s("slot").unwrap_or("default").to_string();
                let gb = machine(&mut emu.gb, rom)?;
                let data = gb.save_state();
                let n = data.len();
                // A screen still stale from a load is not this state's picture.
                let screen = emu.stale_screen.is_none().then(|| gb.screen().to_vec());
                emu.slots.insert(slot.clone(), emu::Slot { state: data, screen });
                json!({"slot": slot, "bytes": n, "slots": emu.slots.keys().collect::<Vec<_>>()})
            }
            "state_load" => {
                let slot = s("slot").unwrap_or("default");
                let picture = emu::load_slot(emu, rom, slot)?;
                let mut out = json!({"slot": slot, "regs": emu::regs_json(machine(&mut emu.gb, rom)?, &view)});
                if !picture {
                    out["note"] = json!(emu::NO_PICTURE);
                }
                out
            }
            "state_export" => {
                let path = s("path").ok_or("state_export needs \"path\"")?;
                if let Some(repo) = inside_git_repo(Path::new(path)) {
                    return Err(format!("refusing to write a save state inside the git repository {}", repo.display()));
                }
                let data = match s("slot") {
                    Some(slot) => emu.slots.get(slot).ok_or(format!("no state slot {slot:?}"))?.state.clone(),
                    None => machine(&mut emu.gb, rom)?.save_state(),
                };
                std::fs::write(path, &data).map_err(|e| format!("{path}: {e}"))?;
                json!({"path": path, "bytes": data.len()})
            }
            "state_import" => {
                let path = s("path").ok_or("state_import needs \"path\"")?;
                let data = std::fs::read(path).map_err(|e| format!("{path}: {e}"))?;
                match s("slot") {
                    Some(slot) => {
                        emu.slots.insert(slot.into(), emu::Slot { state: data, screen: None });
                        json!({"slot": slot, "slots": emu.slots.keys().collect::<Vec<_>>()})
                    }
                    None => {
                        let gb = machine(&mut emu.gb, rom)?;
                        if !gb.load_state(&data) {
                            return Err(format!("{path}: rejected by the core (another ROM or version?)"));
                        }
                        emu.stale_screen = Some(emu.frames + 2);
                        emu.pending_call = None;
                        json!({"loaded": path, "regs": emu::regs_json(gb, &view), "note": emu::NO_PICTURE})
                    }
                }
            }
            "breakpoint_set" => {
                let l = view.loc(v("addr")?)?;
                let c = emu::cond(a.get("when"))?;
                // One breakpoint per location: setting it again replaces its condition.
                emu.bps.retain(|(x, _)| *x != l);
                emu.bps.push((l, c));
                bps_json(&view, emu)
            }
            "breakpoint_clear" => {
                match a.get("addr") {
                    Some(x) => {
                        let (b, x) = view.loc(x)?;
                        emu.bps.retain(|((bb, xx), _)| !(*xx == x && (b.is_none() || *bb == b)));
                    }
                    None => emu.bps.clear(),
                }
                bps_json(&view, emu)
            }
            "watchpoint_set" => {
                let (bank, addr) = match emu::space(v("addr")?)? {
                    Some((emu::Space::Vram, b, x)) => (Some(b), x),
                    Some(_) => return Err("a cartridge-RAM bank can't be watched (its mapping isn't visible to the watch filter): watch $A000-$BFFF without a bank".into()),
                    None => {
                        let (b, x) = view.loc(v("addr")?)?;
                        (b.filter(|_| banked(x)), x)
                    }
                };
                let kind = s("kind").unwrap_or("write");
                let (read, write) = match kind {
                    "read" => (true, false),
                    "write" => (false, true),
                    "access" => (true, true),
                    o => return Err(format!("kind {o:?}: read|write|access")),
                };
                let len = opt_num(a, "len", 1)?.clamp(1, 0x1000) as u16;
                let value = a.get("value").filter(|x| !x.is_null()).map(|x| num(x).ok().filter(|&n| n < 0x100).map(|n| n as u8).ok_or(format!("value {x}: a byte"))).transpose()?;
                emu.wps.push(emu::Wp { addr, len, read, write, bank, value });
                wps_json(&view, emu)
            }
            "watchpoint_clear" => {
                match a.get("addr") {
                    Some(x) => {
                        // A bank given where it matters (a banked region, or vramN:) removes only that bank's.
                        let (b, x, exact) = match emu::space(x)? {
                            Some((_, b, x)) => (Some(b), x, true),
                            None => {
                                let (b, x) = view.loc(x)?;
                                (b, x, b.is_some() && banked(x))
                            }
                        };
                        emu.wps.retain(|w| !(w.addr == x && (!exact || w.bank == b)));
                    }
                    None => emu.wps.clear(),
                }
                wps_json(&view, emu)
            }
            "screenshot" => {
                let png = emu::screenshot(machine(&mut emu.gb, rom)?, opt_num(a, "scale", 2)?)?;
                return Ok(Out::Png(png, emu.stale_screen.is_some().then_some(emu::NO_PICTURE)));
            }
            _ => return Err(format!("unknown tool {name}")),
        };
        Ok(Out::Json(j))
    }
}

fn bps_json(view: &View, emu: &Emu) -> Value {
    json!({"breakpoints": emu.bps.iter().map(|((b, x), c)| {
        let at = rom::fmt_ref(view, *b, *x);
        if c.is_empty() { at } else { format!("{at} when {}", emu::cond_text(c)) }
    }).collect::<Vec<_>>()})
}

fn wps_json(view: &View, emu: &Emu) -> Value {
    json!({"watchpoints": emu.wps.iter().map(|w| {
        let mut e = json!({
            "addr": match w.bank {
                Some(b) if (0x8000..0xA000).contains(&w.addr) => emu::space_name((emu::Space::Vram, b, w.addr)),
                _ => rom::fmt_ref(view, if banked(w.addr) { w.bank } else { Some(0) }, w.addr),
            },
            "len": w.len, "kind": match (w.read, w.write) { (true, true) => "access", (true, false) => "read", _ => "write" },
        });
        if let Some(v) = w.value {
            e["value"] = json!(format!("{v:02X}"));
        }
        e
    }).collect::<Vec<_>>()})
}

fn rpc_error(id: Value, code: i64, message: &str) -> Value {
    json!({"jsonrpc": "2.0", "id": id, "error": {"code": code, "message": message}})
}

/// Reads newline-delimited JSON-RPC from `input` and answers on `out` until EOF. Only protocol
/// goes to `out`; diagnostics belong on stderr.
pub fn serve(server: &mut Server, mut input: impl BufRead, mut out: impl Write) -> std::io::Result<()> {
    let mut line = vec![];
    loop {
        line.clear();
        // Raw bytes: a line that isn't UTF-8 is a parse error to answer, not the end of the server.
        if input.read_until(b'\n', &mut line)? == 0 {
            return Ok(());
        }
        if line.iter().all(u8::is_ascii_whitespace) {
            continue;
        }
        let resp = match serde_json::from_slice::<Value>(&line) {
            Ok(m) if m.is_object() => server.handle(&m),
            Ok(_) => Some(rpc_error(Value::Null, -32600, "Invalid Request (batches are not supported)")),
            Err(e) => Some(rpc_error(Value::Null, -32700, &format!("Parse error: {e}"))),
        };
        if let Some(r) = resp {
            writeln!(out, "{r}")?;
            out.flush()?;
        }
    }
}

const INSTRUCTIONS: &str = "Game Boy ROM reverse-engineering server. Start with rom_info (read-only: is a ROM open, \
and the session's state) or rom_open (opening the ROM already open keeps the session). Values: JSON numbers are decimal, \
strings are hex (\"0x1F\", \"$1F\", \"1F\"): pass hex as a string. Locations: a label name, \"BB:AAAA\" (bank:addr, \
hex; the bank matters for $4000-$7FFF ROM, never 00 there, and $D000-$DFFF WRAM) or a plain address; any \
\"BB:AAAA Name\" from an output can be passed back. Labels, comments and far-call conventions are shared with other \
agents through the knowledge DB: label what you understand (label_set) and check label_search before re-deriving a \
routine. Emulation keeps one session in memory, shared by every agent using this server: emu_boot, then \
run/input/step, state_save/state_load slots, and call_routine to run one routine in isolation (from_slot restores a \
slot first).";

/// The instructions, with every tool's name (a client may show only some of the schemas).
fn instructions() -> String {
    let names: Vec<&str> = tools().iter().filter_map(|t| t["name"].as_str()).collect();
    format!("{INSTRUCTIONS} Tools ({}): {}.", names.len(), names.join(", "))
}

fn tools() -> &'static Vec<Value> {
    static T: OnceLock<Vec<Value>> = OnceLock::new();
    T.get_or_init(|| {
        // Hex values are strings only: a client that converts numeric-looking strings to numbers
        // for an integer-typed field would turn hex "11" into decimal 11. Numbers are still accepted.
        let loc = |d: &str| json!({"type": "string", "description": d});
        let hx = |d: &str| json!({"type": "string", "description": format!("{d} (hex string)")});
        let int = |d: &str| json!({"type": ["integer", "string"], "description": d});
        let st = |d: &str| json!({"type": "string", "description": d});
        let bo = |d: &str| json!({"type": "boolean", "description": d});
        let obj = |d: &str| json!({"type": "object", "description": d});
        let list = |d: &str, items: Value| json!({"type": "array", "items": items, "description": d});
        let str_items = json!({"type": "string"});
        let obj_items = json!({"type": "object"});
        let banks = json!({"type": "string", "description": "Banks to search: \"05\" or \"02-05\" (hex); default all"});
        let t = |name: &str, desc: &str, props: Value, req: &[&str]| {
            json!({"name": name, "description": desc, "inputSchema": {"type": "object", "properties": props, "required": req}})
        };
        let inputs = list("Input script: [\"frame:button[+button][:hold]\"], e.g. [\"10:start\", \"60:a+b:8\"]. Frames count from 0 in this call; hold defaults to 5", str_items.clone());
        let addr = "Location: label name, \"BB:AAAA\" (bank:addr hex) or address";
        vec![
            t("rom_info", "Read-only: whether a ROM is open, its header and DB counts, and the emulator session's state (powered, frames, pc, bank, slots, breakpoints). Changes nothing: use it before rom_open when other agents may share the session.",
              json!({}), &[]),
            t("rom_open", "Open a ROM file (read-only). Returns the header (title bytes hex+ascii, cart type, ROM/RAM size, CGB flag, SHA-1, banks) and what the knowledge DB holds for it. Opening another ROM resets the emulator session; opening the ROM already open keeps it (\"session\": \"kept\") unless reset is true.",
              json!({"path": st("Path of the .gb/.gbc file"), "reset": bo("Reset the session even when this ROM is already open")}), &["path"]),
            t("disasm", "Disassemble (RGBDS syntax) with labels substituted for targets and DB comments shown. ROM regions labelled data/jumptable/pointers show as DB/DW lines; decoding restarts at a label inside an instruction. A bank-0 CALL/JP into $4000-$7FFF lists the labels at that address in any bank (; ?? ...). Example: {\"addr\": \"05:6000\", \"until_ret\": true}; several places at once: {\"addrs\": [\"05:6000\", \"Memcpy\"], \"count\": 8}. RAM addresses are read from the live session.",
              json!({"addr": loc(addr), "addrs": list("Batch: up to 64 locations, each disassembled with the same count/until_ret", str_items.clone()), "count": int("Instructions or data lines (default 32; 1000 with until_ret)"), "until_ret": bo("Stop at the end of the function: an unconditional RET/RETI/JP/JR (or an illegal opcode, or a data label) with no earlier forward branch past it; otherwise resume at that branch target")}), &[]),
            t("xrefs", "Every call/jp/jr/rst/ld-immediate reference to a location across the whole ROM (bank-aware, cached index), with the referencing instruction, including far calls through declared conventions (farcall_set) and entries of declared jumptable/pointers tables. For a RAM address, the insn shows reads (LD A, [nn]) vs writes (LD [nn], A) vs pointer loads (LD HL, nn). A ref flagged unreached comes from bytes no path from the vectors, code labels or declared tables reaches (often data decoded as code). \"inside\" names the routine a mid-function target belongs to. Example: {\"target\": \"00:1A2B\"} (\"addr\" works too).",
              json!({"target": loc(addr), "addr": loc("Same as target"), "kind": json!({"type": ["string", "array"], "items": str_items, "description": "Filter: call|jp|jr|rst|ld|far|table|word (or a list)"}),
                     "reached_only": bo("Drop refs flagged unreached"), "words": bo("Also list every little-endian 16-bit occurrence of the address that is not an instruction operand already listed (kind word; pointers in undeclared tables), in banks"),
                     "banks": json!({"type": "string", "description": "words: banks to scan, \"05\" or \"02-05\" (hex); default all"}), "limit": int("Max results (default 200)")}), &[]),
            t("find_bytes", "Search the ROM for a byte pattern with wildcards: ?? any byte, ? any nibble. Example: {\"pattern\": \"3E ?? CD\"} (LD A, n then a CALL), {\"pattern\": \"21 ?? 4?\"}. insn_start keeps only hits where an instruction starts (not inside another one's operand).",
              json!({"pattern": st("Hex bytes; ? = any nibble, ?? = any byte"), "banks": banks.clone(), "insn_start": bo("Only hits at the start of an instruction of the linear sweep"), "limit": int("Max hits (default 100)")}), &["pattern"]),
            t("find_immediate", "Find instructions with a given immediate (n8 or n16), optionally by mnemonic prefix, at instruction starts only. Example: {\"value\": \"3C\", \"mnemonic\": \"cp\"} finds every CP A, $3C; {\"value\": \"A1\", \"mnemonic\": \"ldh\"} every LDH [$FFA1], A / LDH A, [$FFA1].",
              json!({"value": hx("The immediate value"), "mnemonic": st("Text prefix, spaces ignored: \"cp\", \"ld a\", \"ld hl\", \"ldh [\""), "banks": banks.clone(), "limit": int("Max hits (default 100)")}), &["value"]),
            t("function_bounds", "Explore one function from its entry (following local branches until RET/JP or an illegal opcode): extent, callees (incl. far calls and tail jumps), exits, JP HL jump tables, illegal opcodes reached.",
              json!({"addr": loc(addr)}), &["addr"]),
            t("table_entries", "List a table of little-endian 16-bit pointers with each target's label: a declared jumptable/pointers label, or any ROM address with \"entries\". Example: {\"addr\": \"01:5000\", \"entries\": 6}.",
              json!({"addr": loc(addr), "entries": int("Entry count (default: the label's)"), "target_bank": hx("Bank of targets in $4000-$7FFF (default: the label's, else the table's own bank; from bank 0 the bank is unknown, shown ??)")}), &["addr"]),
            t("records", "Decode a list of fixed-layout records in ROM, up to a terminator byte: fields b (byte) and w (16-bit pointer, shown with its target's label). Example: {\"addr\": \"05:4000\", \"fields\": [\"b\", \"w\"], \"terminator\": \"00\"} for a list of (byte, pointer) records ended by $00. \"bytes\" is the size to declare with label_set kind data.",
              json!({"addr": loc(addr), "fields": list("Record layout, in order: b | w", json!({"type": "string", "enum": ["b", "w"]})), "terminator": hx("A record starting with this byte ends the list (consumed)"),
                     "count": int("Max records (default 256, max 4096)"), "target_bank": hx("Bank of pointers into $4000-$7FFF (default: the list's bank)")}), &["addr", "fields"]),
            t("callgraph", "Callees of a function, recursively to a depth (bank-aware; far-call conventions honoured; a declared jumptable loaded with LD rr, Table adds its entries).",
              json!({"addr": loc(addr), "depth": int("Levels (default 2, max 8)")}), &["addr"]),
            t("text_decode", "Decode text with a .tbl charmap (the DB's, or \"charmap\"). Example: {\"addr\": \"0A:5000\", \"terminator\": \"FF\"}.",
              json!({"addr": loc(addr), "len": int("Max bytes (default 256, 1024 with a terminator)"), "terminator": hx("Stop after this byte"), "charmap": st("Path of a .tbl file (overrides the DB's)")}), &["addr"]),
            t("label_set", "Name a location in the shared knowledge DB (seen by every agent). A name already used elsewhere moves here. The result lists what it replaced (another name, a comment: use append to keep it) and warns when a code label falls inside an instruction. Example: {\"addr\": \"00:1A2B\", \"name\": \"Memcpy\", \"comment\": \"copy BC bytes from HL to DE\"}, a sized table {\"addr\": \"01:5000\", \"name\": \"Sines\", \"kind\": \"data\", \"size\": 64}, a jump table {\"addr\": \"01:5100\", \"name\": \"StateTable\", \"kind\": \"jumptable\", \"entries\": 6}, or {\"labels\": [{\"addr\": .., \"name\": ..}, ...]}.",
              json!({"addr": loc("\"BB:AAAA\" (bank required in $4000-$7FFF / $D000-$DFFF)"), "name": st("Label name (no spaces, not a hex number)"),
                     "kind": st("code | data | ram | jumptable | pointers (default: code in ROM, ram elsewhere). Non-code regions are skipped by the xref sweep: for their size, else up to the next label. jumptable/pointers: 16-bit LE entries, each a reference from the table (xrefs kind table); jumptable entries are also callees"),
                     "size": int("Bytes the region takes: the sweep resumes code right after it (default for tables: entries * 2)"),
                     "entries": int("jumptable/pointers: number of 16-bit entries"),
                     "target_bank": hx("jumptable/pointers: ROM bank of entries in $4000-$7FFF (default: the table's bank; from bank 0 the bank is unknown)"),
                     "comment": st("Optional comment"), "append": bo("Append the comment to the one already there (\" | \") instead of replacing it"),
                     "labels": list("Batch: [{addr, name, kind?, size?, entries?, target_bank?, comment?, append?}]", obj_items.clone())}), &[]),
            t("label_delete", "Remove the label at a location.", json!({"addr": loc(addr)}), &["addr"]),
            t("label_search", "Search labels by substring (case-insensitive) or regex. Example: {\"query\": \"^Mem\", \"regex\": true}. With near: the labels at or before a location (nearest first, with offset) and the next one after, in its bank and region: {\"near\": \"02:4F10\", \"kind\": \"code\"} answers which routine contains it.",
              json!({"query": st("Substring or regex; empty lists all"), "regex": bo("Treat query as a regex"), "kind": st("code|data|ram|jumptable|pointers"), "in_comments": bo("Also search comments"), "near": loc("A location: return the labels around it instead (limit: how many before, default 1)"), "limit": int("Max results (default 200; 1 with near)")}), &[]),
            t("comment_set", "Attach a comment to a location (shown in disasm). Empty text removes it. The result shows the comment it replaced; append keeps it.",
              json!({"addr": loc(addr), "text": st("Comment"), "append": bo("Append to the comment already there (\" | \")")}), &["addr"]),
            t("farcall_set", "Declare a far-call convention so xrefs/disasm/callgraph/function_bounds resolve cross-bank calls. inline: {\"name\": \"farcall\", \"via\": \"00:0008\", \"kind\": \"inline\", \"layout\": [\"bank\", \"lo\", \"hi\"]} (a CALL/RST to via is followed by those bytes, skipped by the sweep). A fixed bank instead of a bank byte: {\"name\": \"fixedcall\", \"via\": \"00:0010\", \"kind\": \"inline\", \"layout\": [\"lo\", \"hi\"], \"bank\": \"02\"}. regs: {\"name\": \"bankcall\", \"via\": \"00:1234\", \"kind\": \"regs\", \"bank_reg\": \"a\", \"addr_reg\": \"hl\"} (ld a,bank ; ld hl,addr ; call via; registers known only from immediates, copies and xor a since the last call/unconditional jump/label). switch: {\"name\": \"bankswitch\", \"via\": \"00:1234\", \"kind\": \"switch\", \"bank_reg\": \"a\"}, a routine that maps the bank in bank_reg: bank-0 calls/jumps into $4000-$7FFF after it (until a label or an unconditional jump/return) resolve to that bank (as after ld [$2000], a with a known A).",
              json!({"name": st("Convention name"), "via": loc("The trampoline routine"), "kind": st("inline | regs | switch"), "layout": list("inline: order of the inline bytes, items bank|lo|hi|skip (bank left out when \"bank\" is given)", json!({"type": "string", "enum": ["bank", "lo", "hi", "skip"]})), "bank": hx("A fixed target bank for conventions that don't pass one (not with bank_reg)"), "bank_reg": st("regs/switch: a|b|c|d|e|h|l (default a)"), "addr_reg": st("regs: bc|de|hl (default hl)")}), &["name", "via", "kind"]),
            t("farcall_delete", "Remove a far-call convention.", json!({"name": st("Convention name")}), &["name"]),
            t("charmap_set", "Set the .tbl charmap file used by text_decode (\"\" clears). The file stays wherever the user keeps it.",
              json!({"path": st("Path of the .tbl file")}), &["path"]),
            t("db_dump", "The knowledge DB entry for the open ROM (all: the whole file). It can be large: sections, banks, range, offset and limit return part of it (with \"counts\" of the matching labels/comments). Example: {\"sections\": [\"far_calls\"]}, {\"banks\": \"02\", \"range\": \"4000-4FFF\"}.",
              json!({"all": bo("Every ROM in the file (no filters)"), "sections": list("Only these: labels | comments | far_calls | charmap", str_items.clone()),
                     "banks": json!({"type": "string", "description": "Labels/comments in these banks: \"02\" or \"02-05\" (hex)"}), "range": st("Labels/comments in this address range, \"AAAA-BBBB\" (hex, inclusive)"),
                     "offset": int("Skip this many matching labels (and comments)"), "limit": int("At most this many labels (and comments)")}), &[]),
            t("emu_boot", "Power on a fresh session (post-boot state, boot ROM skipped) and run frames with an input script.",
              json!({"frames": int("Frames to run (default 0, max 10800)"), "inputs": inputs.clone()}), &[]),
            t("run", "Run frames with an input script; stops early at a breakpoint or watchpoint (reports pc, bank, and caller: the nearest return address on the stack). stubs force a routine's result while the game runs. total_frames counts every frame this session ran since emu_boot (slot loads don't change it).",
              json!({"frames": int("Frames (default 60, max 10800)"), "inputs": inputs.clone(),
                     "stubs": list("[{\"addr\": .., \"regs\": {..}}]: whenever addr is reached, emulate RET then set regs (stub_hits counts them)", obj_items.clone())}), &[]),
            t("step", "Single-step instructions; stops at a breakpoint or after an instruction that reads/writes a watchpoint (as run does). A step that dispatches an interrupt runs the handler's first instruction (logged \"(interrupt)\").",
              json!({"count": int("Instructions (default 1, max 10000000)")}), &[]),
            t("input", "Press buttons for `hold` frames, then run `after` more frames.",
              json!({"buttons": json!({"type": ["string", "array"], "items": str_items, "description": "\"a\", \"start\", \"a+b\" or [\"up\", \"a\"]"}), "hold": int("Frames held (default 5)"), "after": int("Frames after release (default 0; hold + after at most 10800)")}), &["buttons"]),
            t("call_routine", "Call one routine: push a sentinel return address, jump, step the whole machine (VBlank waits and interrupts complete) until it returns; on return PC and SP go back to where the session was. A call that stops early (breakpoint, max_steps) can be resumed with {\"continue\": true} and new stubs/regs/writes. Example: {\"addr\": \"00:1A2B\", \"regs\": {\"a\": 2}, \"stubs\": [{\"addr\": \"00:1A40\", \"regs\": {\"a\": \"FF\"}, \"log\": true}]}.",
              json!({
                  "addr": loc("Routine entry"), "continue": bo("Resume the call_routine that stopped before returning, from where it stopped (no addr)"),
                  "from_slot": st("Restore this state slot first (isolated calls)"),
                  "regs": obj("{\"a\": .., \"bc\": .., \"sp\": .., \"flags\": {\"z\": true}, \"ime\": false}"),
                  "writes": list("[{\"addr\": \"C000\", \"bytes\": \"01 02\"}] applied before the call", obj_items.clone()),
                  "stubs": list("[{\"addr\": .., \"regs\": {..}, \"log\": true}]: on reaching addr, emulate RET then set regs; stub_counts counts hits per stub, log records a, f, bc, de, hl and the caller at each hit (stub_log, up to 256)", obj_items.clone()),
                  "forces": list("[{\"addr\": .., \"bytes\": ..}]: rewritten before every instruction (pins a variable)", obj_items.clone()),
                  "breakpoints": list("Locations to stop at", str_items.clone()),
                  "inputs": list("Buttons held during the call: [\"frame:button[+button][:hold]\"], frames counted in VBlanks since the call started", str_items.clone()),
                  "watch": list("[{\"addr\": .., \"len\": n}]: log value changes with pc (len up to 4096)", obj_items.clone()),
                  "dumps": list("[{\"addr\": .., \"len\": n}] read after the call (len up to 65536)", obj_items),
                  "max_steps": int("Default 5000000, max 50000000"), "trace": json!({"type": ["boolean", "integer"], "description": "Log calls/rst/irq/stub hits/bank switches (true or a cap, default 2000 entries)"}),
                  "trace_kinds": list("Trace only these kinds: call rst irq stub bank jp_hl", str_items.clone()),
                  "trace_summary": bo("Instead of the trace list, count trace entries per kind and target (\"call 00:1234 Foo\": n)"),
                  "trace_steps": int("Also log the first N instructions"), "ime": json!({"type": ["boolean", "integer"], "description": "Override IME"}), "rom_bank": hx("Map this ROM bank first"),
                  "svbk": hx("Write SVBK ($FF70) first"), "sentinel": hx("Return address used (default FEFF)"),
              }), &[]),
            t("mem_read", "Read memory (live session; ROM reads work without one). \"BB:AAAA\" reads that ROM or WRAM bank without remapping; \"vram1:8000\" a VRAM bank and \"sram2:A000\" a cartridge RAM bank (hex), whatever is mapped and enabled.",
              json!({"addr": loc(addr), "len": int("Bytes (default 16)")}), &["addr"]),
            t("mem_write", "Write memory in the session (ROM-area writes reach the MBC registers). \"BB:DXXX\" writes that WRAM bank, \"vram1:8000\" / \"sram2:A000\" that VRAM / cartridge RAM bank.",
              json!({"addr": loc(addr), "bytes": json!({"type": ["string", "array"], "items": {"type": "string"}, "description": "Hex: \"11\", \"01 02 FF\", \"0102FF\", \"$11\", \"0x11, 0x22\" or [\"01\", \"FF\"]"})}), &["addr", "bytes"]),
            t("regs_get", "CPU registers, flags, IME, ROM/WRAM banks, pc and stack top with labels.", json!({}), &[]),
            t("regs_set", "Set registers.", json!({"regs": obj("{\"a\": \"12\", \"hl\": \"C000\", \"pc\": \"0150\", \"flags\": {\"c\": true}}")}), &["regs"]),
            t("state_save", "Save the session into a named in-memory slot.", json!({"slot": st("Slot name (default \"default\")")}), &[]),
            t("state_load", "Restore the session from a slot, and the picture saved with it (a slot imported from a file has none: see the note).", json!({"slot": st("Slot name (default \"default\")")}), &[]),
            t("state_export", "Write the session (or a slot) to a save-state file (never inside a git repository).",
              json!({"path": st("File path"), "slot": st("Export this slot instead of the session")}), &["path"]),
            t("state_import", "Load a save-state file into the session (or into a slot).",
              json!({"path": st("File path"), "slot": st("Import into this slot instead")}), &["path"]),
            t("breakpoint_set", "Stop run/step before the instruction at a location (bank-aware), when the registers in `when` hold those values. Setting it again replaces its condition. Example: {\"addr\": \"00:1A2B\", \"when\": {\"a\": \"05\", \"flags\": {\"c\": true}}}.",
              json!({"addr": loc(addr), "when": obj("Registers (a f b c d e h l af bc de hl sp, hex strings) and flags {\"z\": true, ...} that must match")}), &["addr"]),
            t("breakpoint_clear", "Remove a breakpoint (no addr: all).", json!({"addr": loc(addr)}), &[]),
            t("watchpoint_set", "Stop run/step when the CPU reads/writes a range; reports value, pc+bank and caller. \"BB:AAAA\" / \"vram1:8000\" fire only while that bank is mapped.",
              json!({"addr": loc(addr), "len": int("Bytes (default 1)"), "kind": st("read | write | access (default write)"), "value": hx("Fire only for an access of this byte value")}), &["addr"]),
            t("watchpoint_clear", "Remove watchpoints starting at addr, in that bank when given (no addr: all).", json!({"addr": loc(addr)}), &[]),
            t("screenshot", "The current screen as a PNG image.", json!({"scale": int("1-8 (default 2)")}), &[]),
        ]
    })
}
