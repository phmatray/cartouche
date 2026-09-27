# Legal notice

This page explains what Cartouche is, what it contains, what it does not
contain, and how to reach the maintainer about a rights issue. The same text
is shown in the app at `/legal`.

## Disclaimer

Cartouche is an independent, open-source emulator for Game Boy and Game Boy
Color games. It is not affiliated with, sponsored by or endorsed by Nintendo.
Game Boy, Game Boy Color and Nintendo are trademarks of Nintendo. Game titles
and other names are trademarks of their respective owners and are used only
to identify games.

Cartouche is provided "as is", without warranty of any kind, under the
[MIT License](../LICENSE). You are responsible for making sure the files you
load into it are ones you have the right to use.

## What Cartouche contains

- An emulator written from public hardware documentation. It contains **no
  Nintendo code**: no Nintendo BIOS or boot ROM is included, and no copy of the
  Nintendo logo. It includes the open-source boot ROMs of
  [SameBoy](https://github.com/LIJI32/SameBoy) (© 2015-2026 Lior Halphon, MIT
  License), original code. By default games start directly in the documented
  post-boot state; the Game Boy Color colours of an original Game Boy game, when
  chosen, are worked out by that boot ROM out of sight. The start-up animation
  is **off by default**. Turned on (Settings › Emulation), it shows the logo read
  from the game's own cartridge, as the console does. Super Game Boy borders and
  colors are drawn from the data each game sends; no Super Game Boy or SNES
  software is included.
