# Changelog

All notable changes to this project are documented here. The format follows
[Keep a Changelog](https://keepachangelog.com/en/1.1.0/) and the project uses
[Semantic Versioning](https://semver.org/).

## [1.1.0](https://github.com/phmatray/cartouche/compare/v1.0.0...v1.1.0) (2026-09-26)


### Added

* **display:** composable screen filter pipeline with presets ([3a08687](https://github.com/phmatray/cartouche/commit/3a08687ffd9f6e7405dc7d1dd7dfe6840062562c))
* **link-cable:** cartridge picker that scales to large libraries ([cf9fff9](https://github.com/phmatray/cartouche/commit/cf9fff97d6db005e44ce0754dd13f34accb9b410))
* **saves:** save profiles, and a save of its own for each link cable player ([95a4332](https://github.com/phmatray/cartouche/commit/95a4332ee510651fac2abdd7f549138ba450f060))
* **web:** add OpenGraph, Twitter card and JSON-LD metadata ([7cfd824](https://github.com/phmatray/cartouche/commit/7cfd824d4e5a1ca2c8206d9bb94c0ca7ca9843b4))
* **web:** box art progress bar and a Storage page that scales ([52cb3c4](https://github.com/phmatray/cartouche/commit/52cb3c464fda4891cca8c0ac01c97ad46f8571af))
* **web:** link to the source on GitHub ([c527a0d](https://github.com/phmatray/cartouche/commit/c527a0d086637298db391c645268ed289311d6e6))
* **web:** list a game's save profiles in Storage › Per game ([ed164ba](https://github.com/phmatray/cartouche/commit/ed164ba4ce04b35257904c60f56e0891de038b4e))
* **web:** ship the official covers of the Tobu Tobu Girl games ([a167fb5](https://github.com/phmatray/cartouche/commit/a167fb52db180f216260acbae2c06b8e7c5e03d6))


### Fixed

* **display:** review fixes for the screen filters ([b3e5e00](https://github.com/phmatray/cartouche/commit/b3e5e003cc958eda9931282c67c6e9950860d5a8))
* **link-cable:** accent- and word-aware search, open on the right section ([979ea02](https://github.com/phmatray/cartouche/commit/979ea02ac27ee7ab33008f8b0a364bd77748fefc))
* **saves:** keep each profile's progress safe across states, unloads and upgrades ([d6c9944](https://github.com/phmatray/cartouche/commit/d6c9944f7b1ec291b881b63b4f5f5fb35cd0dacf))
* **web:** keep play time when the tab reloads or closes ([b88ccf8](https://github.com/phmatray/cartouche/commit/b88ccf8d5862f8e7ede2a4ca890bce3246154691))
* **web:** keyboard and focus fixes for Storage › Per game ([ae80e31](https://github.com/phmatray/cartouche/commit/ae80e316dbbbf195a3b1e0dd56316157e01fb4c2))
* **web:** line up every box on a shelf by its top edge ([a4d5255](https://github.com/phmatray/cartouche/commit/a4d5255ed5e6e9ad469261d2f117af39a291950b))
* **web:** make rewind run backwards on screen while R is held ([aa33d84](https://github.com/phmatray/cartouche/commit/aa33d84461517594ce1dd586a65b9f2fdb5016fd))
* **web:** old backups keep their screen style; state loads redraw at once ([f3ac5ac](https://github.com/phmatray/cartouche/commit/f3ac5acb4225ad528b491b9105dd800e558cd357))
* **web:** rewind the first step on press ([f92caf1](https://github.com/phmatray/cartouche/commit/f92caf1a1a321e5bfb4e5e8843e974e368d5a362))
* **web:** show the first rewind step on the next frame ([ac2d6b7](https://github.com/phmatray/cartouche/commit/ac2d6b74d96684dc4a577f6204c736f058bef1fb))


### Changed

* cut releases with release-please ([f894f1b](https://github.com/phmatray/cartouche/commit/f894f1b560963707c0f2fe63c53fde164279ad68))


### Documentation

* rewrite the README with a banner and screenshots ([59ceb1b](https://github.com/phmatray/cartouche/commit/59ceb1b684e288da300d70ce1e2b4eb30f866a25))

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
