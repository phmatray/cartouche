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

/// "01 02 ff" / "0102ff" / [1, 2, "ff"].
pub fn bytes(v: &Value) -> R<Vec<u8>> {
    match v {
        Value::String(s) => {
            let h: String = s.chars().filter(|c| !c.is_whitespace()).collect();
            if !h.len().is_multiple_of(2) || !h.is_ascii() {
                return Err(format!("bad hex bytes {s:?}"));
            }
            (0..h.len()).step_by(2).map(|i| u8::from_str_radix(&h[i..i + 2], 16).map_err(|_| format!("bad hex bytes {s:?}"))).collect()
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
                "instructions": INSTRUCTIONS,
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
        if name == "rom_open" {
            let path = a.get("path").and_then(Value::as_str).ok_or("rom_open needs \"path\"")?;
            let r = Rom::open(path)?;
            let mut h = r.header();
            let k = db.knowledge(&r.sha1);
            h["knowledge"] = json!({"db": db.path(), "labels": k.labels.len(), "comments": k.comments.len(),
                                    "far_calls": k.far_calls.len(), "charmap": k.charmap});
            *rom = Some(r);
            *emu = Emu::default();
            return Ok(Out::Json(h));
        }
        if name == "db_dump" && a.get("all").and_then(Value::as_bool) == Some(true) {
            return Ok(Out::Json(json!({"db": db.path(), "file": db.file()})));
        }
        let rom = rom.as_mut().ok_or("no ROM open: call rom_open first")?;
        let sha = rom.sha1.clone();
        let mut view = View::new(&db.knowledge(&sha));
        view.rom_banks = rom.banks();
        let v = |k: &str| a.get(k).ok_or(format!("{name} needs \"{k}\""));
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
                let (b, addr) = resolve(&view, emu, v("target")?)?;
                let kinds: Vec<String> = match a.get("kind") {
                    Some(Value::String(k)) => vec![k.to_ascii_lowercase()],
                    Some(Value::Array(ks)) => ks.iter().filter_map(Value::as_str).map(str::to_ascii_lowercase).collect(),
                    _ => vec![],
                };
                rom::xrefs(rom, &view, if addr < 0x4000 || (!banked(addr)) { 0 } else { b }, addr, &kinds, limit(200)?)
            }
            "find_bytes" => {
                let pat = rom::pattern(s("pattern").ok_or("find_bytes needs \"pattern\"")?)?;
                rom::find_bytes(rom, &view, &pat, bank_range(a.get("banks"), rom.banks())?, limit(100)?)
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
                    Some(x) if !x.is_null() => Some(num(x)? as u16),
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
                    let label = Label {
                        name, kind: kind.into(), size: size.map(|n| json!(n)), entries: entries.map(|n| json!(n)),
                        target_bank: target_bank.map(|b| json!(format!("{b:02X}"))), ..Label::default()
                    };
                    parsed.push((key(b, addr), label, comment));
                }
                let moved = db.update(&sha, |k| {
                    let mut moved = vec![];
                    for (key, label, comment) in parsed {
                        let old: Vec<String> = k.labels.iter().filter(|(kk, l)| l.name == label.name && **kk != key).map(|(kk, _)| kk.clone()).collect();
                        for o in old {
                            k.labels.remove(&o);
                            moved.push(json!({"name": label.name, "from": o}));
                        }
                        if let Some(c) = comment {
                            k.comments.insert(key.clone(), c);
                        }
                        k.labels.insert(key, label);
                    }
                    Ok(moved)
                })?;
                json!({"ok": true, "set": items.len(), "moved": moved})
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
                        let (b, x) = db::parse_key(loc)?;
                        out.push(show(b, x, l));
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
                db.update(&sha, |k| {
                    if text.is_empty() {
                        k.comments.remove(&key(b, addr));
                    } else {
                        k.comments.insert(key(b, addr), text.clone());
                    }
                    Ok(())
                })?;
                json!({"ok": true, "addr": view.fmt(b, addr)})
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
                db::conv(&f)?;
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
            "db_dump" => json!({"db": db.path(), "sha1": sha, "knowledge": db.knowledge(&sha)}),
            // ---- emulation ----
            "emu_boot" => emu::boot(emu, rom, &view, capped(a, "frames", 0, emu::MAX_FRAMES)?, &emu::parse_inputs(arr(a, "inputs"))?)?,
            "run" => emu::run_frames(emu, rom, &view, capped(a, "frames", 60, emu::MAX_FRAMES)?, &emu::parse_inputs(arr(a, "inputs"))?)?,
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
                emu::run_frames(emu, rom, &view, total, &vec![(0, emu::buttons(&b)?, hold)])?
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
                emu.slots.insert(slot.clone(), emu::Slot { state: data, screen: Some(gb.screen().to_vec()) });
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
                        emu.stale_screen = true;
                        json!({"loaded": path, "regs": emu::regs_json(gb, &view), "note": emu::NO_PICTURE})
                    }
                }
            }
            "breakpoint_set" => {
                let l = view.loc(v("addr")?)?;
                if !emu.bps.contains(&l) {
                    emu.bps.push(l);
                }
                json!({"breakpoints": emu.bps.iter().map(|(b, x)| rom::fmt_ref(&view, *b, *x)).collect::<Vec<_>>()})
            }
            "breakpoint_clear" => {
                match a.get("addr") {
                    Some(x) => {
                        let (b, x) = view.loc(x)?;
                        emu.bps.retain(|(bb, xx)| !(*xx == x && (b.is_none() || *bb == b)));
                    }
                    None => emu.bps.clear(),
                }
                json!({"breakpoints": emu.bps.iter().map(|(b, x)| rom::fmt_ref(&view, *b, *x)).collect::<Vec<_>>()})
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
                emu.wps.push(emu::Wp { addr, len, read, write, bank });
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
                return Ok(Out::Png(png, emu.stale_screen.then_some(emu::NO_PICTURE)));
            }
            _ => return Err(format!("unknown tool {name}")),
        };
        Ok(Out::Json(j))
    }
}

