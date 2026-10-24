//! End-to-end tests on synthetic ROMs assembled by hand below (a valid header, no game data).

use std::io::Cursor;
use std::path::PathBuf;
use std::sync::atomic::{AtomicU32, Ordering};

use gb_mcp::db::{Db, Label};
use gb_mcp::{serve, Server};
use serde_json::{json, Value};

fn tmp(name: &str) -> PathBuf {
    static N: AtomicU32 = AtomicU32::new(0);
    let d = std::env::temp_dir().join(format!("gb-mcp-test-{}-{}", std::process::id(), N.fetch_add(1, Ordering::SeqCst)));
    std::fs::create_dir_all(&d).unwrap();
    d.join(name)
}

/// A ROM of `banks` 16 KiB banks: `nop ; jp $0150` at the entry, a main loop at $0150 that
/// stores A to $C010 and increments it, `code` placed at file offsets, header checksum fixed.
fn rom(cart: u8, banks: usize, code: &[(usize, &[u8])]) -> PathBuf {
    let mut r = vec![0u8; banks * 0x4000];
    r[0x100..0x104].copy_from_slice(&[0x00, 0xC3, 0x50, 0x01]);
    r[0x134..0x13C].copy_from_slice(b"SYNTHROM");
    r[0x147] = cart;
    r[0x148] = (banks / 2).trailing_zeros() as u8;
    // $0150: ld [$C010], a ; inc a ; jr $0150
    r[0x150..0x156].copy_from_slice(&[0xEA, 0x10, 0xC0, 0x3C, 0x18, 0xFA]);
    for (off, b) in code {
        r[*off..*off + b.len()].copy_from_slice(b);
    }
    r[0x14D] = r[0x134..0x14D].iter().fold(0u8, |c, &b| c.wrapping_sub(b).wrapping_sub(1));
    let p = tmp("synth.gbc");
    std::fs::write(&p, r).unwrap();
    p
}

fn bank(n: usize, addr: usize) -> usize {
    n * 0x4000 + (addr - 0x4000)
}

/// The routines most tests use, in an MBC5 ROM of 4 banks.
fn test_rom() -> PathBuf {
    rom(0x19, 4, &[
        (0x0008, &[0xC9]), // rst $08: inline far-call trampoline
        // $0160: ld a,[$C000] ; ld hl,$C001 ; add a,[hl] ; swap a ; bit 7,[hl] ; ld [$C002],a ; ret
        (0x0160, &[0xFA, 0x00, 0xC0, 0x21, 0x01, 0xC0, 0x86, 0xCB, 0x37, 0xCB, 0x7E, 0xEA, 0x02, 0xC0, 0xC9]),
        // $0200: rst $08 / db 02, 05, 40 ; ld a,$03 ; ld hl,$4000 ; call $0280 ; call $4005 ; ret
        (0x0200, &[0xCF, 0x02, 0x05, 0x40, 0x3E, 0x03, 0x21, 0x00, 0x40, 0xCD, 0x80, 0x02, 0xCD, 0x05, 0x40, 0xC9]),
        (0x0280, &[0xC9]), // regs far-call trampoline
        // $0300: C002 = C000 + C001, A = sum
        (0x0300, &[0xFA, 0x00, 0xC0, 0x47, 0xFA, 0x01, 0xC0, 0x80, 0xEA, 0x02, 0xC0, 0xC9]),
        // $0320: call $0340 ; ld b,a ; ld a,[$C001] ; add a,b ; ld [$C002],a ; ret
        (0x0320, &[0xCD, 0x40, 0x03, 0x47, 0xFA, 0x01, 0xC0, 0x80, 0xEA, 0x02, 0xC0, 0xC9]),
        (0x0340, &[0xFA, 0x03, 0xC0, 0xC9]), // ld a,[$C003] ; ret
        (0x0400, &[0x41, 0x42, 0x43, 0x41, 0x50, 0x41, 0x99]), // text
        // bank 2 $4000: call $4005 ; jr $4000 ; $4005: ret
        (bank(2, 0x4000), &[0xCD, 0x05, 0x40, 0x18, 0xFB, 0xC9]),
        (bank(3, 0x4000), &[0x3E, 0x07, 0xC9]), // bank 3 $4000: ld a,$07 ; ret
    ])
}

fn server() -> (Server, PathBuf) {
    let db = tmp("knowledge.json");
    (Server::new(Db::open(Some(db.clone())).unwrap()), db)
}

/// A tools/call through the JSON-RPC handler; returns the parsed JSON text, or Err(text).
fn call(s: &mut Server, name: &str, args: Value) -> Result<Value, String> {
    let r = s.handle(&json!({"jsonrpc": "2.0", "id": 1, "method": "tools/call", "params": {"name": name, "arguments": args}})).unwrap();
    let res = &r["result"];
    let text = res["content"][0]["text"].as_str().unwrap_or("").to_string();
    if res["isError"] == true {
        Err(text)
    } else {
        Ok(serde_json::from_str(&text).unwrap())
    }
}

fn ok(s: &mut Server, name: &str, args: Value) -> Value {
    call(s, name, args.clone()).unwrap_or_else(|e| panic!("{name} {args}: {e}"))
}

fn open(s: &mut Server, p: &PathBuf) -> Value {
    ok(s, "rom_open", json!({"path": p}))
}

