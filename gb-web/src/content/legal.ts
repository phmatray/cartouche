// In-app legal notice, rendered at /legal. Keep in sync with docs/LEGAL.md.
// Bodies are plain text; paragraphs are separated by a blank line ("\n\n").

// `links` are files published next to the app (relative to its base URL), rendered as a list.
// Translations: legal.fr.ts and legal.es.ts (same sections, same URLs; the English text prevails).
export interface LegalSection { title: string; body: string; links?: Array<{ file: string; label: string }> }
export const LEGAL_SECTIONS: LegalSection[] = [
  {
    title: 'Disclaimer',
    body:
      'Cartouche is an independent, open-source emulator for Game Boy and Game Boy Color games. ' +
      'It is not affiliated with, sponsored by or endorsed by Nintendo. Game Boy, Game Boy Color ' +
      'and Nintendo are trademarks of Nintendo. Game titles are trademarks of their respective ' +
      'owners and are used only to identify games.\n\n' +
      'Cartouche is provided "as is", without warranty of any kind, under the MIT License. You are ' +
      'responsible for making sure the files you load are ones you have the right to use.',
  },
  {
    title: 'What Cartouche contains',
    body:
      'An emulator that contains no Nintendo code and no copy of the Nintendo logo. It includes the open-source ' +
      'boot ROMs of SameBoy, © 2015-2026 Lior Halphon, MIT License (https://github.com/LIJI32/SameBoy): original ' +
      'code, not Nintendo\'s. By default games start directly in the documented post-boot state; the Game Boy ' +
      'Color colours of an original Game Boy game, when chosen, are worked out by that boot ROM out of sight. ' +
      'The start-up animation is off by default. Turned on (Settings > Emulation), it shows the logo read from ' +
      'the game\'s own cartridge, as the console does. Super Game Boy borders and colors are drawn from the data ' +
      'each game sends; no Super Game Boy or SNES software is included.\n\n' +
      'Three free homebrew games, redistributed unmodified from their authors\' official releases:\n\n' +
      'Tobu Tobu Girl and Tobu Tobu Girl Deluxe, © 2017 Tangram Games (sources: ' +
      'https://github.com/SimonLarsen/tobutobugirl and https://github.com/SimonLarsen/tobutobugirl-dx). ' +
      'Code under the MIT License; graphics, text, sound and music under CC BY 4.0 ' +
      '(https://creativecommons.org/licenses/by/4.0/). The release files tobu.gb and tobudx.gb are ' +
      'renamed tobutobugirl.gb and tobutobugirldx.gb. Their box art is the official key art by Tangram ' +
      'Games from their itch.io pages (https://tangramgames.itch.io/tobutobugirl and ' +
      'https://tangramgames.itch.io/tobu-tobu-girl-deluxe), CC BY 4.0, cropped to a square and resized.\n\n' +
      'µCity 1.3, © 2017-2018 Antonio Niño Díaz, under the GNU GPL version 3 or later (graphics and ' +
      'music CC BY-SA 4.0, https://creativecommons.org/licenses/by-sa/4.0/; its GBT Player engine BSD 2-Clause). The full GPL text is linked below; the ' +
      'complete corresponding source is the author\'s v1.3 tag: https://github.com/AntonioND/ucity/tree/v1.3 ' +
      '(also https://codeberg.org/SkyLyrac/ucity/src/tag/v1.3, and attached to every Cartouche release). ' +
      'µCity is a separate program the emulator loads as data (mere aggregation): its license does not ' +
      'apply to Cartouche.\n\n' +
      'Three test cartridges, redistributed unmodified: dmg-acid2 (v1.0) and cgb-acid2 (v1.1) by Matt ' +
      'Currie, MIT License (https://github.com/mattcurrie/dmg-acid2, https://github.com/mattcurrie/cgb-acid2), ' +
      'and Blargg\'s cpu_instrs by Shay Green, from https://github.com/retrio/gb-test-roms. Its author ' +
      'states no license; it is included because the emulator community widely redistributes it for ' +
      'testing, and it will be removed immediately on the author\'s request.\n\n' +
      'Four games made with GB Studio, hosted unmodified because their authors\' licenses allow redistribution ' +
      'of the whole ROM: Dawn Will Come (code MIT, art and music CC BY 4.0), Poltersprite (game CC BY-NC-SA 4.0, ' +
      'code GPL-3.0), Millennium Gun (code 0BSD, graphics and audio CC0 1.0, plugin MIT) and Dusky Dungeon (MIT, ' +
      'graphics CC BY 4.0, fonts CC BY 4.0 and CC BY 3.0). Each one is downloaded only when you ask for it. Their ' +
      'authors, sources and full license terms are in roms/gbstudio/LICENSES.txt, linked below. The other games ' +
      'of the GB Studio collection are not hosted: they link to their authors\' pages.\n\n' +
      'A database of known Game Boy and Game Boy Color dumps (file fingerprints, titles and No-Intro ' +
      'names), used only to identify files you add. The library lists free homebrew, freely available ' +
      'test cartridges and your own ROMs, never commercial games. No images of commercial games.',
  },
  {
    title: 'No ROMs provided',
    body:
      'Cartouche does not include, host, link to or help you find ROMs of commercial games, or BIOS ' +
      'files, and does not list commercial games. Its database of known dumps only recognizes a ' +
      'file you load yourself.\n\n' +
      'Play games you own, using backups you made yourself from your own cartridges. Laws on backups ' +
      'differ between countries; check yours.',
  },
  {
    title: 'Box art',
    body:
      'The two Tobu Tobu Girl games ship with their own covers (freely licensed, see above): they are ' +
      'files of this app, shown without asking and without contacting any other site. Every other ' +
      'cover is off by default and never hosted or redistributed by Cartouche. Those images belong to ' +
      'the game publishers and other copyright holders. On first launch a dialog asks "Show box art?". ' +
      'Only if you choose "Download box art" (or later turn box art on in Settings > Storage and agree) ' +
      'does your browser download the cover of each recognized ROM you added, directly from the ' +
      'libretro-thumbnails project on GitHub (https://github.com/libretro-thumbnails, served from ' +
      'raw.githubusercontent.com), and keep it in this browser\'s storage (Cache Storage). Your answer ' +
      'and its date are saved in your settings, and restoring a backup never changes them. You are ' +
      'asked again only if you turn box art on after saying no, or after "Erase everything". With ' +
      '"Continue without" (or Escape), the app makes no request to libretro-thumbnails at all. ' +
      'Settings > Storage shows the space the covers use, deletes them ("Delete downloaded box art", ' +
      'which also turns box art off) and downloads them again for your library.',
  },
  {
    title: 'Game metadata',
    body:
      'Titles, developers, release dates and genres come from GameDataBase © 2024 by PigSaint ' +
      '(https://github.com/PigSaint/GameDataBase), licensed under CC BY 4.0 ' +
      '(https://creativecommons.org/licenses/by/4.0/). No-Intro names come from libretro-database ' +
      '(https://github.com/libretro/libretro-database), licensed under CC BY-SA 4.0 ' +
      '(https://creativecommons.org/licenses/by-sa/4.0/). Modified: Cartouche keeps a subset of the ' +
      'columns, joins the two by file hash and publishes the combined file (gamedb.json) under ' +
      'CC BY-SA 4.0. Neither project endorses Cartouche.',
  },
  {
    title: 'Privacy',
    body:
      'No account, no server, no analytics, no advertising, no cookies.\n\n' +
      'Your ROMs, saves, save states, settings, favorites and play time are stored only in this ' +
      'browser (IndexedDB and localStorage) and never leave your device, unless you turn on device sync ' +
      '(see below). Clear this site\'s data in your browser settings to delete everything.\n\n' +
      'Only GitHub receives requests, unless you connect RetroAchievements, play online or turn on device ' +
      'sync (see below). GitHub Pages serves the app and its fonts. Box art is off by ' +
      'default and needs your yes (first-launch dialog or Settings > Storage); only then does the ' +
      'browser also load covers of recognized ROMs you added from raw.githubusercontent.com. Like any ' +
      'web server, GitHub receives ' +
      'your IP address and browser details; see the GitHub General Privacy Statement ' +
      '(https://docs.github.com/en/site-policy/privacy-policies/github-general-privacy-statement).\n\n' +
      'Downloaded box art is kept in this browser (Cache Storage) and never sent anywhere. Delete it anytime with ' +
      '"Delete downloaded box art" in Settings > Storage, or by clearing the site data.\n\n' +
      'RetroAchievements is off until you connect in Settings > Achievements with your username and web API key (never your ' +
      'password). Both stay in this browser (localStorage). While connected, the browser asks retroachievements.org (' + 
      'https://retroachievements.org) for the game lists of both consoles and, for a game you open, its achievements and ' +
      'which ones you earned; the key and username go in those requests, as its Web API requires. It identifies a ROM by ' +
      'comparing its MD5 fingerprint with those lists in the browser: the ROM and its fingerprint are never sent. ' +
      'RetroAchievements receives your IP address and browser details. "Disconnect" forgets the key and stops every request.\n\n' +
      'Play online (Link Cable) and device sync (Settings > Sync) make no request until you open or join a room, or ' +
      'pair a device. Then your browser contacts five public Nostr relays that Cartouche does not run ' +
      '(relay02.lnfi.network, staging.yabu.me, top.testrelay.top, yabu.me and relay.mostro.network) to find the ' +
      'other browser, and public STUN servers run by Google and Cloudflare to learn its own network address. The ' +
      'relays carry only an encrypted handshake, but they see the IP addresses of both browsers, and the other ' +
      'player or device learns yours: that is how a direct (WebRTC) connection works. Game and sync data then go ' +
      'directly from one browser to the other, encrypted, through no Cartouche server. If you add your own TURN ' +
      'server (Play online > Connection settings), a connection that cannot go direct goes through it.',
  },
  {
    title: 'Takedown requests',
    body:
      'If you believe something in Cartouche infringes your rights, open a "Takedown request" issue ' +
      'at https://github.com/phmatray/cartouche/issues/new/choose (issues are public). For a ' +
      'non-public request, use GitHub\'s DMCA process ' +
      '(https://docs.github.com/en/site-policy/content-removal-policies/dmca-takedown-policy); the ' +
      'project has no private email address.\n\n' +
      'The maintainer aims to respond within 72 hours. Content that is plausibly infringing is ' +
      'disabled first and reviewed afterwards.',
  },
  {
    title: 'Open source',
    body:
      'Source code: https://github.com/phmatray/cartouche (MIT License). The license texts below ' +
      'are published with the app, and THIRD_PARTY_NOTICES.md in the repository holds the same notices.',
    links: [
      { file: 'LICENSE.txt', label: 'Cartouche license (MIT)' },
      { file: 'THIRD_PARTY_NOTICES.txt', label: 'Third-party notices (bundled games and test cartridges, GameDataBase, fonts, box art)' },
      { file: 'licenses/GPL-3.0-ucity.txt', label: 'GNU GPL version 3 (µCity)' },
      { file: 'roms/gbstudio/LICENSES.txt', label: 'GB Studio collection: authors and licenses of the hosted games' },
      { file: 'THIRD_PARTY_LICENSES.txt', label: 'Full licenses of the bundled npm packages, Rust crates and fonts' },
    ],
  },
];
