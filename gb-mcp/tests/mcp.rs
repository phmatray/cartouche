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
    // Nothing reaches these routines from the vectors or a code label: flagged unreached.
    assert!(refs.contains(&json!({"from": "00:0200", "kind": "far:farcall", "insn": "RST $08", "unreached": true})), "{x}");
    assert!(refs.contains(&json!({"from": "02:4000", "kind": "call", "insn": "CALL Helper", "unreached": true})), "{x}");
    assert!(refs.contains(&json!({"from": "00:020C", "kind": "call", "ambiguous_bank": true, "insn": "CALL $4005", "unreached": true})), "{x}");
    let x = ok(&mut s, "xrefs", json!({"target": "03:4000", "kind": "far"}));
    assert_eq!(x["refs"], json!([{"from": "00:0209", "kind": "far:bankcall", "insn": "CALL $0280", "unreached": true}]), "{x}");
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
    // Plain call targets are found too; a code label makes its routine reached.
    ok(&mut s, "label_set", json!({"addr": "00:0320", "name": "Caller"}));
    let x = ok(&mut s, "xrefs", json!({"target": "00:0340"}));
    assert_eq!(x["refs"], json!([{"from": "00:0320 Caller", "kind": "call", "insn": "CALL $0340"}]));
    let f = ok(&mut s, "function_bounds", json!({"addr": "00:0320"}));
    assert_eq!(f["callees"][0]["to"], "00:0340");
    assert_eq!(f["exits"], json!(["00:032B Caller+$B"]));
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
        // bank 1 $4500: ld a,[$4410] ; ret (reads the table, doesn't dispatch through it)
        (bank(1, 0x4500), &[0xFA, 0x10, 0x44, 0xC9]),
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
    // 01:4100 is past Target's RET: not shown as Target+$FB.
    assert_eq!(froms(&x), ["00:0600 far:fixedcall", "01:4100 far:fixedcall"], "{x}");
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
    assert_eq!(t["entries"], json!([{"at": "01:4410 States", "to": "01:4420 StateA"}, {"at": "01:4412 States+$2", "to": "01:4430"}]), "past StateA's RET");
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

#[test]
fn second_review_regressions() {
    let (mut s, db) = server();
    let h = open(&mut s, &table_rom());
    let sha = h["sha1"].as_str().unwrap().to_string();
    // A data label inside a sized one is part of it, and extends it by its own size.
    ok(&mut s, "label_set", json!({"labels": [
        {"addr": "01:4200", "name": "TabA", "kind": "data", "size": 2},
        {"addr": "01:4201", "name": "TabB", "kind": "data", "size": 6},
    ]}));
    assert_eq!(ok(&mut s, "xrefs", json!({"target": "01:4005", "kind": "call"}))["count"], 0);
    // Reading a byte of a jumptable doesn't make its entries callees.
    ok(&mut s, "label_set", json!({"addr": "01:4410", "name": "States", "kind": "jumptable", "entries": 2}));
    assert_eq!(ok(&mut s, "function_bounds", json!({"addr": "01:4500"}))["callees"], json!([]));
    // Banks are checked against the ROM.
    assert!(call(&mut s, "table_entries", json!({"addr": "01:4410", "entries": 1, "target_bank": "99"})).is_err());
    assert!(call(&mut s, "farcall_set", json!({"name": "f", "via": "00:0010", "kind": "inline", "layout": ["lo", "hi"], "bank": "1FF"})).is_err());
    assert!(call(&mut s, "farcall_set", json!({"name": "f", "via": "00:0280", "kind": "regs", "bank": 1, "bank_reg": "b"})).is_err());
    // Hand-edited values: an oversized size or entry count, and keys that don't parse.
    let mut file: Value = serde_json::from_str(&std::fs::read_to_string(&db).unwrap()).unwrap();
    let labels = &mut file["roms"][&sha]["labels"];
    labels["01:4200"]["size"] = json!("FFFFFFFF");
    labels["01:4410"]["entries"] = json!(4294967295u32);
    labels["0160"] = json!({"name": "Odd", "kind": "code"});
    labels["bogus"] = json!({"name": "Odder", "kind": "code"});
    std::fs::write(&db, file.to_string()).unwrap();
    ok(&mut s, "xrefs", json!({"target": "01:4005"}));
    let r = ok(&mut s, "label_search", json!({"query": ""}));
    assert_eq!(r["count"], 5, "{r}");
}