#[test]
fn protocol_round_trip() {
    let p = test_rom();
    let input = [
        json!({"jsonrpc": "2.0", "id": 1, "method": "initialize", "params": {"protocolVersion": "2025-06-18", "capabilities": {}, "clientInfo": {"name": "t", "version": "1"}}}).to_string(),
        json!({"jsonrpc": "2.0", "method": "notifications/initialized"}).to_string(),
        json!({"jsonrpc": "2.0", "id": 2, "method": "tools/list"}).to_string(),
        json!({"jsonrpc": "2.0", "id": 3, "method": "tools/call", "params": {"name": "rom_open", "arguments": {"path": p}}}).to_string(),
        json!({"jsonrpc": "2.0", "id": 4, "method": "tools/call", "params": {"name": "nope", "arguments": {}}}).to_string(),
        json!({"jsonrpc": "2.0", "id": 5, "method": "ping"}).to_string(),
        "{not json".into(),
        json!({"jsonrpc": "2.0", "id": "x", "method": "resources/list"}).to_string(),
        json!({"jsonrpc": "2.0", "id": 6, "method": "tools/call", "params": {"name": "disasm", "arguments": {"addr": "zz:zz"}}}).to_string(),
    ]
    .join("\n");
    let (mut s, _) = server();
    let mut out = vec![];
    serve(&mut s, Cursor::new(input), &mut out).unwrap();
    let lines: Vec<Value> = String::from_utf8(out).unwrap().lines().map(|l| serde_json::from_str(l).unwrap()).collect();
    assert_eq!(lines.len(), 8, "the notification gets no answer");
    assert_eq!(lines[0]["id"], 1);
    assert_eq!(lines[0]["result"]["protocolVersion"], "2025-06-18");
    assert!(lines[0]["result"]["capabilities"]["tools"].is_object());
    assert_eq!(lines[0]["result"]["serverInfo"]["name"], "gb-mcp");
    let tools = lines[1]["result"]["tools"].as_array().unwrap();
    assert!(tools.len() >= 30);
    for t in tools {
        assert_eq!(t["inputSchema"]["type"], "object", "{}", t["name"]);
        assert!(t["description"].as_str().unwrap().len() > 10);
    }
    let header: Value = serde_json::from_str(lines[2]["result"]["content"][0]["text"].as_str().unwrap()).unwrap();
    assert_eq!(header["title_ascii"].as_str().unwrap().trim_end_matches('.'), "SYNTHROM");
    assert_eq!(header["banks"], 4);
    assert_eq!(header["cart_type"], "19 MBC5");
    assert_eq!(header["header_checksum_ok"], true);
    assert_eq!(header["sha1"].as_str().unwrap().len(), 40);
    assert_eq!(lines[3]["error"]["code"], -32602);
    assert_eq!(lines[4]["result"], json!({}));
    assert_eq!(lines[5]["error"]["code"], -32700);
    assert_eq!(lines[6]["id"], "x");
    assert_eq!(lines[6]["error"]["code"], -32601);
    assert_eq!(lines[7]["result"]["isError"], true, "a tool failure is a tool result, not a protocol error");
}

#[test]
fn disasm_banked_with_labels_and_cb_opcodes() {
    let (mut s, _) = server();
    open(&mut s, &test_rom());
    ok(&mut s, "label_set", json!({"labels": [{"addr": "00:C002", "name": "wSum"}, {"addr": "02:4005", "name": "Helper", "comment": "does nothing"}]}));
    let l = ok(&mut s, "disasm", json!({"addr": "00:0160", "until_ret": true}));
    let l: Vec<&str> = l.as_array().unwrap().iter().map(|x| x.as_str().unwrap()).collect();
    assert_eq!(l, [
        "00:0160  FA00C0     LD A, [$C000]",
        "00:0163  2101C0     LD HL, $C001",
        "00:0166  86         ADD A, [HL]",
        "00:0167  CB37       SWAP A",
        "00:0169  CB7E       BIT 7, [HL]",
        "00:016B  EA02C0     LD [wSum], A",
        "00:016E  C9         RET",
    ]);
    let l = ok(&mut s, "disasm", json!({"addr": "02:4000", "count": 3}));
    assert_eq!(l, json!(["02:4000  CD0540     CALL Helper", "02:4003  18FB       JR $4000", "Helper:", "02:4005  C9         RET  ; does nothing"]));
    // Same address, other bank.
    let l = ok(&mut s, "disasm", json!({"addr": "03:4000", "count": 1}));
    assert_eq!(l, json!(["03:4000  3E07       LD A, $07"]));
    // The cartridge header is not code.
    let l = ok(&mut s, "disasm", json!({"addr": "0100", "count": 4}));
    assert_eq!(l[2], "00:0104  (cartridge header to $014F: see rom_open)");
    assert_eq!(l[3], "00:0150  EA10C0     LD [$C010], A");
    // A label is a location too.
    assert_eq!(ok(&mut s, "disasm", json!({"addr": "Helper", "count": 1}))[1], "02:4005  C9         RET  ; does nothing");
}

