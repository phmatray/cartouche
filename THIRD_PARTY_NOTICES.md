# Third-party notices

Cartouche itself is released under the [MIT License](LICENSE). This file lists
every third-party work that is **bundled** with Cartouche, **used at runtime**
from a third-party server, or **downloaded only for testing**, together with its
license and the attribution it requires.

## 1. Bundled in the repository and the published web app

### Bundled ROMs at a glance

Six ROM files are bundled, in `gb-web/public/roms/` (each re-included in
`.gitignore` by its own negation line). Each is a separate program that
Cartouche loads as data, like a file the player adds; none of them is linked
into, or part of, Cartouche's own code. They are redistributed unmodified.

| File | Work | Author | License | SHA-256 |
|------|------|--------|---------|---------|
| `tobutobugirl.gb` | Tobu Tobu Girl | Tangram Games | MIT (code) + CC BY 4.0 (assets) | `5d3871cae77db2287807e8914fd21f76203e73aa3fec20955489d45cb4571d8f` |
| `tobutobugirldx.gb` | Tobu Tobu Girl Deluxe | Tangram Games | MIT (code) + CC BY 4.0 (assets) | `0a0e8018dbbc8d7f8cd99f05e7cdc7b4cc9e358ecfe9377ebfb2291a84c6e310` |
| `ucity.gbc` | µCity 1.3 | Antonio Niño Díaz | GPL-3.0-or-later (+ BSD-2-Clause, CC BY-SA 4.0) | `9422ee2ca7b7ea1d46b58b2a429fff3f354dfd3e732dee1e7ae6220f148ce6e0` |
| `cgb-acid2.gbc` | cgb-acid2 v1.1 | Matt Currie | MIT | `197fb0bcec544f0400527fc707e0a94f55435974986e6986b424ace5de81720e` |
| `dmg-acid2.gb` | dmg-acid2 v1.0 | Matt Currie | MIT | `464e14b7d42e7feea0b7ede42be7071dc88913f75b9ffa444299424b63d1dff1` |
| `cpu_instrs.gb` | Blargg's cpu_instrs | Shay Green | none stated (see below) | `8c5e12f41e0ba5bbca796944f92ffe6de28809198682c4332e38d1b3cf56fcf2` |

Like every Game Boy cartridge, each ROM header contains the 48-byte logo
bitmap the original hardware checks at power-on. It is part of the authors'
releases.

### Tobu Tobu Girl (Game Boy ROM)

- File: `gb-web/public/roms/tobutobugirl.gb`
- Author: Tangram Games (Simon Larsen and collaborators), © 2017 Tangram Games
- Source: https://github.com/SimonLarsen/tobutobugirl
- Official release the file was taken from, unmodified:
  https://tangramgames.itch.io/tobutobugirl ("Game Boy rom" package, file `tobu.gb`)