#[test]
fn second_review_emulation_regressions() {
    let (mut s, _) = server();
    open(&mut s, &rom(0x1B, 4, &[(0x149, &[0x03])]));
    assert!(call(&mut s, "mem_read", json!({"addr": "sram10000:A000"})).is_err());
    assert_eq!(ok(&mut s, "mem_write", json!({"addr": "sram0:A000", "bytes": ""}))["written"], 0);
    // The note clears after two frames since the load, however they are run.
    ok(&mut s, "run", json!({"frames": 2}));
    let path = tmp("b.state");
    ok(&mut s, "state_export", json!({"path": path}));
    ok(&mut s, "state_import", json!({"path": path}));
    // A slot saved while the screen is stale has no picture either.
    ok(&mut s, "state_save", json!({"slot": "x"}));
    assert!(ok(&mut s, "state_load", json!({"slot": "x"}))["note"].is_string());
    ok(&mut s, "run", json!({"frames": 1}));
    assert_eq!(screenshot(&mut s).as_array().unwrap().len(), 2);
    ok(&mut s, "run", json!({"frames": 1}));
    assert_eq!(screenshot(&mut s).as_array().unwrap().len(), 1);
    // MBC1: a refused bank leaves the mapping alone.
    let (mut s, _) = server();
    open(&mut s, &rom(0x01, 64, &[(0x0300, &[0xC9])]));
    ok(&mut s, "call_routine", json!({"addr": "00:0300", "rom_bank": "05"}));
    assert!(call(&mut s, "call_routine", json!({"addr": "00:0300", "rom_bank": "20"})).is_err());
    assert_eq!(ok(&mut s, "regs_get", json!({}))["rom_bank"], "05");
}

/// A ROM for the field-feedback tests (MBC5, 4 banks). The main loop calls $0160.
fn field_rom() -> PathBuf {
    rom(0x19, 4, &[
        // $0150: call $0160 ; ld [$C010],a ; jr $0150 ; $0160: ld a,$01 ; ret
        (0x0150, &[0xCD, 0x60, 0x01, 0xEA, 0x10, 0xC0, 0x18, 0xF8]),
        (0x0160, &[0x3E, 0x01, 0xC9]),
        (0x0280, &[0xC9]), // a bank-switch routine (bank in A)
        // $0900: ld a,$02 ; ld [$2000],a ; call $4005 ; ret
        (0x0900, &[0x3E, 0x02, 0xEA, 0x00, 0x20, 0xCD, 0x05, 0x40, 0xC9]),
        // $0910: ld a,$03 ; call $0280 ; call $4000 ; ret
        (0x0910, &[0x3E, 0x03, 0xCD, 0x80, 0x02, 0xCD, 0x00, 0x40, 0xC9]),
        (0x0920, &[0xCD, 0x05, 0x40, 0xC9]), // call $4005 (bank unknown) ; ret
        // $0A00: 10 data bytes, then ret ; $0A10: two pointers ($0C00, $0920)
        (0x0A00, &[1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 0xC9]),
        (0x0A10, &[0x00, 0x0C, 0x20, 0x09]),
        (0x0B00, &[0x21, 0xAF, 0xC9]), // ld hl,$C9AF (or, from $0B01: xor a ; ret)
        // $0C00: jr z,$0C05 ; jp $0150 ; $0C05: ret
        (0x0C00, &[0x28, 0x03, 0xC3, 0x50, 0x01, 0xC9]),
        // $0D00: records (byte, pointer) ended by $00: (01, $0C00), (02, $0905)
        (0x0D00, &[0x01, 0x00, 0x0C, 0x02, 0x05, 0x09, 0x00]),
        // $0E00: call $0E10 ; ld a,$05 ; ret ; $0E10: ret
        (0x0E00, &[0xCD, 0x10, 0x0E, 0x3E, 0x05, 0xC9]),
        (0x0E10, &[0xC9]),
        // $0F00: wait for A: ld a,$10 ; ldh [$00],a ; ldh a,[$00] ; bit 0,a ; jr nz,$0F00 ; ret
        (0x0F00, &[0x3E, 0x10, 0xE0, 0x00, 0xF0, 0x00, 0xCB, 0x47, 0x20, 0xF6, 0xC9]),
        (bank(2, 0x4005), &[0xC9]),
        // bank 2 $4100: ld a,$01 ; ld [$2000],a (maps bank 1 back, and runs on into it)
        (bank(2, 0x4100), &[0x3E, 0x01, 0xEA, 0x00, 0x20]),
        (bank(3, 0x4000), &[0xC9]),
    ])
}