#[test]
fn xrefs_and_far_call_conventions() {
    let (mut s, _) = server();
    open(&mut s, &test_rom());
    ok(&mut s, "label_set", json!({"addr": "02:4005", "name": "Helper"}));
    // Before declaring conventions: only the same-bank call and the ambiguous bank-0 call.
    let x = ok(&mut s, "xrefs", json!({"target": "Helper"}));
    assert_eq!(x["count"], 2, "{x}");
    ok(&mut s, "farcall_set", json!({"name": "farcall", "via": "00:0008", "kind": "inline", "layout": ["bank", "lo", "hi"]}));
    ok(&mut s, "farcall_set", json!({"name": "bankcall", "via": "00:0280", "kind": "regs", "bank_reg": "a", "addr_reg": "hl"}));
    let x = ok(&mut s, "xrefs", json!({"target": "02:4005"}));
    let refs = x["refs"].as_array().unwrap();
    assert_eq!(x["count"], 3, "{x}");
    assert!(refs.contains(&json!({"from": "00:0200", "kind": "far:farcall", "insn": "RST $08"})), "{x}");
    assert!(refs.contains(&json!({"from": "02:4000", "kind": "call", "insn": "CALL Helper"})), "{x}");
    assert!(refs.contains(&json!({"from": "00:020C", "kind": "call", "ambiguous_bank": true, "insn": "CALL $4005"})), "{x}");
    let x = ok(&mut s, "xrefs", json!({"target": "03:4000", "kind": "far"}));
    assert_eq!(x["refs"], json!([{"from": "00:0209", "kind": "far:bankcall", "insn": "CALL $0280"}]), "{x}");
    // Not visible from the other bank.
    assert_eq!(ok(&mut s, "xrefs", json!({"target": "01:4005"}))["count"], 1, "only the ambiguous bank-0 call");
    // The inline bytes are consumed by the disassembler, and annotated.
    let l = ok(&mut s, "disasm", json!({"addr": "00:0200", "count": 2}));
    assert_eq!(l[0], "00:0200  CF020540   RST $08  ; far:farcall -> 02:4005 Helper");
    assert_eq!(l[1], "00:0204  3E03       LD A, $03");
    let g = ok(&mut s, "callgraph", json!({"addr": "00:0200", "depth": 2}));
    let root = &g["nodes"][0]["callees"];
    assert!(root.as_array().unwrap().contains(&json!("02:4005 Helper (far:farcall)")), "{g}");
    assert!(root.as_array().unwrap().contains(&json!("03:4000 (far:bankcall)")), "{g}");
    assert_eq!(g["unresolved_bank_callees"], 1);
    // Plain call targets are found too.
    let x = ok(&mut s, "xrefs", json!({"target": "00:0340"}));
    assert_eq!(x["refs"], json!([{"from": "00:0320", "kind": "call", "insn": "CALL $0340"}]));
    let f = ok(&mut s, "function_bounds", json!({"addr": "00:0320"}));
    assert_eq!(f["callees"][0]["to"], "00:0340");
    assert_eq!(f["exits"], json!(["00:032B"]));
    assert_eq!(f["bytes"], 12);
}

#[test]
fn searches_and_text() {
    let (mut s, _) = server();
    open(&mut s, &test_rom());
    let f = ok(&mut s, "find_bytes", json!({"pattern": "CD ?? 03"}));
    assert_eq!(f["hits"], json!(["00:0320"]));
    let f = ok(&mut s, "find_immediate", json!({"value": "07", "mnemonic": "ld a"}));
    assert_eq!(f["hits"], json!([{"at": "03:4000", "insn": "LD A, $07"}]), "{f}");
    let f = ok(&mut s, "find_immediate", json!({"value": "C001", "banks": "00"}));
    assert_eq!(f["count"], 3, "{f}");
    let tbl = tmp("text.tbl");
    std::fs::write(&tbl, "# test charmap\n41=A\n42=B\n4243=<BC>\n").unwrap();
    ok(&mut s, "charmap_set", json!({"path": tbl}));
    let t = ok(&mut s, "text_decode", json!({"addr": "00:0400", "terminator": "50"}));
    assert_eq!(t["text"], "A<BC>A");
    assert_eq!(t["bytes"], 5);
    let t = ok(&mut s, "text_decode", json!({"addr": "00:0405", "len": 2}));
    assert_eq!(t["text"], "A[99]");
}

#[test]
fn knowledge_db_persists_and_merges_concurrent_writers() {
    let (mut s, db) = server();
    let h = open(&mut s, &test_rom());
    let sha = h["sha1"].as_str().unwrap().to_string();
    ok(&mut s, "label_set", json!({"addr": "00:0300", "name": "AddBytes", "comment": "C002 = C000 + C001"}));
    // Another process (another Db on the same file, loaded before) writes: both survive.
    let mut a = Db::open(Some(db.clone())).unwrap();
    let mut b = Db::open(Some(db.clone())).unwrap();
    a.update(&sha, |k| Ok(k.labels.insert("00:0320".into(), Label { name: "FromA".into(), kind: "code".into(), ..Label::default() }))).unwrap();
    b.update(&sha, |k| Ok(k.labels.insert("00:0340".into(), Label { name: "FromB".into(), kind: "code".into(), ..Label::default() }))).unwrap();
    let threads: Vec<_> = (0..8)
        .map(|t| {
            let (db, sha) = (db.clone(), sha.clone());
            std::thread::spawn(move || {
                let mut d = Db::open(Some(db)).unwrap();
                for i in 0..20 {
                    let key = format!("00:{:04X}", 0x1000 + t * 0x100 + i);
                    d.update(&sha, |k| Ok(k.labels.insert(key, Label { name: format!("T{t}_{i}"), kind: "code".into(), ..Label::default() }))).unwrap();
                }
            })
        })
        .collect();
    threads.into_iter().for_each(|t| t.join().unwrap());
    // The server sees the other writers' labels without being told.
    let r = ok(&mut s, "label_search", json!({"query": "^(AddBytes|From[AB])$", "regex": true}));
    assert_eq!(r["count"], 3, "{r}");
    assert_eq!(ok(&mut s, "label_search", json!({"query": "t3_"}))["count"], 20);
    assert_eq!(ok(&mut s, "disasm", json!({"addr": "00:0320", "count": 1}))[1], "00:0320  CD4003     CALL FromB");
    // Reopened from disk: everything is there, keyed by the ROM's SHA-1.
    let k = Db::open(Some(db.clone())).unwrap().knowledge(&sha);
    assert_eq!(k.labels.len(), 3 + 160);
    assert_eq!(k.comments["00:0300"], "C002 = C000 + C001");
    // Renaming moves a name; delete and comments by label.
    let r = ok(&mut s, "label_set", json!({"addr": "00:0301", "name": "AddBytes"}));
    assert_eq!(r["moved"], json!([{"name": "AddBytes", "from": "00:0300"}]));
    ok(&mut s, "comment_set", json!({"addr": "AddBytes", "text": "moved"}));
    assert_eq!(ok(&mut s, "label_delete", json!({"addr": "00:0301"}))["removed"], "AddBytes");
    assert!(call(&mut s, "label_set", json!({"addr": "4000", "name": "NoBank"})).unwrap_err().contains("banked"));
    let dump = ok(&mut s, "db_dump", json!({}));
    assert_eq!(dump["knowledge"]["comments"]["00:0301"], "moved");
}