fn wps_json(view: &View, emu: &Emu) -> Value {
    json!({"watchpoints": emu.wps.iter().map(|w| json!({
        "addr": match w.bank {
            Some(b) if (0x8000..0xA000).contains(&w.addr) => emu::space_name((emu::Space::Vram, b, w.addr)),
            _ => rom::fmt_ref(view, if banked(w.addr) { w.bank } else { Some(0) }, w.addr),
        },
        "len": w.len, "kind": match (w.read, w.write) { (true, true) => "access", (true, false) => "read", _ => "write" },
    })).collect::<Vec<_>>()})
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

const INSTRUCTIONS: &str = "Game Boy ROM reverse-engineering server. Start with rom_open. Values: JSON numbers are decimal, \
strings are hex (\"0x1F\", \"$1F\", \"1F\"). Locations: a label name, \"BB:AAAA\" (bank:addr, hex; the bank matters for \
$4000-$7FFF ROM and $D000-$DFFF WRAM) or a plain address; any \"BB:AAAA Name\" from an output can be passed back. \
Labels, comments and far-call conventions are shared with other agents through the knowledge DB: label what you \
understand (label_set) and check label_search before re-deriving a routine. Emulation keeps one session in memory: \
emu_boot, then run/input/step, state_save/state_load slots, and call_routine to run one routine in isolation \
(from_slot restores a slot first).";

fn tools() -> &'static Vec<Value> {
    static T: OnceLock<Vec<Value>> = OnceLock::new();
    T.get_or_init(|| {
        let loc = |d: &str| json!({"type": ["string", "integer"], "description": d});
        let int = |d: &str| json!({"type": ["integer", "string"], "description": d});
        let st = |d: &str| json!({"type": "string", "description": d});
        let bo = |d: &str| json!({"type": "boolean", "description": d});
        let obj = |d: &str| json!({"type": "object", "description": d});
        let list = |d: &str, items: Value| json!({"type": "array", "items": items, "description": d});
        let str_items = json!({"type": "string"});
        let obj_items = json!({"type": "object"});
        let banks = json!({"type": ["string", "integer"], "description": "Banks to search: \"05\" or \"02-05\" (hex); default all"});
        let t = |name: &str, desc: &str, props: Value, req: &[&str]| {
            json!({"name": name, "description": desc, "inputSchema": {"type": "object", "properties": props, "required": req}})
        };
        let inputs = list("Input script: [\"frame:button[+button][:hold]\"], e.g. [\"10:start\", \"60:a+b:8\"]. Frames count from 0 in this call; hold defaults to 5", str_items.clone());
        let addr = "Location: label name, \"BB:AAAA\" (bank:addr hex) or address";
        vec![
            t("rom_open", "Open a ROM file (read-only). Returns the header (title bytes hex+ascii, cart type, ROM/RAM size, CGB flag, SHA-1, banks) and what the knowledge DB holds for it. Resets the emulator session.",
              json!({"path": st("Path of the .gb/.gbc file")}), &["path"]),
            t("disasm", "Disassemble (RGBDS syntax) with labels substituted for targets and DB comments shown. Example: {\"addr\": \"05:6000\", \"until_ret\": true}; several places at once: {\"addrs\": [\"05:6000\", \"Memcpy\"], \"count\": 8}. RAM addresses are read from the live session.",
              json!({"addr": loc(addr), "addrs": list("Batch: up to 64 locations, each disassembled with the same count/until_ret", json!({"type": ["string", "integer"]})), "count": int("Instructions (default 32; 1000 with until_ret)"), "until_ret": bo("Stop after the first unconditional RET/RETI/JP/JR (or an illegal opcode)")}), &[]),
            t("xrefs", "Every call/jp/jr/rst/ld-immediate reference to a location across the whole ROM (bank-aware, cached index), with the referencing instruction, including far calls through declared conventions (farcall_set) and entries of declared jumptable/pointers tables. For a RAM address, the insn shows reads (LD A, [nn]) vs writes (LD [nn], A) vs pointer loads (LD HL, nn). Example: {\"target\": \"00:1A2B\"}.",
              json!({"target": loc(addr), "kind": json!({"type": ["string", "array"], "items": str_items, "description": "Filter: call|jp|jr|rst|ld|far|table (or a list)"}), "limit": int("Max results (default 200)")}), &["target"]),
            t("find_bytes", "Search the ROM for a byte pattern with ?? wildcards. Example: {\"pattern\": \"3E ?? CD\"} (LD A, n then a CALL).",
              json!({"pattern": st("Hex bytes, ?? = any byte"), "banks": banks.clone(), "limit": int("Max hits (default 100)")}), &["pattern"]),
            t("find_immediate", "Find instructions with a given immediate (n8 or n16), optionally by mnemonic prefix. Example: {\"value\": \"3C\", \"mnemonic\": \"cp\"} finds every CP A, $3C.",
              json!({"value": int("The immediate value"), "mnemonic": st("Text prefix, spaces ignored: \"cp\", \"ld a\", \"ld hl\""), "banks": banks, "limit": int("Max hits (default 100)")}), &["value"]),
            t("function_bounds", "Explore one function from its entry (following local branches until RET/JP or an illegal opcode): extent, callees (incl. far calls and tail jumps), exits, JP HL jump tables, illegal opcodes reached.",
              json!({"addr": loc(addr)}), &["addr"]),
            t("table_entries", "List a table of little-endian 16-bit pointers with each target's label: a declared jumptable/pointers label, or any ROM address with \"entries\". Example: {\"addr\": \"01:5000\", \"entries\": 6}.",
              json!({"addr": loc(addr), "entries": int("Entry count (default: the label's)"), "target_bank": int("Bank of targets in $4000-$7FFF (default: the label's, else the table's own bank)")}), &["addr"]),
            t("callgraph", "Callees of a function, recursively to a depth (bank-aware; far-call conventions honoured; a declared jumptable loaded with LD rr, Table adds its entries).",
              json!({"addr": loc(addr), "depth": int("Levels (default 2, max 8)")}), &["addr"]),
            t("text_decode", "Decode text with a .tbl charmap (the DB's, or \"charmap\"). Example: {\"addr\": \"0A:5000\", \"terminator\": \"FF\"}.",
              json!({"addr": loc(addr), "len": int("Max bytes (default 256, 1024 with a terminator)"), "terminator": int("Stop after this byte"), "charmap": st("Path of a .tbl file (overrides the DB's)")}), &["addr"]),
            t("label_set", "Name a location in the shared knowledge DB (seen by every agent). A name already used elsewhere moves here. Example: {\"addr\": \"00:1A2B\", \"name\": \"Memcpy\", \"comment\": \"copy BC bytes from HL to DE\"}, a sized table {\"addr\": \"01:5000\", \"name\": \"Sines\", \"kind\": \"data\", \"size\": 64}, a jump table {\"addr\": \"01:5100\", \"name\": \"StateTable\", \"kind\": \"jumptable\", \"entries\": 6}, or {\"labels\": [{\"addr\": .., \"name\": ..}, ...]}.",
              json!({"addr": loc("\"BB:AAAA\" (bank required in $4000-$7FFF / $D000-$DFFF)"), "name": st("Label name (no spaces, not a hex number)"),
                     "kind": st("code | data | ram | jumptable | pointers (default: code in ROM, ram elsewhere). Non-code regions are skipped by the xref sweep: for their size, else up to the next label. jumptable/pointers: 16-bit LE entries, each a reference from the table (xrefs kind table); jumptable entries are also callees"),
                     "size": int("Bytes the region takes: the sweep resumes code right after it (default for tables: entries * 2)"),
                     "entries": int("jumptable/pointers: number of 16-bit entries"),
                     "target_bank": int("jumptable/pointers: ROM bank of entries in $4000-$7FFF (default: the table's bank; from bank 0 the bank is unknown)"),
                     "comment": st("Optional comment"), "labels": list("Batch: [{addr, name, kind?, size?, entries?, target_bank?, comment?}]", obj_items.clone())}), &[]),
            t("label_delete", "Remove the label at a location.", json!({"addr": loc(addr)}), &["addr"]),
            t("label_search", "Search labels by substring (case-insensitive) or regex. Example: {\"query\": \"^Mem\", \"regex\": true}. With near: the labels at or before a location (nearest first, with offset) and the next one after, in its bank and region: {\"near\": \"02:4F10\", \"kind\": \"code\"} answers which routine contains it.",
              json!({"query": st("Substring or regex; empty lists all"), "regex": bo("Treat query as a regex"), "kind": st("code|data|ram|jumptable|pointers"), "in_comments": bo("Also search comments"), "near": loc("A location: return the labels around it instead (limit: how many before, default 1)"), "limit": int("Max results (default 200; 1 with near)")}), &[]),
            t("comment_set", "Attach a comment to a location (shown in disasm). Empty text removes it.",
              json!({"addr": loc(addr), "text": st("Comment")}), &["addr"]),
            t("farcall_set", "Declare a far-call convention so xrefs/disasm/callgraph/function_bounds resolve cross-bank calls. inline: {\"name\": \"farcall\", \"via\": \"00:0008\", \"kind\": \"inline\", \"layout\": [\"bank\", \"lo\", \"hi\"]} (a CALL/RST to via is followed by those bytes, skipped by the sweep). A fixed bank instead of a bank byte: {\"name\": \"fixedcall\", \"via\": \"00:0010\", \"kind\": \"inline\", \"layout\": [\"lo\", \"hi\"], \"bank\": \"02\"}. regs: {\"name\": \"bankcall\", \"via\": \"00:1234\", \"kind\": \"regs\", \"bank_reg\": \"a\", \"addr_reg\": \"hl\"} (ld a,bank ; ld hl,addr ; call via; registers known only from immediates, copies and xor a since the last call/unconditional jump/label).",
              json!({"name": st("Convention name"), "via": loc("The trampoline routine"), "kind": st("inline | regs"), "layout": list("inline: order of the inline bytes, items bank|lo|hi|skip (bank left out when \"bank\" is given)", json!({"type": "string", "enum": ["bank", "lo", "hi", "skip"]})), "bank": int("A fixed target bank (hex string or number) for conventions that don't pass one"), "bank_reg": st("regs: a|b|c|d|e|h|l (default a)"), "addr_reg": st("regs: bc|de|hl (default hl)")}), &["name", "via", "kind"]),
            t("farcall_delete", "Remove a far-call convention.", json!({"name": st("Convention name")}), &["name"]),
            t("charmap_set", "Set the .tbl charmap file used by text_decode (\"\" clears). The file stays wherever the user keeps it.",
              json!({"path": st("Path of the .tbl file")}), &["path"]),
            t("db_dump", "The knowledge DB entry for the open ROM (all: the whole file).", json!({"all": bo("Every ROM in the file")}), &[]),
            t("emu_boot", "Power on a fresh session (post-boot state, boot ROM skipped) and run frames with an input script.",
              json!({"frames": int("Frames to run (default 0, max 10800)"), "inputs": inputs.clone()}), &[]),
            t("run", "Run frames with an input script; stops early at a breakpoint or watchpoint (reports pc, bank, caller).",
              json!({"frames": int("Frames (default 60, max 10800)"), "inputs": inputs}), &[]),
            t("step", "Single-step instructions; stops at a breakpoint or after an instruction that reads/writes a watchpoint (as run does).",
              json!({"count": int("Instructions (default 1, max 10000000)")}), &[]),
            t("input", "Press buttons for `hold` frames, then run `after` more frames.",
              json!({"buttons": json!({"type": ["string", "array"], "items": str_items, "description": "\"a\", \"start\", \"a+b\" or [\"up\", \"a\"]"}), "hold": int("Frames held (default 5)"), "after": int("Frames after release (default 0; hold + after at most 10800)")}), &["buttons"]),
            t("call_routine", "Call one routine: push a sentinel return address, jump, step the whole machine (VBlank waits and interrupts complete) until it returns; on return PC and SP go back to where the session was. Example: {\"addr\": \"00:1A2B\", \"regs\": {\"a\": 2}, \"stubs\": [{\"addr\": \"00:1A40\", \"regs\": {\"a\": \"FF\"}}]}.",
              json!({
                  "addr": loc("Routine entry"), "from_slot": st("Restore this state slot first (isolated calls)"),
                  "regs": obj("{\"a\": .., \"bc\": .., \"sp\": .., \"flags\": {\"z\": true}, \"ime\": false}"),
                  "writes": list("[{\"addr\": \"C000\", \"bytes\": \"01 02\"}] applied before the call", obj_items.clone()),
                  "stubs": list("[{\"addr\": .., \"regs\": {..}}]: on reaching addr, emulate RET then set regs", obj_items.clone()),
                  "forces": list("[{\"addr\": .., \"bytes\": ..}]: rewritten before every instruction (pins a variable)", obj_items.clone()),
                  "breakpoints": list("Locations to stop at", json!({"type": ["string", "integer"]})),
                  "watch": list("[{\"addr\": .., \"len\": n}]: log value changes with pc (len up to 4096)", obj_items.clone()),
                  "dumps": list("[{\"addr\": .., \"len\": n}] read after the call (len up to 65536)", obj_items),
                  "max_steps": int("Default 5000000, max 50000000"), "trace": json!({"type": ["boolean", "integer"], "description": "Log calls/rst/irq/stub hits/bank switches (true or a cap)"}),
                  "trace_steps": int("Also log the first N instructions"), "ime": json!({"type": ["boolean", "integer"], "description": "Override IME"}), "rom_bank": int("Map this ROM bank first"),
                  "svbk": int("Write SVBK ($FF70) first"), "sentinel": int("Return address used (default FEFF)"),
              }), &["addr"]),
            t("mem_read", "Read memory (live session; ROM reads work without one). \"BB:AAAA\" reads that ROM or WRAM bank without remapping; \"vram1:8000\" a VRAM bank and \"sram2:A000\" a cartridge RAM bank (hex), whatever is mapped and enabled.",
              json!({"addr": loc(addr), "len": int("Bytes (default 16)")}), &["addr"]),
            t("mem_write", "Write memory in the session (ROM-area writes reach the MBC registers). \"BB:DXXX\" writes that WRAM bank, \"vram1:8000\" / \"sram2:A000\" that VRAM / cartridge RAM bank.",
              json!({"addr": loc(addr), "bytes": json!({"type": ["string", "array", "integer"], "items": {"type": ["integer", "string"]}, "description": "\"01 02 FF\" or [1, 2, \"FF\"]"})}), &["addr", "bytes"]),
            t("regs_get", "CPU registers, flags, IME, ROM/WRAM banks, pc and stack top with labels.", json!({}), &[]),
            t("regs_set", "Set registers.", json!({"regs": obj("{\"a\": \"12\", \"hl\": \"C000\", \"pc\": \"0150\", \"flags\": {\"c\": true}}")}), &["regs"]),
            t("state_save", "Save the session into a named in-memory slot.", json!({"slot": st("Slot name (default \"default\")")}), &[]),
            t("state_load", "Restore the session from a slot, and the picture saved with it (a slot imported from a file has none: see the note).", json!({"slot": st("Slot name (default \"default\")")}), &[]),
            t("state_export", "Write the session (or a slot) to a save-state file (never inside a git repository).",
              json!({"path": st("File path"), "slot": st("Export this slot instead of the session")}), &["path"]),
            t("state_import", "Load a save-state file into the session (or into a slot).",
              json!({"path": st("File path"), "slot": st("Import into this slot instead")}), &["path"]),
            t("breakpoint_set", "Stop run/step before the instruction at a location (bank-aware).", json!({"addr": loc(addr)}), &["addr"]),
            t("breakpoint_clear", "Remove a breakpoint (no addr: all).", json!({"addr": loc(addr)}), &[]),
            t("watchpoint_set", "Stop run/step when the CPU reads/writes a range; reports value, pc+bank and caller. \"BB:AAAA\" / \"vram1:8000\" fire only while that bank is mapped.",
              json!({"addr": loc(addr), "len": int("Bytes (default 1)"), "kind": st("read | write | access (default write)")}), &["addr"]),
            t("watchpoint_clear", "Remove watchpoints starting at addr, in that bank when given (no addr: all).", json!({"addr": loc(addr)}), &[]),
            t("screenshot", "The current screen as a PNG image.", json!({"scale": int("1-8 (default 2)")}), &[]),
        ]
    })
}