fn lines(v: &Value) -> Vec<String> {
    v.as_array().unwrap().iter().map(|x| x.as_str().unwrap().to_string()).collect()
}

#[test]
fn bank_switches_resolve_bank0_calls() {
    let (mut s, _) = server();
    open(&mut s, &field_rom());
    // ld [$2000], a with a known A maps that bank for the calls after it.
    let x = ok(&mut s, "xrefs", json!({"target": "02:4005", "kind": "call"}));
    let r = x["refs"].as_array().unwrap();
    assert!(r.contains(&json!({"from": "00:0905", "kind": "call", "insn": "CALL $4005", "bank_assumed": true, "unreached": true})), "{x}");
    assert!(r.iter().any(|e| e["from"] == "00:0920" && e["ambiguous_bank"] == true), "{x}");
    // A declared switch routine does the same.
    assert_eq!(ok(&mut s, "xrefs", json!({"target": "03:4000", "kind": "call"}))["refs"][0]["ambiguous_bank"], true);
    ok(&mut s, "farcall_set", json!({"name": "bankswitch", "via": "00:0280", "kind": "switch"}));
    let x = ok(&mut s, "xrefs", json!({"target": "03:4000", "kind": "call"}));
    assert_eq!((froms(&x), x["refs"][0]["bank_assumed"].clone()), (vec!["00:0915 call".to_string()], json!(true)), "{x}");
    ok(&mut s, "label_set", json!({"addr": "02:4005", "name": "Helper"}));
    let d = lines(&ok(&mut s, "disasm", json!({"addrs": ["00:0905", "00:0920"], "count": 1}))[0]["lines"]);
    assert_eq!(d, ["00:0905  CD0540     CALL $4005  ; ?? 02:4005 Helper"], "the switch is before the start");
    let d = lines(&ok(&mut s, "disasm", json!({"addr": "00:0900", "count": 3})));
    assert_eq!(d[2], "00:0905  CD0540     CALL Helper  ; bank 02 (switched above)");
    // A bank-0 call with an unknown bank lists the labels at that address.
    let d = lines(&ok(&mut s, "disasm", json!({"addr": "00:0920", "count": 1})));
    assert_eq!(d, ["00:0920  CD0540     CALL $4005  ; ?? 02:4005 Helper"]);
    // reached_only drops refs from code nothing reaches; a code label seeds the descent.
    ok(&mut s, "label_set", json!({"addr": "00:0900", "name": "Switcher"}));
    let x = ok(&mut s, "xrefs", json!({"target": "Helper", "reached_only": true}));
    assert_eq!(froms(&x), ["00:0905 Switcher+$5 call"], "{x}");
}

#[test]
fn bank0_is_not_a_switchable_bank() {
    let (mut s, _) = server();
    open(&mut s, &field_rom());
    for (tool, args) in [("disasm", json!({"addr": "00:4005"})), ("breakpoint_set", json!({"addr": "00:6000"})),
                         ("call_routine", json!({"addr": "00:0E00", "stubs": [{"addr": "00:4005"}]}))] {
        let e = call(&mut s, tool, args.clone()).unwrap_err();
        assert!(e.contains("bank 00"), "{tool} {args}: {e}");
    }
}