#[test]
fn call_routine_with_stubs_forces_and_slots() {
    let (mut s, _) = server();
    open(&mut s, &test_rom());
    ok(&mut s, "emu_boot", json!({"frames": 2}));
    ok(&mut s, "state_save", json!({"slot": "s0"}));
    let r = ok(&mut s, "call_routine", json!({"addr": "00:0300", "writes": [{"addr": "C000", "bytes": "02 03"}], "dumps": [{"addr": "C002"}]}));
    assert_eq!(r["stop_reason"], "returned");
    assert_eq!(r["regs"]["a"], "05");
    assert_eq!(r["dumps"][0]["hex"], "05");
    // The getter at $0340 is stubbed to return 7, and C001 is pinned to $0A despite the write.
    let r = ok(&mut s, "call_routine", json!({
        "addr": "00:0320", "from_slot": "s0", "writes": [{"addr": "C001", "bytes": "01"}],
        "stubs": [{"addr": "00:0340", "regs": {"a": 7}}], "forces": [{"addr": "C001", "bytes": "0A"}],
        "dumps": [{"addr": "C002"}], "trace": true, "watch": [{"addr": "C002"}],
    }));
    assert_eq!(r["stop_reason"], "returned", "{r}");
    assert_eq!(r["regs"]["a"], "11");
    assert_eq!(r["stub_hits"], 1);
    assert_eq!(r["trace"][0]["kind"], "call");
    assert_eq!(r["watch"][0]["new"], "11");
    assert_eq!(r["watch"][0]["pc"], "00:0328");
    let r = ok(&mut s, "call_routine", json!({"addr": "00:0320", "from_slot": "s0", "breakpoints": ["00:0323"]}));
    assert_eq!(r["stop_reason"], "breakpoint 00:0323");
}

#[test]
fn run_stops_at_breakpoints_and_watchpoints() {
    let (mut s, _) = server();
    open(&mut s, &test_rom());
    ok(&mut s, "emu_boot", json!({}));
    ok(&mut s, "label_set", json!({"addr": "00:C010", "name": "wCounter"}));
    ok(&mut s, "watchpoint_set", json!({"addr": "wCounter"}));
    let r = ok(&mut s, "run", json!({"frames": 5}));
    assert_eq!(r["stop"]["reason"], "watchpoint", "{r}");
    assert_eq!(r["stop"]["addr"], "00:C010 wCounter");
    assert_eq!(r["stop"]["pc"], "00:0150");
    ok(&mut s, "watchpoint_clear", json!({}));
    ok(&mut s, "breakpoint_set", json!({"addr": "00:0154"}));
    let r = ok(&mut s, "run", json!({"frames": 5}));
    assert_eq!(r["stop"]["reason"], "breakpoint", "{r}");
    assert_eq!(r["regs"]["pc"], "00:0154");
    let r = ok(&mut s, "step", json!({"count": 3}));
    assert_eq!(r["executed"][0], "00:0154  JR $0150");
    assert_eq!(r["steps"], 3);
    ok(&mut s, "breakpoint_clear", json!({}));
    let r = ok(&mut s, "run", json!({"frames": 3}));
    assert_eq!(r["frames_run"], 3);
    let m = ok(&mut s, "mem_write", json!({"addr": "02:D000", "bytes": "AA BB"}));
    assert_eq!(m["now"], "AA BB");
    assert_eq!(ok(&mut s, "mem_read", json!({"addr": "02:D000", "len": 2}))["rows"][0].as_str().unwrap().split("  ").nth(1).unwrap().trim(), "AA BB");
    assert_eq!(ok(&mut s, "regs_set", json!({"regs": {"a": "42", "flags": {"c": true}}}))["flags"]["c"], true);
    assert_eq!(ok(&mut s, "regs_get", json!({}))["a"], "42");
    let state = tmp("x.state");
    ok(&mut s, "state_export", json!({"path": state}));
    ok(&mut s, "regs_set", json!({"regs": {"a": "00"}}));
    ok(&mut s, "state_import", json!({"path": state}));
    assert_eq!(ok(&mut s, "regs_get", json!({}))["a"], "42");
}

fn unbase64(s: &str) -> Vec<u8> {
    let val = |c: u8| match c {
        b'A'..=b'Z' => c - b'A',
        b'a'..=b'z' => c - b'a' + 26,
        b'0'..=b'9' => c - b'0' + 52,
        b'+' => 62,
        _ => 63,
    };
    let mut out = vec![];
    for ch in s.as_bytes().chunks(4) {
        let n = ch.iter().take_while(|&&c| c != b'=').fold(0u32, |n, &c| n << 6 | val(c) as u32) << (6 * ch.iter().filter(|&&c| c == b'=').count());
        let k = 3 - ch.iter().filter(|&&c| c == b'=').count();
        out.extend_from_slice(&n.to_be_bytes()[1..1 + k]);
    }
    out
}

#[test]
fn screenshot_is_a_png_image() {
    let (mut s, _) = server();
    open(&mut s, &test_rom());
    ok(&mut s, "emu_boot", json!({"frames": 3}));
    let r = s.handle(&json!({"jsonrpc": "2.0", "id": 9, "method": "tools/call", "params": {"name": "screenshot", "arguments": {"scale": 2}}})).unwrap();
    let c = &r["result"]["content"][0];
    assert_eq!(c["type"], "image");
    assert_eq!(c["mimeType"], "image/png");
    let png = unbase64(c["data"].as_str().unwrap());
    let dec = png::Decoder::new(Cursor::new(png));
    let reader = dec.read_info().unwrap();
    assert_eq!((reader.info().width, reader.info().height), (320, 288));
}