- SHA-256: `5d3871cae77db2287807e8914fd21f76203e73aa3fec20955489d45cb4571d8f`
- Licenses, as stated by the authors in the source repository README and `LICENSE`:
  - Source code: MIT License (reproduced below)
  - Assets (images, text, sound and music): [Creative Commons Attribution 4.0 International (CC BY 4.0)](https://creativecommons.org/licenses/by/4.0/)
- Changes: none. The file is redistributed exactly as released, renamed from
  `tobu.gb` to `tobutobugirl.gb`.
- Box art: `gb-web/public/covers/tobu-tobu-girl.webp`, the official key art
  by Tangram Games, the cover image of https://tangramgames.itch.io/tobutobugirl
  (asset license stated there: CC BY 4.0; downloaded 2026-09-26, 630x500 PNG,
  SHA-256 `6e740ae8314a4fcd78b60e68f6d47c14c1310c4b630ee95ea1ef8e974b57f505`).
  Changes: cropped to a centered 500x500 square, resized to 512x512 and
  converted to WebP. Licensed under
  [CC BY 4.0](https://creativecommons.org/licenses/by/4.0/).

### Tobu Tobu Girl Deluxe (Game Boy / Game Boy Color ROM)

- File: `gb-web/public/roms/tobutobugirldx.gb`
- Author: Tangram Games (Simon Larsen and collaborators; soundtrack by
  potato-tan), © 2017 Tangram Games
- Source: https://github.com/SimonLarsen/tobutobugirl-dx
- Official release the file was taken from, unmodified:
  https://tangramgames.itch.io/tobu-tobu-girl-deluxe (file `tobudx.gb`,
  downloaded 2026-09-26)
- SHA-256: `0a0e8018dbbc8d7f8cd99f05e7cdc7b4cc9e358ecfe9377ebfb2291a84c6e310`
- Licenses, as stated by the authors in the source repository README and
  `LICENSE` (checked 2026-09-26):
  - Source code: MIT License, same text and copyright line as Tobu Tobu Girl (reproduced below)
  - Assets (images, text, sound and music): [Creative Commons Attribution 4.0 International (CC BY 4.0)](https://creativecommons.org/licenses/by/4.0/)
- Changes: none. The file is redistributed exactly as released, renamed from
  `tobudx.gb` to `tobutobugirldx.gb`.
- Box art: `gb-web/public/covers/tobu-tobu-girl-deluxe.webp`, the official key
  art by Tangram Games, the cover image of
  https://tangramgames.itch.io/tobu-tobu-girl-deluxe (asset license stated
  there: CC BY 4.0; downloaded 2026-09-26, 1500x1500 PNG, SHA-256
  `ec3c38e1731572e2a4ebb3eb89dcf44a8cb4ca76f309074b53e58b238d04969d`).
  Changes: resized to 512x512 and converted to WebP. Licensed under
  [CC BY 4.0](https://creativecommons.org/licenses/by/4.0/).

MIT License of Tobu Tobu Girl and Tobu Tobu Girl Deluxe:

```
MIT License

Copyright (c) 2017 Tangram Games

Permission is hereby granted, free of charge, to any person obtaining a copy
of this software and associated documentation files (the "Software"), to deal
in the Software without restriction, including without limitation the rights
to use, copy, modify, merge, publish, distribute, sublicense, and/or sell
copies of the Software, and to permit persons to whom the Software is
furnished to do so, subject to the following conditions:

The above copyright notice and this permission notice shall be included in all
copies or substantial portions of the Software.

THE SOFTWARE IS PROVIDED "AS IS", WITHOUT WARRANTY OF ANY KIND, EXPRESS OR
IMPLIED, INCLUDING BUT NOT LIMITED TO THE WARRANTIES OF MERCHANTABILITY,
FITNESS FOR A PARTICULAR PURPOSE AND NONINFRINGEMENT. IN NO EVENT SHALL THE
AUTHORS OR COPYRIGHT HOLDERS BE LIABLE FOR ANY CLAIM, DAMAGES OR OTHER
LIABILITY, WHETHER IN AN ACTION OF CONTRACT, TORT OR OTHERWISE, ARISING FROM,
OUT OF OR IN CONNECTION WITH THE SOFTWARE OR THE USE OR OTHER DEALINGS IN THE
SOFTWARE.
```

### µCity (Game Boy Color ROM)

- File: `gb-web/public/roms/ucity.gbc`
- Author: Antonio Niño Díaz (AntonioND / SkyLyrac), © 2017-2018
- Official release the file was taken from, unmodified: release tag **v1.3**,
  https://github.com/AntonioND/ucity/releases/tag/v1.3 (asset `ucity.gbc`)
- SHA-256: `9422ee2ca7b7ea1d46b58b2a429fff3f354dfd3e732dee1e7ae6220f148ce6e0`
- Licenses, as stated by the author in `readme.rst` and the file headers of
  the v1.3 source (checked 2026-09-26):
  - The game code: GNU General Public License, version 3 or (at your option)
    any later version (GPL-3.0-or-later). The full license text is in
    `gb-web/public/licenses/GPL-3.0-ucity.txt` (the `gpl-3.0.txt` of the
    v1.3 source, unmodified), published with the app at
    `licenses/GPL-3.0-ucity.txt`.
  - The GBT Player music engine included in the game: BSD 2-Clause License
    (notice reproduced below).
  - Graphics and music: [Creative Commons Attribution-ShareAlike 4.0 International (CC BY-SA 4.0)](https://creativecommons.org/licenses/by-sa/4.0/).
- Box art: none. The v1.3 repository holds no cover or key art (only a
  screenshot), so µCity keeps the app's printed card.
- **Corresponding source code**: the complete source code of this exact
  binary is the v1.3 tag of the author's repository,
  https://github.com/AntonioND/ucity/tree/v1.3 (commit
  `d1880a2a112d7c26f16c0fc06a15b6c32fdc9137`), also downloadable as
  https://github.com/AntonioND/ucity/archive/refs/tags/v1.3.tar.gz. It builds
  with RGBDS (`make`): built with RGBDS v1.0.4 on 2026-09-26, the v1.3 tag
  produces a `ucity.gbc` with exactly the SHA-256 above. The same tag (same
  commit) is also published by the author at
  https://codeberg.org/SkyLyrac/ucity/src/tag/v1.3, and every Cartouche
  GitHub release attaches a copy of the v1.3 source archive
  (`ucity-1.3-source.tar.gz`).
- Changes: none. The file is the official v1.3 release, unmodified and not renamed.
- **Mere aggregation**: µCity is a separate program. Cartouche does not link
  to it, include its code or derive from it; it is shipped next to the
  emulator as a data file that the emulator loads, exactly like a ROM the
  player adds. This is "aggregation" in the sense of section 5 of the GPL-3.0,
  so the GPL applies to `ucity.gbc` only and does not extend to Cartouche,
  which stays under the MIT License. Anyone may remove `ucity.gbc` (and its
  catalog entry) without affecting Cartouche.

GBT Player notice (from `source/engine/gbt_player.asm` in µCity v1.3):

```
Copyright (c) 2009-2016, Antonio Niño Díaz (AntonioND)
All rights reserved.

Redistribution and use in source and binary forms, with or without
modification, are permitted provided that the following conditions are met:

* Redistributions of source code must retain the above copyright notice, this
 list of conditions and the following disclaimer.

* Redistributions in binary form must reproduce the above copyright notice,
  this list of conditions and the following disclaimer in the documentation
  and/or other materials provided with the distribution.

THIS SOFTWARE IS PROVIDED BY THE COPYRIGHT HOLDERS AND CONTRIBUTORS "AS IS"
AND ANY EXPRESS OR IMPLIED WARRANTIES, INCLUDING, BUT NOT LIMITED TO, THE
IMPLIED WARRANTIES OF MERCHANTABILITY AND FITNESS FOR A PARTICULAR PURPOSE ARE
DISCLAIMED. IN NO EVENT SHALL THE COPYRIGHT HOLDER OR CONTRIBUTORS BE LIABLE
FOR ANY DIRECT, INDIRECT, INCIDENTAL, SPECIAL, EXEMPLARY, OR CONSEQUENTIAL
DAMAGES (INCLUDING, BUT NOT LIMITED TO, PROCUREMENT OF SUBSTITUTE GOODS OR
SERVICES; LOSS OF USE, DATA, OR PROFITS; OR BUSINESS INTERRUPTION) HOWEVER
CAUSED AND ON ANY THEORY OF LIABILITY, WHETHER IN CONTRACT, STRICT LIABILITY,
OR TORT (INCLUDING NEGLIGENCE OR OTHERWISE) ARISING IN ANY WAY OUT OF THE USE
OF THIS SOFTWARE, EVEN IF ADVISED OF THE POSSIBILITY OF SUCH DAMAGE.
```

### dmg-acid2 and cgb-acid2 (test cartridges)

- Files: `gb-web/public/roms/dmg-acid2.gb` and `gb-web/public/roms/cgb-acid2.gbc`
- Author: Matt Currie, © 2020
- Sources: https://github.com/mattcurrie/dmg-acid2 and
  https://github.com/mattcurrie/cgb-acid2
- Official releases the files were taken from, unmodified and not renamed:
  https://github.com/mattcurrie/dmg-acid2/releases/tag/v1.0 (`dmg-acid2.gb`)
  and https://github.com/mattcurrie/cgb-acid2/releases/tag/v1.1 (`cgb-acid2.gbc`)
- SHA-256: `464e14b7d42e7feea0b7ede42be7071dc88913f75b9ffa444299424b63d1dff1`
  (dmg-acid2), `197fb0bcec544f0400527fc707e0a94f55435974986e6986b424ace5de81720e`
  (cgb-acid2)
- License: MIT License (both repositories carry the same text):

```
MIT License

Copyright (c) 2020 Matt Currie

Permission is hereby granted, free of charge, to any person obtaining a copy
of this software and associated documentation files (the "Software"), to deal
in the Software without restriction, including without limitation the rights
to use, copy, modify, merge, publish, distribute, sublicense, and/or sell
copies of the Software, and to permit persons to whom the Software is
furnished to do so, subject to the following conditions:

The above copyright notice and this permission notice shall be included in all
copies or substantial portions of the Software.

THE SOFTWARE IS PROVIDED "AS IS", WITHOUT WARRANTY OF ANY KIND, EXPRESS OR
IMPLIED, INCLUDING BUT NOT LIMITED TO THE WARRANTIES OF MERCHANTABILITY,
FITNESS FOR A PARTICULAR PURPOSE AND NONINFRINGEMENT. IN NO EVENT SHALL THE
AUTHORS OR COPYRIGHT HOLDERS BE LIABLE FOR ANY CLAIM, DAMAGES OR OTHER
LIABILITY, WHETHER IN AN ACTION OF CONTRACT, TORT OR OTHERWISE, ARISING FROM,
OUT OF OR IN CONNECTION WITH THE SOFTWARE OR THE USE OR OTHER DEALINGS IN THE
SOFTWARE.
```

### Blargg's cpu_instrs (test cartridge)

- File: `gb-web/public/roms/cpu_instrs.gb`
- Author: Shay Green ("Blargg")
- Source: the combined `cpu_instrs/cpu_instrs.gb` of the
  https://github.com/retrio/gb-test-roms collection (commit
  `c240dd7d700e5c0b00a7bbba52b53e4ee67b5f15`), unmodified and not renamed
- SHA-256: `8c5e12f41e0ba5bbca796944f92ffe6de28809198682c4332e38d1b3cf56fcf2`
- License: **no explicit license is stated** by the author, in the ROM, its
  readme or the collection.
- It is bundled because it is widely redistributed by the emulator community
  for testing, as the standard check of an emulator's CPU. No ownership or
  license is claimed for it. **It will be removed immediately on the author's
  request** (see [docs/LEGAL.md](docs/LEGAL.md), "Takedown requests").

### GB Studio collection (hosted ROMs)

The GB Studio collection (`gb-web/src/data/gbstudio.json`) lists about a hundred games made with GB Studio.
Four of them are hosted, in `gb-web/public/roms/gbstudio/`, because their authors' licenses allow
redistribution of the whole ROM; they are redistributed unmodified and downloaded by the app only on the
player's request. Each is re-included in `.gitignore` by its own line and allowlisted with its SHA-1 in
`scripts/rom-allowlist.sha1`. Full attributions, sources and license texts:
[`gb-web/public/roms/gbstudio/LICENSES.txt`](gb-web/public/roms/gbstudio/LICENSES.txt) (published as
`roms/gbstudio/LICENSES.txt`). Every other game in the collection links to its author's page and is not
redistributed.

| File | Work | Author | License | SHA-256 |
|------|------|--------|---------|---------|
| `gbstudio/dawn-will-come.gb` | Dawn Will Come | eishiya, H0lyhandgrenade, Kezia Salmon | MIT (code) + CC BY 4.0 (art, music) | `3a3b9881b5a3a3708e217efd73f443f6a97782d3b0d3a2086e1a00ac176e5e9f` |
| `gbstudio/poltersprite.gb` | Poltersprite 2.0.4 | Inkus Alters | CC BY-NC-SA 4.0 + GPL-3.0 (code) | `b98036114da6cca699ad1de8a81b4b3eef9db51db9264ca739f0212bfca44e21` |
| `gbstudio/millennium-gun.gb` | Millennium Gun | Finny (Gonçalo Limas) | 0BSD + CC0 1.0 + MIT (plugin) | `008459a4d209e694495c98b4add746d8f7f3955b4793efc21bdb091e082cd2f5` |
| `gbstudio/dusky-dungeon.gb` | Dusky Dungeon 0.2.0 | invertedHat (Jan Klečka) | MIT + CC BY 4.0 (+ CC BY 3.0 font) | `6e9dbac346dd6cbff6d01d00e58875e30e4c3f12cbf308f69a7a926295f196f2` |

Poltersprite's code is under the GPL-3.0: its complete corresponding source is `Polterspritev2.0.4.zip` in
https://github.com/inkusalters/Poltersprite (commit `3e86ecb700c5ec10e85640181683d985263e8c77`), and every
Cartouche GitHub release attaches a copy of it (`poltersprite-2.0.4-source.zip`, SHA-256
`d3e18aff042ab6eb8cae6ec579f2e55408ae207b103b06cc7a0f7ec8e26056bf`).

Box art of the four hosted games: `gb-web/public/covers/<id>.webp`, each the game's own title screen, captured
from the hosted ROM with Cartouche's core (`gb-core/examples/render.rs`, the 160x144 frame shown after about
10 to 20 seconds), padded to a 160x160 square with the screen's own edge rows or background colour, enlarged 3x
(nearest neighbour) to 480x480 and saved as lossless WebP. Each is a derivative of the game's artwork under the
license below; details in `LICENSES.txt`.

