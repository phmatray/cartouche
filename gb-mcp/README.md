# gb-mcp

A [Model Context Protocol](https://modelcontextprotocol.io) server that lets AI agents study and
debug Game Boy / Game Boy Color ROMs on top of Cartouche's emulation core (`gb-core`).

It runs over stdio (newline-delimited JSON-RPC 2.0, protocol version `2025-06-18`) and keeps its
state in memory between calls: the open ROM, one emulator session, named save-state slots,
breakpoints and watchpoints. Agents don't reboot the machine for every probe or re-run a
disassembler each time. What agents learn (labels, comments, far-call conventions, a charmap)
goes into a **knowledge DB**, a sidecar JSON file that several agents' servers share. One agent's
labels show up in the next agent's disassembly.

## Build

```bash
cd gb-mcp
cargo build --release      # -> gb-mcp/target/release/gb-mcp
cargo test                 # synthetic ROMs only (the dev profile keeps overflow checks on)
```

## Register it

Claude Code:

```bash
claude mcp add gb-mcp -- /abs/path/to/cartouche/gb-mcp/target/release/gb-mcp --db /abs/path/outside/any/repo/knowledge.json
```

Any other MCP client that runs stdio servers takes the same command, e.g. in a JSON config:

```json
{ "mcpServers": { "gb-mcp": { "command": "/abs/path/to/gb-mcp", "args": ["--db", "/abs/path/knowledge.json"] } } }
```

Options: `--db <path>` (or env `GB_MCP_DB`) is the knowledge DB. Without it, labels last only as
long as the process. `--rom <path>` opens a ROM at start-up. gb-mcp refuses a DB path inside a git
repository. Logs go to stderr; stdout carries only the protocol.

## Conventions

| Form | Meaning |
|---|---|
| JSON number `23` | decimal |
| JSON string `"17"`, `"0x17"`, `"$17"` | **hex**, always |
| `"BB:AAAA"` | bank:address, both hex. The bank matters for `$4000-$7FFF` (ROM bank) and `$D000-$DFFF` (WRAM bank). `00:xxxx` is the fixed bank 0 |
| `"vram1:8000"`, `"sram2:A000"` | a VRAM bank (`vram0`/`vram1`, `$8000-$9FFF`) or a cartridge RAM bank (`sramN`, N hex, `$A000-$BFFF`), whatever is mapped or enabled. For `mem_read`, `mem_write` and watchpoints (VRAM only) |
| a label name | the labelled location. A name that reads as hex (`Add`, `Cafe`, `1234`) is refused, so a name never hides an address |
| bytes | `"01 02 FF"`, `"0102ff"` or `[1, 2, "ff"]` |

Every address in an output is `BB:AAAA`, followed by its label (`00:1A2B Memcpy`) or the
nearest label before it (`00:1A31 Memcpy+$6`, up to $100 bytes). Call and jump targets show
only exact labels. You can pass any of these strings back as input: the part after the space is
ignored. A banked address with no bank is read in the session's current mapping, or in bank 1
when no session runs. Tool results are JSON text, and `screenshot` is an MCP image.

## Tools

### Static analysis (no emulation)

| Tool | Example | Result |
|---|---|---|
| `rom_open` | `{"path": "/abs/game.gbc"}` | header: title bytes hex + ascii, cart type, ROM/RAM size, CGB/SGB flags, header checksum, SHA-1, banks, and what the DB holds for it. Resets the session |
| `disasm` | `{"addr": "05:6000", "count": 20}`, `{"addr": "Memcpy", "until_ret": true}`, `{"addrs": ["05:6000", "Memcpy"], "count": 8}` | lines `BB:AAAA  RAW  TEXT  ; comment` in RGBDS syntax with labels substituted, `Name:` lines at labels, far calls annotated with their resolved target (`; far:farcall -> 02:4005 Helper`). RAM addresses are read from the session. `addrs` (up to 64) returns `[{"addr", "lines"}]` |
| `xrefs` | `{"target": "00:1A2B"}`, `{"target": "02:4005", "kind": "far"}` | every `call`/`jp`/`jr`/`rst`/`ld`-immediate/`far:<convention>`/`table` reference across the ROM, each with the referencing instruction (`insn`). On a RAM address that tells reads (`LD A, [wTurn]`) from writes (`LD [wTurn], A`) and pointer loads (`LD HL, wTurn`). The index is built once per ROM and knowledge state (about 70 ms for 2 MiB) |
| `find_bytes` | `{"pattern": "3E ?? CD", "banks": "00-03"}` | matching locations. A bank that doesn't exist is an error; the end of a range is clipped to the last bank |
| `find_immediate` | `{"value": "3C", "mnemonic": "cp"}` | every `CP A, $3C`. `"ld a"` / `"ld hl"` work the same. With no mnemonic, any n8 (2-byte) or n16 (3-byte) immediate matches |
| `function_bounds` | `{"addr": "00:1A2B"}` | extent, size, callees (calls, far calls, tail jumps, and the entries of a declared `jumptable` the function loads with `LD rr, Table`), exits, `JP HL` sites, and `illegal_opcodes`: paths that ran into an opcode the SM83 doesn't have (data, or a wrong entry point) end there |
| `callgraph` | `{"addr": "00:0100", "depth": 3}` | callees per function (as `function_bounds` finds them), recursively. Bank-0 jumps into `$4000-$7FFF` show as `??:AAAA` |
| `table_entries` | `{"addr": "States"}`, `{"addr": "01:5000", "entries": 6, "target_bank": "03"}` | a table of little-endian 16-bit pointers, each entry with its target's label: a declared `jumptable`/`pointers` label, or any ROM address with `entries` (to look before declaring one) |
| `text_decode` | `{"addr": "0A:5000", "terminator": "FF"}` | text decoded with the DB's `.tbl` charmap (or `"charmap": path`). Unknown bytes show as `[HH]` |

How references are found: each bank is swept linearly. The sweep skips the header and regions
labelled with a non-code kind (`data`, `ram`, `jumptable`, `pointers`): for their `size` when
they have one (a table's is `entries * 2`), so code right after a table is swept again, else up
to the next label. A non-code label inside a sized region is part of it (its own size can extend
it); a `code` label inside it ends it. It resyncs on a `code` label that falls inside an instruction. Each entry of
a `jumptable` or `pointers` table is a `table` reference from its entry address. An address
inside a sized region shows as `Name+$off`; past its end it no longer does. A target in
`$4000-$7FFF` is in the same bank when the reference is banked code.
When bank-0 code points there, the reference is listed with `"ambiguous_bank": true`, because the
bank mapped at run time can't be known statically. Far-call conventions resolve these cases.

### Knowledge DB

| Tool | Example |
|---|---|
| `label_set` | `{"addr": "00:1A2B", "name": "Memcpy", "comment": "copy BC bytes from HL to DE"}` or `{"labels": [{"addr": "00:C0A0", "name": "wTurn", "kind": "ram"}, ...]}`. Kinds: `code`, `data`, `ram`, `jumptable`, `pointers`. A name already used elsewhere moves to the new location |
| | sized data: `{"addr": "01:5000", "name": "Sines", "kind": "data", "size": 64}` (`size` in bytes; without it the region runs to the next label) |
| | tables of 16-bit pointers: `{"addr": "01:5100", "name": "StateTable", "kind": "jumptable", "entries": 6}`, `{"addr": "00:3000", "name": "TextPtrs", "kind": "pointers", "entries": 40, "target_bank": "0A"}`. `jumptable` entries are code (callees of the function that loads the table); `pointers` entries are only references. `target_bank` is the bank of entries in `$4000-$7FFF` (default: the table's bank; a bank-0 table without it gives ambiguous targets) |
| `label_delete` | `{"addr": "Memcpy"}` |
| `label_search` | `{"query": "mem"}` (substring, case-insensitive), `{"query": "^w[A-Z]", "regex": true, "kind": "ram"}`, `{"query": "loop", "in_comments": true}`. Results show `size`, `entries` and `target_bank` when set |
| | `{"near": "02:4F10", "kind": "code"}`: which routine contains an address. `before` lists the labels at or before it in its bank and region, nearest first, with `offset` (`limit`, default 1), and `after` the next one |
| `comment_set` | `{"addr": "00:1A31", "text": "loop counter"}` (empty text removes it) |
| `farcall_set` | see below |
| `farcall_delete` | `{"name": "farcall"}` |
| `charmap_set` | `{"path": "/abs/path/outside/repo/game.tbl"}` |
| `db_dump` | `{}`: this ROM's entry. `{"all": true}`: the whole file |

**Far-call conventions** describe how a game calls code in another bank, so that `xrefs`, `disasm`
and `callgraph` can follow cross-bank calls. Two generic shapes are supported:

- `inline`: a `CALL`/`RST` to `via` is followed by inline bytes, and execution resumes after them
  (the sweep and `disasm` skip them).
  `{"name": "farcall", "via": "00:0008", "kind": "inline", "layout": ["bank", "lo", "hi"]}`.
  Layout items are `bank`, `lo`, `hi` and `skip`, in the order the bytes appear. When the bank is
  implied (a trampoline that always calls into the same bank), leave `bank` out of the layout and give it fixed:
  `{"name": "fixedcall", "via": "00:0010", "kind": "inline", "layout": ["lo", "hi"], "bank": "02"}`.
- `regs`: the routine at `via` takes the bank in a register and the address in a register pair,
  set before the call (`ld a, bank ; ld hl, addr ; call via`).
  `{"name": "bankcall", "via": "00:1234", "kind": "regs", "bank_reg": "a", "addr_reg": "hl"}`.
  A fixed `"bank"` replaces `bank_reg` (give one or the other). Registers are tracked along the straight-line code
  before the call: an immediate load (`ld r, n8`, `ld rr, n16`), a copy of a known register
  (`ld r, r'`) and `xor a` make a value known; any other write to the register forgets it, and
  everything is forgotten after a `call`/`rst`, an unconditional `jp`/`jr`/`ret`, a skipped data
  region and at every code label (where other paths may join). A conditional jump or return
  keeps them, as the fall-through path still holds them. Values loaded from memory (`ld a, [hl+]`,
  `ld a, [nn]`) are not followed.

### Emulation (one session per server)

The first emulation tool powers on a session if `emu_boot` was not called. The session starts in
the post-boot state, with the boot ROM skipped.

The server answers one call at a time, so every call is bounded: at most 10,800 frames for
`emu_boot`, `run` and `input` (`hold + after`), which is 3 minutes of game time and about a minute
of wall time; 10,000,000 instructions for `step`; and 50,000,000 for `call_routine`'s `max_steps`
(also about a minute). Larger values are refused: split the work into several calls.

| Tool | Example | Notes |
|---|---|---|
| `emu_boot` | `{"frames": 600, "inputs": ["300:start"]}` | fresh power-on, then frames with an input script |
| `run` | `{"frames": 240, "inputs": ["10:start", "120:a:8"]}` | stops early at a breakpoint or watchpoint. The result has `stop` (`reason`, `at`/`pc` with bank, `insn`, `caller` = word at SP), `frames_run` and `regs` |
| `input` | `{"buttons": "a+b", "hold": 8, "after": 30}` | press, hold, release, run on |
| `step` | `{"count": 10}` | the first 64 executed instructions with labels (`executed_truncated` when more ran), and the next one. Stops after an instruction that hits a watchpoint (same access hook as `run`: reads, and writes even of an unchanged value), reporting `kind`, `addr`, `value`, `pc` and `insn`. When an interrupt is dispatched during the step, the step runs the handler's first instruction instead: it is logged as `(interrupt)` and the stop says `"interrupt": true` |
| `call_routine` | `{"addr": "00:1A2B", "regs": {"a": 2}, "stubs": [{"addr": "00:1A40", "regs": {"a": "FF"}}], "from_slot": "title"}` | see below |
| `mem_read` | `{"addr": "C000", "len": 64}`, `{"addr": "03:D000", "len": 16}`, `{"addr": "vram1:8000", "len": 32}`, `{"addr": "sram2:A000"}` | 16-byte rows with ASCII. `BB:` reads that ROM/WRAM bank without remapping, `vramN:` / `sramN:` that VRAM / cartridge RAM bank (the read must stay in the region). ROM reads work without a session |
| `mem_write` | `{"addr": "C000", "bytes": "01 02"}` | `BB:DXXX` writes that WRAM bank, `vramN:` / `sramN:` that VRAM / cartridge RAM bank. ROM-area writes reach the MBC registers |
| `regs_get` / `regs_set` | `{"regs": {"a": "12", "hl": "C000", "flags": {"c": true}, "ime": false}}` | |
| `state_save` / `state_load` | `{"slot": "title"}` | in-memory slots (default slot `"default"`). A slot keeps the picture shown when it was saved, and `state_load` puts it back on screen |
| `state_export` / `state_import` | `{"path": "/abs/x.state", "slot": "title"}` | without `slot`: the live session. Export refuses paths inside a git repository |
| `breakpoint_set` / `breakpoint_clear` | `{"addr": "05:6010"}` | bank-aware: the breakpoint fires only when that bank is mapped. Clear with no `addr` removes all |
| `watchpoint_set` / `watchpoint_clear` | `{"addr": "wTurn", "len": 2, "kind": "write"}`, `{"addr": "vram1:9800", "len": 32}` | `read`, `write` or `access`. `run` and `step` report the accessing instruction (pc + bank), the value and (`run`) the caller. A bank (`BB:`, `vramN:`) fires only while it is mapped; cartridge RAM banks can't be told apart, so watch `$A000-$BFFF` without one |
| `screenshot` | `{"scale": 3}` | PNG image content. After `state_import` (a file holds no picture), a text note says the picture predates the state, until two frames have run since the load (a `state_save` meanwhile keeps no picture either) |

Input scripts are lists of `"frame:button[+button][:hold]"`. Frames count from 0 in each call,
and `hold` defaults to 5 frames. Buttons are `a b start select up down left right`. A hold doesn't
carry over to the next call.

**call_routine** pushes a sentinel return address (default `$FEFF`), jumps to `addr` (mapping its
bank) and single-steps the whole machine (PPU, timers, interrupts) until the sentinel comes back.
Routines that wait for VBlank finish normally (`vblanks` counts the frames that passed).
Parameters:

- `from_slot` restores a slot first, so every call starts from the same state.
- Setup: `rom_bank`, `svbk`, `writes`, `regs`, `ime`.
- `stubs` emulate `RET` at an address, then set registers. Use them to skip printing or waiting,
  or to make a callee "return" a chosen value.
- `forces` rewrite bytes before every instruction, which pins a variable.
- `breakpoints`, `max_steps`, `sentinel`.
- `watch` logs value changes with the pc that made them.
- `dumps` reads memory after the call.
- `trace` logs calls, `rst`, interrupts, stub hits and bank switches; `trace_steps` logs the first
  N instructions.

The result has `stop_reason` (`returned`, `max_steps`, `breakpoint BB:AAAA`, `cpu_locked at X`
or `error: ...`), `steps`, `cycles`, `vblanks`, `stub_hits`, `regs` and `dumps` (each up to 64 KiB;
`watch` lengths up to 4 KiB).

After `returned`, PC, SP and the HALT state go back to what they were before the call, so `run` and
`step` carry on from where the session was (`regs.pc` shows that address; the other registers are
the routine's results). Memory the routine changed stays changed: use `from_slot` for isolated
calls. Any other stop reason leaves the machine where it stopped, inside the routine with the
sentinel on the stack.

Note: many games keep a copy of the current ROM bank in HRAM and restore it on return. When you
call a banked routine directly, also `writes` that copy if its return path restores the bank.

## Knowledge DB format

```json
{
  "version": 1,
  "roms": {
    "<sha1 of the ROM file>": {
      "labels":   { "00:1A2B": { "name": "Memcpy", "kind": "code" }, "01:D000": { "name": "wBuffer", "kind": "ram" },
                    "01:5000": { "name": "Sines", "kind": "data", "size": 64 },
                    "01:5100": { "name": "StateTable", "kind": "jumptable", "entries": 6, "target_bank": "02" } },
      "comments": { "00:1A2B": "copy BC bytes from HL to DE" },
      "charmap":  "/abs/path/game.tbl",
      "far_calls": [ { "name": "farcall", "via": "00:0008", "kind": "inline", "layout": ["bank", "lo", "hi"] },
                     { "name": "fixedcall", "via": "00:0010", "kind": "inline", "layout": ["lo", "hi"], "bank": "02" } ]
    }
  }
}
```

Location keys are `BB:AAAA`, with bank `00` for unbanked regions. `size`, `entries`,
`target_bank` and a far call's `bank` are optional (files without them load as before); written
by hand, a number is decimal and a string hex. A `size`, `entries` or `target_bank` that doesn't
parse is ignored, and a far call with a bad `bank` is skipped like any bad convention. Each change runs under an OS
file lock (`flock` / `LockFileEx`) on `<db>.lock`, which the system releases when the holder exits
or crashes, so there is no stale lock to break. The `.lock` file itself stays next to the DB. The
change is applied to a copy freshly reloaded from disk and written atomically (temporary file,
then rename), so concurrent agents never overwrite each other. Each server reloads the file before
a tool call whenever it has changed. The file is plain JSON and can be edited by hand: keys gb-mcp
doesn't know, at any level, are kept when it writes the file.

A `.tbl` charmap has one `HH=text` (or `HHHH=text`) mapping per line. A leading `/` or `*` marker
is accepted, and lines starting with `#` or `;` are comments. Decoding takes the longest match.

## Legal

This crate is generic. It contains no game data: no ROMs, no game-specific addresses, labels,
charmaps or names, and its tests assemble their own tiny synthetic ROMs. Everything specific to
a game stays with the user, outside this repository: the ROM, the knowledge DB, `.tbl` files and
exported save states. gb-mcp refuses a DB path or a state export inside a git repository. See
[docs/LEGAL.md](../docs/LEGAL.md).

## Limitations

- References come from a static linear sweep, so data that wasn't labelled `data` can produce
  false references. Code reached only through jump tables is still swept, because each bank is
  swept whole.
- One emulator session per server process. Run several servers for parallel sessions; they share
  the DB. Calls run one at a time and `notifications/cancelled` is ignored, hence the per-call
  limits above.
- `BB:` addresses cover ROM banks (`$4000-$7FFF`) and WRAM banks 1-7 (`$D000-$DFFF`); VRAM and
  cartridge RAM banks take `vramN:` / `sramN:`. A plain `$8000-$BFFF` address reads the current
  mapping. Watchpoints can't be limited to one cartridge RAM bank.
- MBC1 can't map banks `$20`, `$40` and `$60` at `$4000-$7FFF` (the hardware maps `$21`, `$41`,
  `$61` instead: those banks run only at `$0000-$3FFF` in mode 1), so a `call_routine` or
  `rom_bank` that needs one returns an error. Static tools read them from the file normally.
- Jump tables are references only once declared (`jumptable` / `pointers` labels): `table_entries`
  lists a candidate table before you declare it.