#[test]
fn base64_matches_known_vectors() {
    assert_eq!(gb_mcp::base64(b""), "");
    assert_eq!(gb_mcp::base64(b"f"), "Zg==");
    assert_eq!(gb_mcp::base64(b"fo"), "Zm8=");
    assert_eq!(gb_mcp::base64(b"foobar"), "Zm9vYmFy");
    assert_eq!(unbase64("Zm9vYg=="), b"foob");
}

#[test]
fn review_regressions() {
    let (mut s, db) = server();
    let h = open(&mut s, &test_rom());
    // A RAM label in bank 0 sits above a banked address in the label map: no underflow (debug).
    ok(&mut s, "label_set", json!({"addr": "C000", "name": "wVar"}));
    ok(&mut s, "find_bytes", json!({"pattern": "C9", "banks": "02"}));
    ok(&mut s, "mem_read", json!({"addr": "01:4000"}));
    // Hex-looking label names would hide addresses.
    for n in ["1234", "Add", "$Cafe", "0xBE"] {
        assert!(call(&mut s, "label_set", json!({"addr": "00:0300", "name": n})).unwrap_err().contains("hex"), "{n}");
    }
    // Banks that don't exist are errors, not empty results.
    for (t, a) in [("disasm", json!({"addr": "04:4000"})), ("xrefs", json!({"target": "FFFF:4000"})), ("function_bounds", json!({"addr": "FF:7FFE"})),
                   ("find_bytes", json!({"pattern": "C9", "banks": "10000"})), ("find_bytes", json!({"pattern": "C9", "banks": "04"})),
                   ("mem_write", json!({"addr": "08:D000", "bytes": "AA"})), ("disasm", json!({"addr": "1:10000"}))] {
        assert!(call(&mut s, t, a.clone()).is_err(), "{t} {a}");
    }
    // Per-call caps, and lengths clamped.
    assert!(call(&mut s, "emu_boot", json!({"frames": 4_000_000_000u32})).unwrap_err().contains("at most"));
    assert!(call(&mut s, "input", json!({"buttons": "a", "hold": 30000, "after": 30000})).is_err());
    assert!(call(&mut s, "call_routine", json!({"addr": "00:0300", "max_steps": 4_000_000_000u32})).is_err());
    let r = ok(&mut s, "call_routine", json!({"addr": "00:0300", "dumps": [{"addr": "C000", "len": 3_000_000_000u32}], "ime": 1}));
    assert_eq!(r["dumps"][0]["hex"].as_str().unwrap().len(), 0x10000 * 3 - 1);
    assert_eq!(r["regs"]["ime"], true, "ime: 1 is true");
    // After a return the session is back where it was, not on the sentinel.
    ok(&mut s, "regs_set", json!({"regs": {"pc": "0150"}}));
    let r = ok(&mut s, "call_routine", json!({"addr": "00:0300"}));
    assert_eq!(r["stop_reason"], "returned");
    assert_eq!(r["regs"]["pc"], "00:0150");
    // Reads past $7FFF without a session come from the machine, not the ROM file.
    open(&mut s, &test_rom());
    let m = ok(&mut s, "mem_read", json!({"addr": "7FF0", "len": 32}));
    assert!(m["rows"][1].as_str().unwrap().starts_with("00:8000"), "{m}");
    // WRAM banks: "BB:Dxxx" reads, writes and disassembles that bank.
    ok(&mut s, "mem_write", json!({"addr": "03:D000", "bytes": "3C C9"}));
    ok(&mut s, "label_set", json!({"addr": "03:D000", "name": "RamCode"}));
    assert_eq!(ok(&mut s, "disasm", json!({"addr": "03:D000", "count": 1})), json!(["RamCode:", "03:D000  3C         INC A"]));
    // watchpoint_clear respects the bank.
    ok(&mut s, "watchpoint_set", json!({"addr": "02:D000"}));
    ok(&mut s, "watchpoint_set", json!({"addr": "03:D000"}));
    let w = ok(&mut s, "watchpoint_clear", json!({"addr": "02:D000"}));
    assert_eq!(w["watchpoints"].as_array().unwrap().len(), 1, "{w}");
    // An illegal opcode ends a function path.
    let p = rom(0x19, 2, &[(0x0500, &[0x00, 0xD3, 0x00, 0x00])]);
    open(&mut s, &p);
    let f = ok(&mut s, "function_bounds", json!({"addr": "00:0500"}));
    assert_eq!((f["instructions"].clone(), f["illegal_opcodes"].clone(), f["truncated"].clone()), (json!(2), json!(["00:0501"]), json!(false)));
    // Keys the server doesn't know survive its writes.
    let sha = h["sha1"].as_str().unwrap();
    let mut file: Value = serde_json::from_str(&std::fs::read_to_string(&db).unwrap()).unwrap();
    file["note"] = json!("top");
    file["roms"][sha]["owner"] = json!("me");
    file["roms"][sha]["labels"]["00:C000"]["width"] = json!(2);
    std::fs::write(&db, file.to_string()).unwrap();
    open(&mut s, &test_rom());
    ok(&mut s, "label_set", json!({"addr": "00:0300", "name": "AddBytes"}));
    let file: Value = serde_json::from_str(&std::fs::read_to_string(&db).unwrap()).unwrap();
    assert_eq!((file["note"].clone(), file["roms"][sha]["owner"].clone(), file["roms"][sha]["labels"]["00:C000"]["width"].clone()), (json!("top"), json!("me"), json!(2)));
}

