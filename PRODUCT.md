# Product

<!-- impeccable:product-schema 1 -->

## Platform

web

## Users

Public retro players who bring their own Game Boy / Game Boy Color ROMs and use the site as their everyday handheld library. They browse, pick something, and play in seconds. They play on three kinds of screen: a laptop or desktop (keyboard or gamepad), a phone (touch controls), and a TV (gamepad, from the couch). All three are first-class.

## Product Purpose

A browser-based Game Boy / Game Boy Color emulator (Rust core compiled to WASM) wrapped in a streaming-service-style library: browse a catalog, open a title, play it instantly, and come back later to saves, favorites and play time. Success means a player gets from landing to playing in a few seconds, and the library feels like a collection they own and keep coming back to.

## Positioning

Everything runs client-side: emulation, saves and the ROM library live in the player's own browser (IndexedDB), with no account and no server. The library lists free homebrew plus the player's own ROMs, never commercial titles; a player's files are recognized by SHA-1 against a database of known Game Boy and Game Boy Color dumps (GameDataBase joined with libretro-database) and dressed with metadata automatically, and with box art if the player opts in.

## Operating Context

- Routes: `/` library, `/game/:id` player, `/settings`, `/link-cable` (two-player link cable lobby), `/link-cable/online` (the same over the internet, peer to peer; see docs/ONLINE_LINK.md).
- Input: keyboard (arrows, Z/X, Enter/Shift, F fullscreen, F5/F8 quick save/load, hold R to rewind), Gamepad API, on-screen touch controls on mobile.
- Library sources: curated `catalog.json` (freely licensed homebrew only; Tobu Tobu Girl is the one bundled ROM) and user-imported ROMs ("My Collection"), with SHA-1 lookup against `gamedb.json`.
- Catalog entries without a ROM open a player page that asks the user to load their own file, which is then linked to that entry.

## Capabilities and Constraints

- Player features: play/pause, speed 0.5x to 4x, rewind buffer, 5 save-state slots with thumbnails, battery SRAM auto-save, LCD shader presets (WebGL, with Canvas 2D fallback), fullscreen with auto-hiding HUD, mute, debug drawer (registers, memory, VRAM, serial, audio channels). Cartridge peripherals: the pocket camera sees through the player's camera (or a photo), a Game Boy Printer sits on the link port in solo play (prints feed out of a tray, go to the album, export as 4× PNG, share, print), and rumble cartridges drive gamepad motors or phone vibration (Android). iPhone gives websites no vibration: while the motor runs, taps on the touch buttons toggle a hidden switch, which may give a light system tick (unverified on hardware); a gamepad with rumble is the full effect there.
- Library features: faceted search (genre, players, region, platform, decade/year, developer, publisher, language, save, your games; `genre:rpg -region:jp` syntax with autocomplete; kept in the URL as `/?q=`, and every game fact links into it), sort (name, recently played, most played, date added), favorites, region filter (US/EU/JP), grid/list views, A–Z jump, bulk ROM import with duplicate detection, delete ROM + saves.
- Settings: keybindings, display (shader, scale; Game Boy Color games always show their own colors), audio (volume, channel mutes), emulation (default speed, rewind buffer, auto-save), storage (box art switch, size and delete, backup), sync (pair devices by QR code, sync now or automatically). Start-up animation (Settings › Emulation: Registration by default (off under reduced motion), Insert, Shelf pick or off, each previewed live; Start skips it): Cartouche's own artwork and chime, from its own boot ROMs (modified from SameBoy's MIT ones, no logo shown, read or checked), never Nintendo's; original Game Boy games can run on the Game Boy Color with its automatic or chosen colours (Console, in Display and each game's Screen page); games with Super Game Boy functions play with their border and colours by default (Screen page switch, per game); the SNES sound chip is not emulated, so a game found playing its music there (about 10 s in) is switched to the Game Boy for its next start, with a notice.
- Box art is opt-in (a first-launch "Show box art?" dialog; answer stored in settings) and fetched at runtime from the libretro-thumbnails GitHub repositories, only for recognized ROMs the player added; it is usually absent, missing or slow, so every surface needs a designed no-art fallback.
- Stack: React 19, React Router 7, Zustand, Tailwind v4, Vite; `gb-core` Rust crate built with wasm-pack.
- No backend, no accounts, no cloud. Online link play and device sync (Settings › Sync: saves, states, favorites, play time and settings between the player's own paired devices, end-to-end encrypted; see docs/SYNC.md) are browser to browser (WebRTC); public Nostr relays only introduce the peers.

## Brand Commitments

- Product name: Cartouche. Game Boy and Game Boy Color are Nintendo trademarks, used only descriptively ("an emulator for Game Boy and Game Boy Color games").
- Bring-your-own-ROM posture: the app never offers downloads of commercial ROMs. Only homebrew or freely distributable ROMs have a play-now source.
- Never present Nintendo trademarks (the "Nintendo" wordmark, the "GAME BOY COLOR" logo) as Cartouche's own branding.

## Evidence on Hand

- Real catalog data: `gb-web/src/data/catalog.json` (curated homebrew) and `gb-web/src/data/gamedb.json` (ROM identification by SHA-1).
- Real box art via libretro-thumbnails (`gb-web/src/lib/cover-art.ts`).
- No screenshots, user counts, testimonials or press exist; do not fabricate them.

## Product Principles

1. Seconds to play: every surface shortens the path from choosing a game to the first frame.
2. The player's collection comes first: their ROMs, favorites and recent games outrank the generic catalog.
3. One interface for every screen: pointer, touch and gamepad/TV focus navigation are all first-class; nothing is hover-only.
4. Honest about ROMs: always clear which titles can play now and which need the player's own file.
5. The game is the star: chrome recedes once a game is running.

## Accessibility & Inclusion

- Full keyboard and gamepad navigation with a clearly visible focus state (required for TV use).
- Touch targets of at least 44px on mobile.
- Respect `prefers-reduced-motion`.
- Text legible from couch distance on TV-sized screens.