- Three free homebrew games, redistributed unmodified from their authors'
  official releases:
  - *Tobu Tobu Girl* and *Tobu Tobu Girl Deluxe*, © 2017 Tangram Games
    ([source](https://github.com/SimonLarsen/tobutobugirl),
    [Deluxe source](https://github.com/SimonLarsen/tobutobugirl-dx)). Code
    under the MIT License; graphics, text, sound and music under
    [CC BY 4.0](https://creativecommons.org/licenses/by/4.0/). The release
    files `tobu.gb` and `tobudx.gb` are renamed `tobutobugirl.gb` and
    `tobutobugirldx.gb`.
  - *µCity* 1.3, © 2017-2018 Antonio Niño Díaz, under the GNU GPL version 3
    or later (graphics and music
    [CC BY-SA 4.0](https://creativecommons.org/licenses/by-sa/4.0/); its GBT Player engine BSD
    2-Clause). The full GPL text ships with the app
    (`licenses/GPL-3.0-ucity.txt`), and the complete corresponding source is
    the author's v1.3 tag: https://github.com/AntonioND/ucity/tree/v1.3
    (also https://codeberg.org/SkyLyrac/ucity/src/tag/v1.3, and attached to
    every Cartouche release as `ucity-1.3-source.tar.gz`).
    µCity is a separate program the emulator loads as data (mere
    aggregation); its license does not apply to Cartouche.
- Three test cartridges, redistributed unmodified:
  - *dmg-acid2* (v1.0) and *cgb-acid2* (v1.1) by Matt Currie, MIT License
    ([dmg-acid2](https://github.com/mattcurrie/dmg-acid2),
    [cgb-acid2](https://github.com/mattcurrie/cgb-acid2)).
  - Blargg's *cpu_instrs* by Shay Green, from the
    [retrio/gb-test-roms](https://github.com/retrio/gb-test-roms) collection.
    Its author states no license. It is included because it is widely
    redistributed by the emulator community for testing, and it will be
    removed immediately on the author's request.
- A database of known Game Boy and Game Boy Color dumps (SHA-1 fingerprints,
  titles, No-Intro names), used only to identify files you add. The library
  lists free homebrew, freely available test cartridges and your own ROMs,
  never commercial games. No images of
  commercial games.

See [THIRD_PARTY_NOTICES.md](../THIRD_PARTY_NOTICES.md) for every third-party
work and its license. Every build of the web app (GitHub Pages and the
release zip) ships `LICENSE.txt`, `THIRD_PARTY_NOTICES.txt` and
`THIRD_PARTY_LICENSES.txt` (the full license of each bundled npm package,
Rust crate and font), linked from the in-app Legal page.

## No-ROM policy

- Cartouche does not include, host, link to or help you find ROMs of
  commercial games, or BIOS/boot ROM files.
- Commercial games are not listed. The database of known dumps only
  recognizes a file you load yourself; it never provides the game.
- Play games you own, using backups you made yourself from your own
  cartridges. Laws on backups differ between countries; check yours.
- Issues, pull requests, discussions and any other project space must not
  contain ROMs, BIOS files, other copyrighted game material, or links to
  them. Such content is removed and repeat offenders are blocked.

## Box art

Box art is **off by default** and is **never hosted or redistributed by
Cartouche**. The images belong to the game publishers and other copyright
holders. On first launch a dialog asks "Show box art?"; only if you choose
"Download box art" (or later turn box art on in Settings > Storage and agree)
does your browser download the cover of each recognized ROM you added,
directly from the [libretro-thumbnails](https://github.com/libretro-thumbnails)
project on GitHub (`raw.githubusercontent.com`), and keep it in this
browser's storage (Cache Storage). Your answer and its date are saved in your
settings, and restoring a backup never changes them. You are asked again only
if you turn box art on after saying no, or after "Erase everything". With
"Continue without" (or Escape),
the app makes no request to libretro-thumbnails at all. Settings > Storage
shows the space the covers use, deletes them ("Delete downloaded box art",
which also turns box art off) and downloads them again for your library.

## Game metadata

Titles, developers, release dates, genres and similar facts come from
GameDataBase © 2024 by PigSaint (https://github.com/PigSaint/GameDataBase),
licensed under [CC BY 4.0](https://creativecommons.org/licenses/by/4.0/).
No-Intro game names come from
[libretro-database](https://github.com/libretro/libretro-database), licensed
under [CC BY-SA 4.0](https://creativecommons.org/licenses/by-sa/4.0/).
Modified: Cartouche keeps a subset of the columns and joins the two by SHA-1
file hash; the combined `gamedb.json` is licensed under CC BY-SA 4.0. Neither
PigSaint nor libretro endorses Cartouche.

## Privacy

- No account, no server-side component, no analytics, no advertising, no
  cookies.
- Your ROMs, saves, save states, settings, favorites and play time are stored
  only in your browser (IndexedDB and localStorage) and never leave your
  device.
- Only GitHub receives requests, unless you connect RetroAchievements (below).
  GitHub Pages serves the app and its fonts.
  Box art is off by default and needs your yes in the first-launch dialog
  (or in Settings > Storage); only then does the browser also load covers of
  recognized ROMs you added from `raw.githubusercontent.com`. Like any web
  server, GitHub receives your IP address and browser details; see the
  [GitHub General Privacy Statement](https://docs.github.com/en/site-policy/privacy-policies/github-general-privacy-statement).
- Downloaded box art is kept in this browser (Cache Storage) and never sent
  anywhere. Delete it anytime with "Delete downloaded box art" in Settings >
  Storage, or by clearing the site data.
- RetroAchievements is off until you connect in Settings > Achievements with
  your username and web API key (never your password). Both stay in this
  browser (localStorage). While connected, the browser asks
  `retroachievements.org` for the game lists of both consoles and, for a game
  you open, its achievements and which ones you earned; the key and username go
  in those requests, as its Web API requires. A ROM is matched by comparing its
  MD5 with those lists in the browser: the ROM and its hash are never sent.
  RetroAchievements receives your IP address and browser details.
  "Disconnect" forgets the key and stops every request.
- To delete all Cartouche data, clear the site data for Cartouche in your
  browser settings.

## Takedown requests

If you believe something in this repository or the hosted app infringes your
rights, you can (the author of a bundled ROM can simply ask for it to be
removed, and it will be):

1. Open a [Takedown request](https://github.com/phmatray/cartouche/issues/new?template=takedown_request.yml)
   issue. Identify the work, the exact location (file path, URL or issue
   link) and the basis of your claim. Issues are public: do not include
   contact details you do not want published.
2. For a non-public request, use GitHub's official process:
   [DMCA takedown policy](https://docs.github.com/en/site-policy/content-removal-policies/dmca-takedown-policy)
   and [submit a notice](https://github.com/contact/dmca). The project has no
   private email address; GitHub's form is the private route.

The maintainer aims to respond to takedown requests within 72 hours. Content
that is plausibly infringing is disabled first and reviewed afterwards; valid
requests lead to the content being removed from the repository, the hosted
app and, where needed, the git history.