#[test]
fn invalid_utf8_line_is_a_parse_error() {
    let (mut s, _) = server();
    let mut input = b"\xff\xfe{}\n".to_vec();
    input.extend_from_slice(json!({"jsonrpc": "2.0", "id": 1, "method": "ping"}).to_string().as_bytes());
    let mut out = vec![];
    serve(&mut s, Cursor::new(input), &mut out).unwrap();
    let lines: Vec<Value> = String::from_utf8(out).unwrap().lines().map(|l| serde_json::from_str(l).unwrap()).collect();
    assert_eq!(lines[0]["error"]["code"], -32700);
    assert_eq!(lines[1]["result"], json!({}));
}

#[test]
fn every_array_schema_has_items() {
    let (mut s, _) = server();
    let r = s.handle(&json!({"jsonrpc": "2.0", "id": 1, "method": "tools/list"})).unwrap();
    for t in r["result"]["tools"].as_array().unwrap() {
        for (k, p) in t["inputSchema"]["properties"].as_object().unwrap() {
            let ty = &p["type"];
            if ty == "array" || ty.as_array().is_some_and(|a| a.contains(&json!("array"))) {
                assert!(p["items"].is_object(), "{}.{k}", t["name"]);
            }
        }
    }
}

/// A ROM for the sized-label, table and far-call tests (MBC5, 4 banks).
fn table_rom() -> PathBuf {
    rom(0x19, 4, &[
        (0x0010, &[0xC9]), // rst $10: fixed-bank inline far call (dw target follows)
        (0x0280, &[0xC9]), // regs far-call trampoline
        // $0600: rst $10 / dw $4005 ; ld a,$01 ; ret
        (0x0600, &[0xD7, 0x05, 0x40, 0x3E, 0x01, 0xC9]),
        // $0700: pointers into bank 3
        (0x0700, &[0x00, 0x40]),
        // $0800: ld a,3 ; ld hl,$4000 ; jr z,+0 ; call $0280 (bank kept across the conditional jump)
        (0x0800, &[0x3E, 0x03, 0x21, 0x00, 0x40, 0x28, 0x00, 0xCD, 0x80, 0x02, 0xC9]),
        // $0810: ld b,2 ; ld a,b ; ld hl,$4005 ; call $0280 (bank copied from B)
        (0x0810, &[0x06, 0x02, 0x78, 0x21, 0x05, 0x40, 0xCD, 0x80, 0x02, 0xC9]),
        (bank(1, 0x4005), &[0xC9]),
        // bank 1 $4100: rst $10 / dw $4005 ; ret
        (bank(1, 0x4100), &[0xD7, 0x05, 0x40, 0xC9]),
        // bank 1 $4200: a 4-byte table that reads as "call $4005", then unlabelled code: call $4005 ; ret
        (bank(1, 0x4200), &[0xCD, 0x05, 0x40, 0x00, 0xCD, 0x05, 0x40, 0xC9]),
        (bank(1, 0x4300), &[0xC9]),
        // bank 1 $4400: ld hl,$4410 ; ret ; $4410: dw $4420, $4430
        (bank(1, 0x4400), &[0x21, 0x10, 0x44, 0xC9]),
        (bank(1, 0x4410), &[0x20, 0x44, 0x30, 0x44]),
        (bank(1, 0x4420), &[0xC9]),
        (bank(1, 0x4430), &[0xC9]),
        (bank(2, 0x4005), &[0xC9]),
        (bank(3, 0x4000), &[0xC9]),
    ])
}

fn froms(x: &Value) -> Vec<String> {
    x["refs"].as_array().unwrap().iter().map(|r| format!("{} {}", r["from"].as_str().unwrap(), r["kind"].as_str().unwrap())).collect()
}

#[test]
fn fixed_bank_inline_far_calls() {
    let (mut s, _) = server();
    open(&mut s, &table_rom());
    let bad = call(&mut s, "farcall_set", json!({"name": "near1", "via": "00:0010", "kind": "inline", "layout": ["lo", "hi"]})).unwrap_err();
    assert!(bad.contains("bank"), "{bad}");
    assert!(call(&mut s, "farcall_set", json!({"name": "near1", "via": "00:0010", "kind": "inline", "layout": ["bank", "lo", "hi"], "bank": 1})).is_err());
    ok(&mut s, "farcall_set", json!({"name": "fixedcall", "via": "00:0010", "kind": "inline", "layout": ["lo", "hi"], "bank": "01"}));
    ok(&mut s, "label_set", json!({"addr": "01:4005", "name": "Target"}));
    let x = ok(&mut s, "xrefs", json!({"target": "Target", "kind": "far"}));
    assert_eq!(froms(&x), ["00:0600 far:fixedcall", "01:4100 Target+$FB far:fixedcall"], "{x}");
    // The inline word is skipped, and the target shown with its label.
    let l = ok(&mut s, "disasm", json!({"addr": "00:0600", "count": 2}));
    assert_eq!(l, json!(["00:0600  D70540     RST $10  ; far:fixedcall -> 01:4005 Target", "00:0603  3E01       LD A, $01"]));
    let f = ok(&mut s, "function_bounds", json!({"addr": "00:0600"}));
    assert_eq!(f["callees"][0], json!({"to": "01:4005 Target", "kind": "far:fixedcall", "at": "00:0600"}), "{f}");
    assert_eq!(f["bytes"], 6);
    let g = ok(&mut s, "callgraph", json!({"addr": "00:0600"}));
    assert_eq!(g["nodes"][0]["callees"], json!(["01:4005 Target (far:fixedcall)"]));
    // The convention is stored with its bank, and a DB written by hand with a number works too.
    assert_eq!(ok(&mut s, "db_dump", json!({}))["knowledge"]["far_calls"][0]["bank"], "01");
}