| File | Artwork | License of the artwork and of this cover |
|------|---------|-------------------------------------------|
| `covers/dawn-will-come.webp` | © H0lyhandgrenade and eishiya | [CC BY 4.0](https://creativecommons.org/licenses/by/4.0/) |
| `covers/poltersprite.webp` | © Inkus Alters | [CC BY-NC-SA 4.0](https://creativecommons.org/licenses/by-nc-sa/4.0/); the cover is shared under the same license |
| `covers/millennium-gun.webp` | Finny (Gonçalo Limas) | [CC0 1.0](https://creativecommons.org/publicdomain/zero/1.0/) |
| `covers/dusky-dungeon.webp` | © 2021 Jan Klečka; fonts: Gothic Pixel Font by Leoda (CC BY 4.0), Romulus by Pix3M (CC BY 3.0) | [CC BY 4.0](https://creativecommons.org/licenses/by/4.0/) (fonts as stated) |

### GameDataBase and libretro-database (game metadata)

- File: `gb-web/src/data/gamedb.json`, generated by `scripts/generate-gamedb.ts`
- Sources:
  - https://github.com/PigSaint/GameDataBase (files
    `console_nintendo_gameboy.csv` and `console_nintendo_gameboycolor.csv`).
    License: "GameDataBase © 2024 by PigSaint is licensed under
    [CC BY 4.0](https://creativecommons.org/licenses/by/4.0/)"
  - https://github.com/libretro/libretro-database (files
    `metadat/no-intro/Nintendo - Game Boy.dat` and
    `metadat/no-intro/Nintendo - Game Boy Color.dat`), licensed under
    [CC BY-SA 4.0](https://creativecommons.org/licenses/by-sa/4.0/)
- Changes (modified): Cartouche keeps a subset of the GameDataBase columns
  (title, developer, year, region, main genre, players, platform), adds the
  No-Intro game name from libretro-database for the same SHA-1 (with the
  characters libretro-thumbnails replaces in file names turned into `_`), and
  writes the rows keyed by SHA-1 into JSON.
- The combined file `gamedb.json` is licensed under
  [CC BY-SA 4.0](https://creativecommons.org/licenses/by-sa/4.0/). No
  endorsement by PigSaint or libretro is implied.

### Fonts

- Archivo, Copyright 2020 The Archivo Project Authors
  (https://github.com/Omnibus-Type/Archivo), SIL Open Font License 1.1,
  shipped unmodified as WOFF2 via `@fontsource-variable/archivo`. The license
  text is in `gb-web/public/licenses/OFL-Archivo.txt`, published with the app
  at `licenses/OFL-Archivo.txt`. It is the only typeface the app ships or loads.

### npm packages compiled into the web app

The production bundle includes React, React DOM, React Router, Zustand and
Scheduler (all MIT); Trystero with `@trystero-p2p/core`, `@trystero-p2p/nostr`
and `@noble/secp256k1` (all MIT; online link cable and device sync); `uqr`
(MIT) and `qr` (MIT OR Apache-2.0) for QR codes; the small runtime helpers of
Vite and Rolldown (MIT); and the Archivo font files (OFL-1.1, see above). Everything else is build tooling (Vite and its
plugins, Tailwind CSS, TypeScript, ESLint, SWC, Lightning CSS and their
dependencies), used at build time only and not redistributed in the published
app, even where `package.json` lists it under `dependencies`. Licenses in
`gb-web/package-lock.json` at the time of the 1.0.0 release:

- Packages under `dependencies` and their dependencies: MIT, ISC, Apache-2.0,
  BSD-3-Clause, 0BSD (tslib), OFL-1.1 (`@fontsource-variable/archivo`) and
  MPL-2.0 (Lightning CSS, build-time only, unmodified).
- Development-only dependencies additionally include BSD-2-Clause,
  BlueOak-1.0.0, Python-2.0 (argparse) and CC-BY-4.0 (caniuse-lite data).

The build writes `THIRD_PARTY_LICENSES.txt` next to the app (see
`gb-web/vite.config.ts`): the full license text of every npm package found in
the production bundle, of the Archivo font package, and of every Rust crate
linked into the WebAssembly core. Every build (the Pages site and the release
zip) also carries this notice file as `THIRD_PARTY_NOTICES.txt` and the
Cartouche license as `LICENSE.txt`; the in-app Legal page links to all three.

### Cartouche boot ROMs, modified from SameBoy's (compiled into the WebAssembly core)

- Files: `gb-core/boot/{dmg,cgb,sgb}_{registration,insert,shelf}.bin` and
  `gb-core/boot/cgb_plain.bin` (2816 bytes each), embedded in the core with
  `include_bytes!` (`gb-core/src/boot_rom.rs`). Source:
  `gb-core/boot-src/cartouche_boot.asm`; `gb-core/boot-src/build.sh` rebuilds
  every binary byte for byte (rgbds 1.0.4, the animation tables generated by
  `gen.mjs` from the approved concept model in `reference/concepts.mjs`).
- Work: a modified version of the boot ROMs of SameBoy, © 2015-2026 Lior
  Halphon (https://github.com/LIJI32/SameBoy, tag `v1.0.3`,
  `BootROMs/dmg_boot.asm`, `cgb_boot.asm` and `sgb_boot.asm`). Original code,
  not Nintendo's boot ROMs; none of the binaries contains Nintendo's boot ROM
  or its logo bytes (the guard scans them).
- Changes (2026, Cartouche): SameBoy's logo, animation and chime are replaced by
  three original start-up animations and chimes (Registration, Insert, Shelf
  pick), also on the Game Boy and Super Game Boy; the cartridge's logo is never
  read, shown, copied or checked (the Super Game Boy header packets send zeros
  in its place); VRAM, OAM and the registers the animation used are reset
  before the hand-over. Kept from SameBoy: hardware set-up, post-boot register
  values, the Game Boy Color's per-game palette table and the 12 palettes
  chosen with a button combination, the Super Game Boy header packets and the
  hand-over. `cgb_plain.bin` is the Game Boy Color one without an animation.
  The images run from `$0200` to `$0AFF` (a Game Boy Color maps `$0200`-`$08FF`),
  which Cartouche's core maps while they run.
- SHA-256: pinned in `scripts/check-no-game-data.sh`, which fails on any other
  boot ROM image.
- Also from SameBoy (same tag): the Game Boy Color and Game Boy Advance LCD
  colour curves and the green/blue mixing of its default colour correction
  (`Core/display.c`: `scale_channel_with_curve`, `scale_channel_with_curve_agb`
  and `GB_convert_rgb15`), ported to TypeScript and GLSL in
  `gb-web/src/shaders/lcd-curves.ts` and `color.glsl` for the Screen settings'
  GBC LCD and GBA LCD colour correction.
- Also from SameBoy (same tag): the APU's 2 MHz channel timing, for CGB-E and
  DMG-B, ported to Rust in `gb-core/src/apu.rs`. This covers the start delays,
  the duty step on restart, the envelope clock and its lock, CH1's delayed
  sweep calculation, and the NRx2 write glitch ("zombie mode"), all from
  `Core/apu.c`.
- License: Expat (MIT), which covers every file of the SameBoy repository
  except its `iOS` and `HexFiend` directories, so the boot ROMs this fork is
  made from, the colour curves and the APU timing:

```
Expat License

Copyright (c) 2015-2026 Lior Halphon

Permission is hereby granted, free of charge, to any person obtaining a copy
of this software and associated documentation files (the "Software"), to deal
in the Software without restriction, including without limitation the rights
to use, copy, modify, merge, publish, distribute, sublicense, and/or sell
copies of the Software, and to permit persons to whom the Software is
furnished to do so, subject to the following conditions:

The above copyright notice and this permission notice shall be included in all
copies or substantial portions of the Software.

THE SOFTWARE IS PROVIDED "AS IS", WITHOUT WARRANTY OF ANY KIND, EXPRESS OR
IMPLIED, INCLUDING BUT NOT LIMITED TO THE WARRANTIES OF MERCHANTABILITY,
FITNESS FOR A PARTICULAR PURPOSE AND NONINFRINGEMENT. IN NO EVENT SHALL THE
AUTHORS OR COPYRIGHT HOLDERS BE LIABLE FOR ANY CLAIM, DAMAGES OR OTHER
LIABILITY, WHETHER IN AN ACTION OF CONTRACT, TORT OR OTHERWISE, ARISING FROM,
OUT OF OR IN CONNECTION WITH THE SOFTWARE OR THE USE OR OTHER DEALINGS IN THE
SOFTWARE.
```

### rcheevos (compiled into the web app as WebAssembly)

- File: `gb-web/src/vendor/rcheevos.js`, built by `gb-web/rcheevos/build.sh`
  with emscripten from `gb-web/rcheevos/shim.c` and the rcheevos source. It is
  loaded only once a player signs in to unlock RetroAchievements.
- Work: rcheevos, © 2018 RetroAchievements.org
  (https://github.com/RetroAchievements/rcheevos, tag `v12.5.0`, archive
  SHA-256 pinned in `build.sh`). Unmodified; `shim.c` (Cartouche, MIT) bridges
  its `rc_client` to JavaScript.
- The module also contains emscripten's JavaScript runtime and C library
  support code, under emscripten's own licenses (MIT and
  University of Illinois/NCSA).
- License: MIT (copy in `gb-web/src/vendor/rcheevos.LICENSE`):

```
MIT License

Copyright (c) 2018 RetroAchievements.org

Permission is hereby granted, free of charge, to any person obtaining a copy
of this software and associated documentation files (the "Software"), to deal
in the Software without restriction, including without limitation the rights
to use, copy, modify, merge, publish, distribute, sublicense, and/or sell
copies of the Software, and to permit persons to whom the Software is
furnished to do so, subject to the following conditions:

The above copyright notice and this permission notice shall be included in all
copies or substantial portions of the Software.

THE SOFTWARE IS PROVIDED "AS IS", WITHOUT WARRANTY OF ANY KIND, EXPRESS OR
IMPLIED, INCLUDING BUT NOT LIMITED TO THE WARRANTIES OF MERCHANTABILITY,
FITNESS FOR A PARTICULAR PURPOSE AND NONINFRINGEMENT. IN NO EVENT SHALL THE
AUTHORS OR COPYRIGHT HOLDERS BE LIABLE FOR ANY CLAIM, DAMAGES OR OTHER
LIABILITY, WHETHER IN AN ACTION OF CONTRACT, TORT OR OTHERWISE, ARISING FROM,
OUT OF OR IN CONNECTION WITH THE SOFTWARE OR THE USE OR OTHER DEALINGS IN THE
SOFTWARE.
```

### Rust crates compiled into the WebAssembly core

`wasm-bindgen`, `js-sys`, `thiserror` and `log`, and their dependencies
`wasm-bindgen-shared`, `once_cell`, `cfg-if`, `unicode-ident`, `futures-util`,
`futures-core`, `futures-task` and `pin-project-lite`, each licensed MIT OR
Apache-2.0 (`unicode-ident` additionally Unicode-3.0), and `slab` (MIT).
The full license text of each one ships in `THIRD_PARTY_LICENSES.txt`, the
complete list for the published build.
Test-only crates (`wasm-bindgen-test`, `png`, `flate2`) are MIT OR Apache-2.0
and are not part of the published build.

## 2. Used at runtime, never bundled or redistributed

### libretro-thumbnails (box art)

- Source: https://github.com/libretro-thumbnails (the `Nintendo_-_Game_Boy`
  and `Nintendo_-_Game_Boy_Color` repositories).
- Not the covers of the bundled Tobu Tobu Girl games or of the four hosted GB
  Studio games, which ship with the app (see section 1) and load without any
  request to another site.
- The box art images are the property of their respective copyright holders.
  Cartouche does **not** copy, host or redistribute any of them: the player's
  browser requests an image directly from `raw.githubusercontent.com` only
  for a recognized ROM the player added, and only after the player agreed in
  the "Show box art?" dialog (first launch, or Settings > Storage; off by
  default). Downloaded images are kept in that browser's Cache Storage only
  and can be deleted in Settings > Storage.
- Those requests go to GitHub, which receives the player's IP address and
  browser details; see the
  [GitHub General Privacy Statement](https://docs.github.com/en/site-policy/privacy-policies/github-general-privacy-statement).
  No other server is contacted for box art (except itch.io for the covers of
  GB Studio games, below): fonts are served with the app.
- The file names used to build those URLs come from `gamedb.json` (see above;
  factual data, no images).

### itch.io (covers of GB Studio games)

- For the GB Studio games Cartouche doesn't host, `gb-web/src/data/gbstudio.json` stores only the address
  (`remoteCover`) of the cover image on the author's itch.io page, its `og:image`, read by
  `scripts/gbstudio-covers.mjs`, which downloads no image.
- The images belong to their authors. Cartouche does **not** copy, host or redistribute any of them: the
  player's browser loads one directly from `img.itch.zone`, only after the player agreed in the
  "Show box art?" dialog (the same consent as box art above), and keeps it only in its ordinary HTTP cache.
- Those requests go to itch.io, which receives the player's IP address and browser details; see the
  [itch.io privacy policy](https://itch.io/docs/legal/privacy-policy).

### RetroAchievements (achievements, badges and unlocking)

- Source: the RetroAchievements Web API (https://retroachievements.org/API/),
  badge images from `media.retroachievements.org`, and, for unlocking, the
  emulator API (`https://retroachievements.org/dorequest.php`) reached through
  Cartouche's relay (below).
- Achievement titles, descriptions and badge images belong to RetroAchievements
  and their authors. Cartouche does **not** copy, host or redistribute any of
  them: the player's browser requests them, and only after the player
  connected their own RetroAchievements account in Settings > Achievements
  (off by default; "Disconnect" stops every request) or signed in under
  "Unlock while playing" ("Sign out" stops it). See `docs/RETROACHIEVEMENTS.md`.
- The Web API requests go to RetroAchievements, which receives the player's IP
  address, browser details, username and web API key; for the list, ROMs and
  their hashes are not sent. When unlocking, RetroAchievements receives the
  username, the password once at sign-in (never stored by Cartouche) and then
  the session token, the ROM's MD5 hash, unlocks, leaderboard entries and
  rich presence pings.
- Relay: a Cloudflare Worker run by the Cartouche maintainer
  (`relay/retroachievements/`, `https://cartouche-ra.phmatray.workers.dev`)
  adds CORS and the emulator's `User-Agent`, forwards the requests to
  `dorequest.php` and keeps nothing (no logs, no storage). Cloudflare, its
  host, receives the requests (IP address and contents); see the
  [Cloudflare privacy policy](https://www.cloudflare.com/privacypolicy/).
- RetroAchievements does not endorse Cartouche.

### Nostr relays and STUN servers (online link cable and device sync)

- Public Nostr relays run by third parties, not by Cartouche:
  `relay02.lnfi.network`, `staging.yabu.me`, `top.testrelay.top`, `yabu.me`
  and `relay.mostro.network` (list in `gb-web/src/lib/p2p/room.ts`), and the
  public STUN servers of Google and Cloudflare (Trystero's defaults).
- Contacted only after the player opens or joins a room (Link Cable > Play
  online) or pairs a device (Settings > Sync); nothing is contacted before.
- The relays carry only the WebRTC handshake, encrypted, but they see the IP
  addresses of both browsers, and each peer learns the other's. Game and sync
  data then go directly between the two browsers. A TURN server the player
  adds (Connection settings) relays the connection when a direct one fails.
  See `docs/ONLINE_LINK.md` and `docs/SYNC.md`.
- None of these operators endorses Cartouche.

## 3. Downloaded for testing only, never distributed

The emulator test suite runs against third-party test ROMs that are
downloaded by `scripts/fetch-test-roms.sh` into `gb-core/test-roms/`, which is
git-ignored. Those downloaded copies are not part of this repository, the web
app or any release. (Four of the same files, `cpu_instrs.gb`, `dmg-acid2.gb`,
`cgb-acid2.gbc` and `ucity.gbc`, are also bundled with the app; see section 1.
The test suite checks the bundled copies too.)

- Blargg's Game Boy test ROMs (Shay Green), via https://github.com/retrio/gb-test-roms
- dmg-acid2 and cgb-acid2 (Matt Currie), MIT License,
  https://github.com/mattcurrie/dmg-acid2 and https://github.com/mattcurrie/cgb-acid2

### Conformance suites (not distributed)

`gb-core/tests/conformance.rs` runs these suites from `gb-core/test-roms/conformance/` (git-ignored).
`scripts/fetch-test-roms.sh` downloads them prebuilt, with their reference screenshots, as one
archive pinned by SHA-256: c-sp/game-boy-test-roms v7.0 (Christoph Sprenger, MIT),
https://github.com/c-sp/game-boy-test-roms. They are downloaded for testing only and never distributed.

| Suite | Author | License | Upstream |
|-------|--------|---------|----------|
| Mooneye Test Suite | Joonas Javanainen (Gekkio) | MIT | https://github.com/Gekkio/mooneye-test-suite |
| Mealybug Tearoom Tests | Matt Currie | MIT | https://github.com/mattcurrie/mealybug-tearoom-tests |
| SameSuite | Lior Halphon (LIJI32) | X11 (MIT) | https://github.com/LIJI32/SameSuite |
| Age test ROMs | Christoph Sprenger | MIT | https://github.com/c-sp/age-test-roms |
| GBMicrotest | Austin Appleby | MIT | https://github.com/aappleby/GBMicrotest |
| rtc3test | aaaaaa123456789 | The Unlicense | https://github.com/aaaaaa123456789/rtc3test |

### Homebrew smoke-test ROMs (not distributed)

`gb-core/tests/homebrew.rs` runs these freely licensed homebrew games from
`gb-core/test-roms/homebrew/` (git-ignored; a missing file skips its test locally and fails it in CI).
`scripts/fetch-test-roms.sh` downloads them from the listed sources (the
author's release, or the author's upload on the gbdev Homebrew Hub), pinned by
SHA-256.

| Title | Author | License | Source |
|-------|--------|---------|--------|
| µCity (`ucity.gbc`, `ucity_compat.gbc`) | Antonio Niño Díaz | GPL-3.0-or-later | https://github.com/AntonioND/ucity (release v1.3) |
| Geometrix | Antonio Niño Díaz | GPL-3.0-or-later | https://github.com/AntonioND/geometrix, via https://hh.gbdev.io/game/geometrix |
| Aevilia (tech demo) | ISSOtm, Kai, Parzival, Charmy | Apache-2.0 | https://github.com/ISSOtm/Aevilia-GB, via https://hh.gbdev.io/game/aevilia |
| CatMario GB | Lazy_V | MIT | https://github.com/zzxzzk115/CatMarioGB, via https://hh.gbdev.io/game/catmario-gb |
| A Slime Travel | Dribble Studios | zlib | https://hh.gbdev.io/game/a-slime-travel |
| GBHack | statico | MIT | https://github.com/statico/gbhack, via https://hh.gbdev.io/game/gbhack |
| Labirinth | godai / Gniazdo Światów | CC BY-SA 4.0 | https://github.com/godai78/labirinth, via https://hh.gbdev.io/game/labirinth |
| 144p Test Suite (`gb240p.gb`) | Damian Yerrick | zlib / GPL-2.0 (see the repository) | https://github.com/pinobatch/240p-test-mini (release v0.23) |
| Shock Lobster | tbsp | zlib | https://github.com/tbsp/shock-lobster (release 3) |

CatMario GB is an independent fan game, not affiliated with Nintendo; it is
used only as an emulator test input and is never distributed.

## Trademarks

Game Boy, Game Boy Color and Nintendo are trademarks of Nintendo. Game titles
shown in the catalog are trademarks of their respective owners and are used
only to identify the games. Cartouche is not affiliated with, sponsored by or
endorsed by Nintendo or any of these owners.
