# Cartouche — Game Boy / Game Boy Color emulator (Rust WASM + React/Vite/Tailwind v4)

## Project Structure

```
cartouche/
├── gb-core/                  # Rust crate, compiled to WASM with wasm-pack
│   ├── src/
│   │   ├── lib.rs            # wasm_bindgen exports (public WASM API, keep backward compatible)
│   │   ├── gameboy.rs        # Orchestrator: frame loop, post-boot state, save states
│   │   ├── cpu.rs / registers.rs   # SM83 CPU
│   │   ├── memory.rs         # Bus: region routing, DMA/HDMA, OAM-bug hooks
│   │   ├── cartridge.rs      # ROM + MBC1/MBC2/MBC3(RTC)/MBC5
│   │   ├── ppu.rs / apu.rs / timer.rs / interrupts.rs / joypad.rs / serial.rs
│   │   ├── camera.rs / printer.rs  # Pocket camera sensor + capture unit; Game Boy Printer on the serial port
│   │   ├── trace.rs          # Opt-in per-frame layer trace (BG/window/OBJ planes, per-line registers) + exact motion vectors
│   │   └── boot_rom.rs       # SameBoy MIT boot ROMs (gb-core/boot/, exact hashes in the guard) + 9-byte test stub; no Nintendo boot ROM or logo, ever
│   ├── examples/             # render.rs (PNG of a frame), harvest.rs (trace records; refuses to write inside a git repo)
│   └── tests/                # blargg.rs, acid2.rs, cgb.rs, cpu_tests.rs, homebrew.rs, link.rs, trace.rs
├── gb-web/                   # React 19 + Vite + Tailwind v4 + Zustand
│   └── src/
│       ├── components/       # shell/, library/, game/, player/, add/, settings/, LinkCablePage
│       ├── hooks/ lib/ store/ shaders/ workers/ audio/
│       ├── peripherals/      # Camera lens (getUserMedia → sensor), printer tray + album prints, rumble (gamepad / vibrate / iPhone switch-tick overlay on the touch buttons)
│       ├── neural/           # Neural 4× (tile-aware network + learned table) and Smooth motion, WebGL2; weights/*.bin are the only model data allowed (docs/NEURAL.md)
│       ├── content/legal.ts  # Legal page text
│       └── data/             # catalog.json (only verified, licensed entries), GameDB
└── scripts/                  # build.sh, fetch-test-roms.sh, catalog/gamedb generators
```

Test ROMs are downloaded by `scripts/fetch-test-roms.sh` into `gb-core/test-roms/` (gitignored).
Never commit ROMs, boot ROM dumps (only the two SameBoy boot ROMs in `gb-core/boot/`, allowlisted by hash), box art or Nintendo artwork (the one exception: the CC BY 4.0
key art of the bundled Tobu Tobu Girl games in `gb-web/public/covers/`, credited in
THIRD_PARTY_NOTICES.md); the only tracked ROMs are the
bundled ones in `gb-web/public/roms/`, each re-included by its own `.gitignore` line and listed
with license and SHA-256 in THIRD_PARTY_NOTICES.md. The hosted GB Studio ROMs in `gb-web/public/roms/gbstudio/`
must also be listed with their SHA-1 in `scripts/rom-allowlist.sha1` and credited in its `LICENSES.txt`
(only when the author's license covers redistribution of the whole ROM; everything else links to the author).

---

## Key Design Decisions

| Decision | Choice | Rationale |
|----------|--------|-----------|
| Opcode dispatch | Flat `match` on u8 | Compiles to jump table; most readable for auditing |
| Framebuffer transfer | Zero-copy via `framebuffer_ptr()` | Avoids 92KB copy per frame |
| Error boundary | Errors stored as `last_error: String` | wasm-bindgen can't serialize Rust enums; JS calls `get_error()` |
| PPU accuracy | Scanline-based (not pixel FIFO) | Sufficient for most games; simpler to implement |
| Timer | Simplified tick counting | Accurate falling-edge detection can be added later |
| Tailwind | v4 with `@import "tailwindcss"` | CSS-native approach, no config file needed |

---

## Build Commands

```bash
# Rust WASM build
cd gb-core && wasm-pack build --target web --out-dir pkg

# Frontend dev server
cd gb-web && npm run dev

# Dev mode with WASM watcher (requires cargo-watch)
cd gb-web && npm run dev:full

# Full production build (served from /cartouche/)
./scripts/build.sh

# Web unit tests (Node's test runner, pure TS modules only)
cd gb-web && npm test

# Core tests (use --no-fail-fast or cargo stops at the first failing binary)
cd gb-core && cargo test --release --no-fail-fast
```

## Keyboard Mapping

| Key | Button |
|-----|--------|
| Arrow keys | D-pad |
| Z | A |
| X | B |
| Enter | Start |
| Shift | Select |