#[test]
fn disasm_data_tables_mid_labels_and_function_ends() {
    let (mut s, _) = server();
    open(&mut s, &field_rom());
    ok(&mut s, "label_set", json!({"labels": [
        {"addr": "00:0A00", "name": "Bytes", "kind": "data", "size": 10},
        {"addr": "00:0A10", "name": "Ptrs", "kind": "jumptable", "entries": 2},
        {"addr": "00:0C00", "name": "Branchy"},
    ]}));
    assert_eq!(lines(&ok(&mut s, "disasm", json!({"addr": "00:0A00", "count": 3}))), [
        "Bytes:",
        "00:0A00  0102030405060708 DB $01, $02, $03, $04, $05, $06, $07, $08",
        "00:0A08  090A       DB $09, $0A",
        "00:0A0A  C9         RET",
    ]);
    assert_eq!(lines(&ok(&mut s, "disasm", json!({"addr": "Ptrs", "count": 2}))), ["Ptrs:", "00:0A10  000C       DW Branchy", "00:0A12  2009       DW $0920"]);
    // until_ret goes on past an unconditional jump that an earlier branch skips.
    assert_eq!(lines(&ok(&mut s, "disasm", json!({"addr": "Branchy", "until_ret": true}))), [
        "Branchy:", "00:0C00  2803       JR Z, $0C05", "00:0C02  C35001     JP $0150", "00:0C05  C9         RET",
    ]);
    // A data label alone ends an until_ret listing.
    assert_eq!(ok(&mut s, "disasm", json!({"addr": "Bytes", "until_ret": true})).as_array().unwrap().len(), 3);
    // A target inside a routine names it; past its end, no name.
    let x = ok(&mut s, "xrefs", json!({"target": "00:0C05"}));
    assert_eq!(x["inside"], "00:0C05 Branchy+$5", "{x}");
    assert_eq!(ok(&mut s, "label_search", json!({"near": "00:0C05"}))["at"], "00:0C05 Branchy+$5");
    assert_eq!(ok(&mut s, "mem_read", json!({"addr": "00:0C06"}))["addr"], "00:0C06");
    // A code label inside an instruction: label_set warns, and disasm restarts there.
    let before = ok(&mut s, "find_bytes", json!({"pattern": "AF C9", "insn_start": true}));
    assert_eq!(before["count"], 0, "inside LD HL, $C9AF: {before}");
    let r = ok(&mut s, "label_set", json!({"addr": "00:0B01", "name": "Mid"}));
    assert!(r["warnings"][0].as_str().unwrap().contains("inside the instruction LD HL, $C9AF at 00:0B00"), "{r}");
    let d = lines(&ok(&mut s, "disasm", json!({"addr": "00:0B00", "count": 3})));
    assert_eq!(&d[..3], ["00:0B00  21         DB $21", "Mid:", "00:0B01  AF         XOR A, A"], "{d:?}");
    assert_eq!(ok(&mut s, "find_bytes", json!({"pattern": "AF C9", "insn_start": true}))["hits"], json!(["00:0B01 Mid"]));
}

#[test]
fn find_bytes_nibbles_records_and_words() {
    let (mut s, _) = server();
    open(&mut s, &field_rom());
    let f = ok(&mut s, "find_bytes", json!({"pattern": "3E 0? EA", "banks": "00"}));
    assert_eq!(f["hits"], json!(["00:0900"]), "{f}");
    let f = ok(&mut s, "find_bytes", json!({"pattern": "?E 0?", "banks": "00"}));
    assert!(f["hits"].as_array().unwrap().contains(&json!("00:0910")), "{f}");
    assert!(call(&mut s, "find_bytes", json!({"pattern": "3G"})).unwrap_err().contains("3G"));
    let r = ok(&mut s, "records", json!({"addr": "00:0D00", "fields": ["b", "w"], "terminator": "00"}));
    assert_eq!(r["records"], json!([{"at": "00:0D00", "fields": ["01", "00:0C00"]}, {"at": "00:0D03", "fields": ["02", "00:0905"]}]), "{r}");
    assert_eq!((r["bytes"].clone(), r["end"].clone(), r["terminated"].clone()), (json!(7), json!("00:0D07"), json!(true)));
    // An undeclared pointer: an operand already listed (LD BC, $0C00) isn't repeated as a word...
    let x = ok(&mut s, "xrefs", json!({"target": "00:0C00", "words": true}));
    assert_eq!(froms(&x), ["00:0D00 ld", "00:0A10 word"], "{x}");
    // ...and once the list is data, its pointer is a word in data.
    ok(&mut s, "label_set", json!({"addr": "00:0D00", "name": "List", "kind": "data", "size": 7}));
    let x = ok(&mut s, "xrefs", json!({"addr": "00:0C00", "words": true, "kind": "word"}));
    assert!(x["refs"].as_array().unwrap().contains(&json!({"from": "00:0D01 List+$1", "kind": "word", "in": "data"})), "{x}");
}

