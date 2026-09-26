# Cartouche

[![CI](https://github.com/phmatray/cartouche/actions/workflows/ci.yml/badge.svg)](https://github.com/phmatray/cartouche/actions/workflows/ci.yml)
[![License: MIT](https://img.shields.io/badge/license-MIT-blue.svg)](LICENSE)

**Cartouche is an emulator for Game Boy and Game Boy Color games that runs
entirely in your browser.** The emulation core is written in Rust and compiled
to WebAssembly; the interface is a React app that turns your own ROM files
into a library you can browse, play, save and come back to.

**Play it:** https://phmatray.github.io/cartouche/

> **No ROMs are provided.** Cartouche does not include, host, link to or help
> you find commercial game ROMs or BIOS/boot ROM files. You play games you
> legally own by loading your own backups, or the free homebrew listed in the
> app. The few ROMs in this repository (three free homebrew games and three
> hardware test cartridges) are redistributed under their authors' licenses;
> see [THIRD_PARTY_NOTICES.md](THIRD_PARTY_NOTICES.md).

## Contents

- [Features](#features)
- [Privacy](#privacy)
- [Using your own cartridges](#using-your-own-cartridges)
- [Building from source](#building-from-source)
- [Test suite](#test-suite)
- [Legal](#legal)
- [License](#license)

## Features

- Game Boy (DMG) and Game Boy Color (CGB) emulation: SM83 CPU, PPU, APU with
  all four sound channels, timers, MBC1/MBC2/MBC3/MBC5 cartridges, battery saves.
- Instant play: three free homebrew games (Tobu Tobu Girl, Tobu Tobu Girl
  Deluxe, µCity) and three test cartridges (dmg-acid2, cgb-acid2, Blargg's
  cpu_instrs) work offline out of the box.
- Library: search, sort, favorites, region filter, grid/list views, bulk ROM
  import with duplicate detection. The library holds free homebrew and your
  own ROMs; commercial games are never listed. Your ROMs are recognized by
  hash and labeled with metadata from GameDataBase and libretro-database.
- Player: pause, 0.5x to 4x speed, rewind, 5 save-state slots with thumbnails,
  battery save auto-save, LCD shader presets, fullscreen, debug drawer.
- Input: keyboard, gamepad (Gamepad API) and on-screen touch controls.
- Two-player link cable, both screens side by side on one page.
- Optional box art for recognized ROMs you added, downloaded from the
  libretro-thumbnails project only if you say yes when asked (off by default;
  Settings > Storage).

## Privacy

- No account, no server, no analytics, no tracking, no cookies.
- ROMs, battery saves, save states, favorites and play time stay in your
  browser (IndexedDB and localStorage). Nothing is uploaded anywhere.
- Only GitHub receives requests. GitHub Pages serves the app and its fonts.
  Box art is off by default: a first-launch dialog asks "Show box art?", and
  only if you choose "Download box art" (or turn it on later in Settings >
  Storage and agree) does the browser load covers of recognized ROMs you
  added from `raw.githubusercontent.com`. "Continue without" means no request
  to any other site. Like any web server, GitHub receives your IP address
  and browser details; see the
  [GitHub General Privacy Statement](https://docs.github.com/en/site-policy/privacy-policies/github-general-privacy-statement).
- Downloaded box art is kept in your browser only (Cache Storage). Settings >
  Storage shows its size and deletes it ("Delete downloaded box art").
- Clearing your browser's site data for Cartouche deletes everything.

## Using your own cartridges

Cartouche plays ROM files you provide. The legal way to get them is to make a
backup of a cartridge you own, with a cartridge dumper such as the GB
Operator (Epilogue), the GBxCart RW (insideGadgets) or a Retrode-style
reader, following the tool's own instructions. Laws on backups differ from
country to country: check yours. Do not download ROMs of games you do not own,
and do not share your dumps.

## Building from source

Requirements: Rust stable with the `wasm32-unknown-unknown` target,
[wasm-pack](https://rustwasm.github.io/wasm-pack/), Node.js 24 and npm.

```bash
rustup target add wasm32-unknown-unknown

# Build the WebAssembly core
cd gb-core && wasm-pack build --target web --out-dir pkg && cd ..

# Run the web app in development
cd gb-web && npm ci && npm run dev

# Production build (both steps)
./scripts/build.sh
```

Useful scripts in `gb-web/`: `npm run lint`, `npm run build`,
`npm run generate-gamedb` (rebuilds `src/data/gamedb.json` from GameDataBase and libretro-database).

## Test suite

The core is validated against public hardware test ROMs:

| Suite | What it covers |
|-------|----------------|
| Blargg `cpu_instrs`, `instr_timing`, `mem_timing`, `mem_timing-2`, `interrupt_time`, `halt_bug` | CPU instructions and timing |
| Blargg `dmg_sound`, `cgb_sound` | APU behavior |
| Blargg `oam_bug` | OAM corruption bug |
| dmg-acid2, cgb-acid2 | PPU rendering, compared pixel by pixel with the reference images |
| Unit tests (`gb-core/tests/cpu_tests.rs`, `cgb.rs`, module tests) | Opcodes, components, CGB and MBC details |
| Homebrew smoke tests (`gb-core/tests/homebrew.rs`) | Ten freely licensed GB/GBC homebrew games run 1,500 frames without error or frozen picture |
| Link cable (`gb-core/tests/link.rs`) | Serial transfers between two linked consoles |

The test ROMs are third-party files and are **not** in this repository.
Download them, then run the tests:

```bash
./scripts/fetch-test-roms.sh     # into gb-core/test-roms/ (git-ignored)
cd gb-core && cargo test --release --no-fail-fast
```

Result for 1.0.0: 119 tests, all passing (Blargg 59, acid2 3, CGB and
save-state 9, CPU 19, homebrew 10, link 3, module tests 16). The CI badge
above shows the current result on `main`; per-suite details are in
[CHANGELOG.md](CHANGELOG.md).

## Legal

Game Boy and Game Boy Color are trademarks of Nintendo. Cartouche is not
affiliated with, sponsored by or endorsed by Nintendo. Game titles are
trademarks of their respective owners and are used only to identify games.

Cartouche contains no Nintendo code: no BIOS or boot ROM is included, and
the emulator starts games directly in the documented post-boot state.

Read [docs/LEGAL.md](docs/LEGAL.md) for the full notice, the box art and
metadata policy, and how to request a takedown.
[THIRD_PARTY_NOTICES.md](THIRD_PARTY_NOTICES.md) lists every third-party
work and its license.

## Contributing

Contributions are welcome: read [CONTRIBUTING.md](CONTRIBUTING.md) first. In
short, never add, attach or link to ROMs, BIOS files or other copyrighted
material. Security issues: see [SECURITY.md](SECURITY.md).

## License

Cartouche's source code is released under the [MIT License](LICENSE).
Third-party material keeps its own license (see
[THIRD_PARTY_NOTICES.md](THIRD_PARTY_NOTICES.md)).
