# Changelog

All notable changes to this project are documented here. The format follows
[Keep a Changelog](https://keepachangelog.com/en/1.1.0/) and the project uses
[Semantic Versioning](https://semver.org/).

## [1.0.0] - 2026-09-26

First public release of Cartouche, an emulator for Game Boy and Game Boy
Color games that runs in the browser.

### Added

- Rust/WebAssembly emulation core: SM83 CPU, PPU (DMG and CGB), APU with four
  channels, timers, interrupts, serial link, MBC1/MBC2/MBC3/MBC5 cartridges,
  battery saves and save states.
- Library of free homebrew and your own ROMs (commercial games are never
  listed), recognized by hash with GameDataBase and libretro-database
  metadata; search, sort, favorites, region filter, bulk import that skips
  damaged files.
- Player: speed control, rewind, save-state slots, LCD shader presets,
  fullscreen, keyboard, gamepad and touch controls, debug drawer.
- Two-player link cable on one page.
- Tobu Tobu Girl (Tangram Games, MIT + CC BY 4.0) bundled so the app can be
  played offline right away.
- Optional box art for recognized ROMs you added, downloaded at runtime from
  libretro-thumbnails (Game Boy and Game Boy Color). Off by default: a
  first-launch "Show box art?" dialog asks before any request; covers are
  kept only in the browser, and Settings > Storage shows their size, deletes
  them and downloads them again.
- Legal notice (`/legal` and docs/LEGAL.md), third-party notices, takedown
  procedure, contribution and security policies. Every build ships
  `LICENSE.txt`, `THIRD_PARTY_NOTICES.txt` and `THIRD_PARTY_LICENSES.txt`.
- CI (tests against Blargg test ROMs, dmg/cgb-acid2, save-state round trips
  and smoke runs of ten freely licensed homebrew ROMs, nine in CGB mode),
  GitHub Pages deployment after green CI, and a release workflow that runs CI
  on the tag first.

### Test status

`cargo test --release --no-fail-fast` in `gb-core/`: 119 tests, 119 passed,
0 failed, 0 ignored (module tests 16, `blargg` 59, `acid2` 3, `cgb` 9,
`cpu_tests` 19, `homebrew` 10, `link` 3).

- Blargg: cpu_instrs, instr_timing, mem_timing, mem_timing-2, interrupt_time,
  halt_bug, dmg_sound and cgb_sound (all singles and combined ROMs) pass;
  oam_bug passes as the combined ROM (every subtest reports ok) and 7 of its
  8 singles run on their own. `oam_bug/rom_singles/7-timing_effect.gb` is
  not run on its own: it never reports a result
  because of a defect in the ROM: its text log (17 + 19 × 515 = 9802 bytes,
  about 9.8 KB) overruns the 8 KB of cartridge RAM its header declares,
  overwrites its own code at $C000, and the ROM keeps restarting. The same
  test code passes as subtest 07 of the combined `oam_bug.gb`, which checks a
  CRC of that output against the hardware value; the test suite covers
  test 7 that way.
- dmg-acid2 and cgb-acid2 match the reference images pixel for pixel.
- The ten homebrew smoke tests (nine in CGB mode) run 1,500 frames each
  without an emulator error or a frozen picture.

[1.0.0]: https://github.com/phmatray/cartouche/releases/tag/v1.0.0