#[test]
fn regs_far_calls_follow_copies_and_conditional_jumps() {
    let (mut s, _) = server();
    open(&mut s, &table_rom());
    ok(&mut s, "farcall_set", json!({"name": "bankcall", "via": "00:0280", "kind": "regs"}));
    assert_eq!(froms(&ok(&mut s, "xrefs", json!({"target": "03:4000", "kind": "far"}))), ["00:0807 far:bankcall"]);
    assert_eq!(froms(&ok(&mut s, "xrefs", json!({"target": "02:4005", "kind": "far"}))), ["00:0816 far:bankcall"]);
    // A label between the loads and the call is a join point: the registers are forgotten there.
    ok(&mut s, "label_set", json!({"addr": "00:0805", "name": "Join"}));
    assert_eq!(ok(&mut s, "xrefs", json!({"target": "03:4000", "kind": "far"}))["count"], 0);
}

#[test]
fn sized_data_labels_resume_the_sweep() {
    let (mut s, db) = server();
    let h = open(&mut s, &table_rom());
    ok(&mut s, "label_set", json!({"addr": "01:4300", "name": "Later"}));
    // Unlabelled, the table reads as a call; labelled data without a size, it hides the code after it.
    assert_eq!(froms(&ok(&mut s, "xrefs", json!({"target": "01:4005", "kind": "call"}))), ["01:4200 call", "01:4204 call"]);
    ok(&mut s, "label_set", json!({"addr": "01:4200", "name": "Table4", "kind": "data"}));
    assert_eq!(ok(&mut s, "xrefs", json!({"target": "01:4005", "kind": "call"}))["count"], 0);
    ok(&mut s, "label_set", json!({"labels": [{"addr": "01:4200", "name": "Table4", "kind": "data", "size": 4}]}));
    assert_eq!(froms(&ok(&mut s, "xrefs", json!({"target": "01:4005", "kind": "call"}))), ["01:4204 call"]);
    let r = ok(&mut s, "label_search", json!({"query": "Table4"}));
    assert_eq!(r["results"][0]["size"], 4, "{r}");
    assert!(call(&mut s, "label_set", json!({"addr": "01:4200", "name": "T", "size": 0})).is_err());
    assert!(call(&mut s, "label_set", json!({"addr": "01:4200", "name": "T", "entries": 2})).is_err());
    // A size written by hand as a hex string is honoured.
    let sha = h["sha1"].as_str().unwrap();
    let mut file: Value = serde_json::from_str(&std::fs::read_to_string(&db).unwrap()).unwrap();
    file["roms"][sha]["labels"]["01:4200"]["size"] = json!("4");
    std::fs::write(&db, file.to_string()).unwrap();
    assert_eq!(froms(&ok(&mut s, "xrefs", json!({"target": "01:4005", "kind": "call"}))), ["01:4204 call"]);
    // near: which label a location falls in.
    let n = ok(&mut s, "label_search", json!({"near": "01:4206", "limit": 2}));
    assert_eq!((n["before"][0]["name"].clone(), n["before"][0]["offset"].clone(), n["after"]["name"].clone()), (json!("Table4"), json!("6"), json!("Later")), "{n}");
    assert_eq!(ok(&mut s, "label_search", json!({"near": "01:4206", "kind": "code"}))["before"], json!([]));
}

#[test]
fn jump_and_pointer_tables_are_references() {
    let (mut s, _) = server();
    open(&mut s, &table_rom());
    ok(&mut s, "label_set", json!({"labels": [
        {"addr": "01:4410", "name": "States", "kind": "jumptable", "entries": 2},
        {"addr": "01:4420", "name": "StateA"}, {"addr": "01:4400", "name": "Dispatch"},
        {"addr": "00:0700", "name": "Ptrs", "kind": "pointers", "entries": 1, "target_bank": "03"},
    ]}));
    assert!(call(&mut s, "label_set", json!({"addr": "01:4410", "name": "X", "kind": "jumptable"})).is_err(), "entries required");
    assert_eq!(ok(&mut s, "xrefs", json!({"target": "StateA"}))["refs"], json!([{"from": "01:4410 States", "kind": "table"}]));
    assert_eq!(froms(&ok(&mut s, "xrefs", json!({"target": "01:4430"}))), ["01:4412 States+$2 table"]);
    assert_eq!(froms(&ok(&mut s, "xrefs", json!({"target": "03:4000", "kind": "table"}))), ["00:0700 Ptrs table"]);
    // The function that loads a jumptable gets its entries as callees.
    let f = ok(&mut s, "function_bounds", json!({"addr": "Dispatch"}));
    let to: Vec<&str> = f["callees"].as_array().unwrap().iter().map(|c| c["to"].as_str().unwrap()).collect();
    assert_eq!(to, ["01:4420 StateA", "01:4430"], "{f}");
    let t = ok(&mut s, "table_entries", json!({"addr": "States"}));
    assert_eq!(t["entries"], json!([{"at": "01:4410 States", "to": "01:4420 StateA"}, {"at": "01:4412 States+$2", "to": "01:4430 StateA+$10"}]));
    let t = ok(&mut s, "table_entries", json!({"addr": "00:0700", "entries": 1, "target_bank": null}));
    assert_eq!(t["entries"][0]["to"], "03:4000", "the declared bank applies");
    let t = ok(&mut s, "table_entries", json!({"addr": "01:4410", "entries": 1, "target_bank": 2}));
    assert_eq!(t["entries"][0]["to"], "02:4420");
}

#[test]
fn batch_disasm() {
    let (mut s, _) = server();
    open(&mut s, &test_rom());
    let d = ok(&mut s, "disasm", json!({"addrs": ["00:0340", "02:4005"], "count": 1}));
    assert_eq!(d, json!([{"addr": "00:0340", "lines": ["00:0340  FA03C0     LD A, [$C003]"]}, {"addr": "02:4005", "lines": ["02:4005  C9         RET"]}]));
}