#[test]
fn arguments_hex_and_tool_discovery() {
    let (mut s, _) = server();
    // rom_info changes nothing and works before any ROM.
    assert_eq!(ok(&mut s, "rom_info", json!({}))["open"], false);
    let p = field_rom();
    open(&mut s, &p);
    assert_eq!(ok(&mut s, "rom_info", json!({}))["session"]["powered"], false);
    // A misspelt key is named.
    let e = call(&mut s, "function_bounds", json!({"adr": "00:0E00"})).unwrap_err();
    assert!(e.contains("needs \"addr\"") && e.contains("\"adr\""), "{e}");
    // Hex strings with prefixes, separators, or a single byte.
    for (b, want) in [("0x11", "11"), ("$11, $22", "11 22"), ("11", "11"), ("0102 FF", "01 02 FF")] {
        assert_eq!(ok(&mut s, "mem_write", json!({"addr": "C000", "bytes": b}))["now"], want, "{b}");
    }
    assert!(call(&mut s, "mem_write", json!({"addr": "C000", "bytes": "0x111"})).is_err());
    // Opening the ROM already open keeps the session; reset starts over.
    ok(&mut s, "run", json!({"frames": 3}));
    let i = ok(&mut s, "rom_info", json!({}));
    assert_eq!((i["session"]["powered"].clone(), i["session"]["frames"].clone()), (json!(true), json!(3)), "{i}");
    assert_eq!(ok(&mut s, "rom_open", json!({"path": p}))["session"], "kept");
    assert_eq!(ok(&mut s, "rom_info", json!({}))["session"]["frames"], 3);
    assert_eq!(ok(&mut s, "rom_open", json!({"path": p, "reset": true}))["session"], "reset");
    assert_eq!(ok(&mut s, "rom_info", json!({}))["session"]["powered"], false);
    // Schemas type hex fields as strings, and the instructions name every tool.
    let r = s.handle(&json!({"jsonrpc": "2.0", "id": 1, "method": "tools/list"})).unwrap();
    let tools = r["result"]["tools"].as_array().unwrap();
    let prop = |t: &str, p: &str| tools.iter().find(|x| x["name"] == t).unwrap()["inputSchema"]["properties"][p]["type"].clone();
    assert_eq!(prop("find_immediate", "value"), "string");
    assert_eq!(prop("disasm", "addr"), "string");
    assert_eq!(prop("mem_write", "bytes"), json!(["string", "array"]));
    let i = s.handle(&json!({"jsonrpc": "2.0", "id": 2, "method": "initialize", "params": {}})).unwrap();
    let text = i["result"]["instructions"].as_str().unwrap();
    for t in tools {
        assert!(text.contains(t["name"].as_str().unwrap()), "{}", t["name"]);
    }
}

#[test]
fn shared_db_edits_report_what_they_replace() {
    let (mut s, _) = server();
    open(&mut s, &field_rom());
    ok(&mut s, "label_set", json!({"addr": "00:0C00", "name": "Foo", "comment": "one"}));
    let r = ok(&mut s, "label_set", json!({"addr": "00:0C00", "name": "Bar", "comment": "two"}));
    assert_eq!(r["replaced"], json!([{"addr": "00:0C00", "name": "Foo", "comment": "one"}]), "{r}");
    let r = ok(&mut s, "label_set", json!({"addr": "00:0C00", "name": "Bar", "comment": "three", "append": true}));
    assert!(r.get("replaced").is_none(), "{r}");
    let r = ok(&mut s, "comment_set", json!({"addr": "00:0C00", "text": "four", "append": true}));
    assert_eq!(r["comment"], "two | three | four");
    assert_eq!(ok(&mut s, "comment_set", json!({"addr": "00:0C00", "text": "five"}))["replaced"], "two | three | four");
    // db_dump in parts.
    ok(&mut s, "farcall_set", json!({"name": "bankswitch", "via": "00:0280", "kind": "switch"}));
    ok(&mut s, "label_set", json!({"labels": [{"addr": "02:4005", "name": "Helper"}, {"addr": "03:4000", "name": "Other"}]}));
    let d = ok(&mut s, "db_dump", json!({"sections": ["far_calls"]}));
    assert_eq!(d["knowledge"].as_object().unwrap().keys().collect::<Vec<_>>(), ["far_calls"]);
    let d = ok(&mut s, "db_dump", json!({"banks": "02-03", "sections": ["labels"]}));
    assert_eq!(d["counts"]["labels"], 2);
    let d = ok(&mut s, "db_dump", json!({"banks": "02-03", "range": "4000-4000", "limit": 1}));
    assert_eq!(d["knowledge"]["labels"], json!({"03:4000": {"name": "Other", "kind": "code"}}), "{d}");
}