#[test]
fn step_sees_reads_and_unchanged_writes() {
    let (mut s, _) = server();
    open(&mut s, &test_rom());
    ok(&mut s, "regs_set", json!({"regs": {"pc": "0160"}}));
    ok(&mut s, "watchpoint_set", json!({"addr": "C000", "kind": "read"}));
    let r = ok(&mut s, "step", json!({"count": 10}));
    assert_eq!((r["steps"].clone(), r["stop"]["kind"].clone(), r["stop"]["pc"].clone()), (json!(1), json!("read"), json!("00:0160")), "{r}");
    ok(&mut s, "watchpoint_clear", json!({}));
    // The main loop stores A to $C010; the same value written again still stops a step.
    ok(&mut s, "mem_write", json!({"addr": "C010", "bytes": "05"}));
    ok(&mut s, "regs_set", json!({"regs": {"pc": "0150", "a": "05"}}));
    ok(&mut s, "watchpoint_set", json!({"addr": "C010"}));
    let r = ok(&mut s, "step", json!({"count": 10}));
    assert_eq!((r["steps"].clone(), r["stop"]["kind"].clone(), r["stop"]["value"].clone()), (json!(1), json!("write"), json!("05")), "{r}");
}

#[test]
fn vram_and_sram_banks() {
    let (mut s, _) = server();
    open(&mut s, &rom(0x1B, 4, &[(0x149, &[0x03])])); // MBC5+RAM+BATTERY, 32 KiB
    ok(&mut s, "mem_write", json!({"addr": "sram2:A010", "bytes": "11 22"}));
    ok(&mut s, "mem_write", json!({"addr": "vram1:8000", "bytes": "AB"}));
    let r = ok(&mut s, "mem_read", json!({"addr": "sram2:A010", "len": 2}));
    assert_eq!(r["rows"], json!(["sram2:A010  11 22"]), "{r}");
    assert!(ok(&mut s, "mem_read", json!({"addr": "sram0:A010", "len": 2}))["rows"][0].as_str().unwrap().ends_with("00 00"));
    assert_eq!(ok(&mut s, "mem_read", json!({"addr": "vram1:8000", "len": 1}))["rows"], json!(["vram1:8000  AB"]));
    assert_ne!(ok(&mut s, "mem_read", json!({"addr": "vram0:8000", "len": 1}))["rows"], json!(["vram0:8000  AB"]));
    for a in [json!({"addr": "sram4:A000"}), json!({"addr": "vram2:8000"}), json!({"addr": "vram1:9FFF", "len": 2}), json!({"addr": "sram0:8000"})] {
        assert!(call(&mut s, "mem_read", a.clone()).is_err(), "{a}");
    }
    let w = ok(&mut s, "watchpoint_set", json!({"addr": "vram1:8000"}));
    assert_eq!(w["watchpoints"][0]["addr"], "vram1:8000");
    assert!(call(&mut s, "watchpoint_set", json!({"addr": "sram1:A000"})).is_err());
    assert_eq!(ok(&mut s, "watchpoint_clear", json!({"addr": "vram0:8000"}))["watchpoints"].as_array().unwrap().len(), 1, "another bank");
    assert_eq!(ok(&mut s, "watchpoint_clear", json!({"addr": "vram1:8000"}))["watchpoints"], json!([]));
    assert_eq!(ok(&mut s, "watchpoint_set", json!({"addr": "8000"}))["watchpoints"][0]["addr"], "00:8000", "a plain address: any bank");
}

#[test]
fn mbc1_rom_bank_high_bits() {
    let (mut s, _) = server();
    open(&mut s, &rom(0x01, 64, &[(0x0300, &[0xC9])]));
    ok(&mut s, "call_routine", json!({"addr": "00:0300", "rom_bank": "21"}));
    assert_eq!(ok(&mut s, "call_routine", json!({"addr": "00:0300", "rom_bank": "05"}))["regs"]["rom_bank"], "05");
    assert!(call(&mut s, "call_routine", json!({"addr": "00:0300", "rom_bank": "20"})).unwrap_err().contains("MBC1"));
}

fn screenshot(s: &mut Server) -> Value {
    let r = s.handle(&json!({"jsonrpc": "2.0", "id": 1, "method": "tools/call", "params": {"name": "screenshot", "arguments": {"scale": 1}}})).unwrap();
    r["result"]["content"].clone()
}

#[test]
fn state_load_restores_the_picture() {
    let (mut s, _) = server();
    open(&mut s, &test_rom());
    ok(&mut s, "run", json!({"frames": 2}));
    let before = screenshot(&mut s);
    assert_eq!(before.as_array().unwrap().len(), 1, "no note on a live picture");
    ok(&mut s, "state_save", json!({"slot": "a"}));
    ok(&mut s, "mem_write", json!({"addr": "8000", "bytes": "FF FF FF FF FF FF FF FF FF FF FF FF FF FF FF FF"}));
    ok(&mut s, "run", json!({"frames": 2}));
    assert_ne!(screenshot(&mut s)[0], before[0], "tile 0 is now black");
    let l = ok(&mut s, "state_load", json!({"slot": "a"}));
    assert!(l.get("note").is_none(), "{l}");
    assert_eq!(screenshot(&mut s), before);
    // A state file holds no picture: the load says so, and so does the screenshot until frames run.
    let path = tmp("a.state");
    ok(&mut s, "state_export", json!({"path": path, "slot": "a"}));
    assert!(ok(&mut s, "state_import", json!({"path": path}))["note"].as_str().unwrap().contains("no picture"));
    assert_eq!(screenshot(&mut s)[1]["type"], "text");
    ok(&mut s, "run", json!({"frames": 2}));
    assert_eq!(screenshot(&mut s), before);
}