#[test]
fn call_routine_continue_inputs_stubs_and_traces() {
    let (mut s, _) = server();
    open(&mut s, &field_rom());
    // Stop inside, then continue: the call returns and the session goes back where it was.
    let pc = ok(&mut s, "regs_get", json!({}))["pc"].clone();
    let r = ok(&mut s, "call_routine", json!({"addr": "00:0E00", "breakpoints": ["00:0E03"]}));
    assert_eq!(r["stop_reason"], "breakpoint 00:0E03");
    assert_eq!(ok(&mut s, "rom_info", json!({}))["session"]["call_stopped"], true);
    let r = ok(&mut s, "call_routine", json!({"continue": true, "regs": {"b": "09"}}));
    assert_eq!((r["stop_reason"].clone(), r["regs"]["a"].clone(), r["regs"]["pc"].clone()), (json!("returned"), json!("05"), pc), "{r}");
    assert!(call(&mut s, "call_routine", json!({"continue": true})).unwrap_err().contains("no stopped"));
    // Stub counts and logged registers; a trace summary and a kind filter.
    let r = ok(&mut s, "call_routine", json!({"addr": "00:0E00", "regs": {"hl": "1234"}, "stubs": [{"addr": "00:0E10", "log": true}], "trace_summary": true}));
    assert_eq!(r["stub_counts"], json!({"00:0E10": 1}));
    assert_eq!((r["stub_log"][0]["hl"].clone(), r["stub_log"][0]["caller"].clone()), (json!("1234"), json!("00:0E03")), "{r}");
    assert_eq!(r["trace_summary"], json!({"call 00:0E10": 1, "stub 00:0E10": 1}), "{r}");
    let r = ok(&mut s, "call_routine", json!({"addr": "00:0E00", "trace": true, "trace_kinds": ["call"]}));
    assert_eq!(r["trace"].as_array().unwrap().len(), 1, "{r}");
    // A routine that waits for a button: inputs press it.
    assert_eq!(ok(&mut s, "call_routine", json!({"addr": "00:0F00", "max_steps": 100000}))["stop_reason"], "max_steps");
    let r = ok(&mut s, "call_routine", json!({"addr": "00:0F00", "inputs": ["2:a"], "max_steps": 1000000}));
    assert_eq!(r["stop_reason"], "returned", "{r}");
    assert!(r["vblanks"].as_u64().unwrap() >= 2);
    // A routine that maps the previous bank back gets a warning.
    let r = ok(&mut s, "call_routine", json!({"addr": "02:4100", "max_steps": 200}));
    assert!(r["warning"].as_str().unwrap().contains("from 02 to 01"), "{r}");
}

#[test]
fn run_stubs_conditions_and_callers() {
    let (mut s, _) = server();
    open(&mut s, &field_rom());
    let r = ok(&mut s, "run", json!({"frames": 2, "stubs": [{"addr": "00:0160", "regs": {"a": "42"}}]}));
    assert!(r["stub_hits"]["00:0160"].as_u64().unwrap() > 10, "{r}");
    assert_eq!(ok(&mut s, "mem_read", json!({"addr": "C010", "len": 1}))["rows"][0].as_str().unwrap()[9..11].to_string(), "42");
    // A breakpoint whose condition never holds doesn't stop; one that holds does.
    ok(&mut s, "breakpoint_set", json!({"addr": "00:0153", "when": {"a": "02"}}));
    assert_eq!(ok(&mut s, "run", json!({"frames": 1}))["stop"]["reason"], "frames");
    let b = ok(&mut s, "breakpoint_set", json!({"addr": "00:0153", "when": {"a": "01", "flags": {"c": false}}}));
    assert_eq!(b["breakpoints"], json!(["00:0153 when a=01 flags.c=0"]), "set again: the condition is replaced");
    ok(&mut s, "breakpoint_set", json!({"addr": "00:0153", "when": {"a": "01"}}));
    assert_eq!(ok(&mut s, "run", json!({"frames": 1}))["stop"]["at"], "00:0153");
    assert!(call(&mut s, "breakpoint_set", json!({"addr": "00:0153", "when": {"q": 1}})).is_err());
    // caller: the return address, found on the stack.
    ok(&mut s, "breakpoint_clear", json!({}));
    ok(&mut s, "breakpoint_set", json!({"addr": "00:0162"}));
    let r = ok(&mut s, "run", json!({"frames": 1}));
    assert_eq!(r["stop"]["caller"], "00:0153", "{r}");
    assert!(r["stop"].get("caller_depth").is_none());
    ok(&mut s, "breakpoint_clear", json!({}));
    // A watchpoint on a value.
    ok(&mut s, "watchpoint_set", json!({"addr": "C010", "value": "07"}));
    assert_eq!(ok(&mut s, "run", json!({"frames": 1}))["stop"]["reason"], "frames");
    let w = ok(&mut s, "watchpoint_set", json!({"addr": "C010", "value": "01"}));
    assert_eq!(w["watchpoints"][1]["value"], "01");
    assert_eq!(ok(&mut s, "run", json!({"frames": 1}))["stop"]["value"], "01");
}
