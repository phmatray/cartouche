# RetroAchievements

Cartouche shows a player's [RetroAchievements](https://retroachievements.org) for a
cartridge and, once the player signs in for it, **unlocks** achievements while they play,
in **softcore** only. This page says how both work, what the relay does, and what the owner
still has to do for hardcore.

## Showing the list (read-only)

- **Settings › Achievements**: the player enters their RetroAchievements username and
  **web API key** (retroachievements.org › Settings › Keys). The key is checked with
  `API_GetUserProfile` and kept in this browser's `localStorage` (`cartouche-ra`), outside
  the settings backup. "Disconnect" forgets the key and the cached hash list.
- **Game page and the manual's Game tab**: for a connected player and a ROM stored in the
  browser, the list of the set's achievements with badge, points and whether (and when,
  softcore or hardcore) the player earned it, plus a link to the game on RetroAchievements.
- **Identification**: the RetroAchievements hash of a Game Boy / Game Boy Color ROM is the
  MD5 of the whole file (rcheevos `rc_hash`). For the list, it is compared **in the
  browser** with the hash lists of `API_GetGameList` (consoles 4 and 6, `h=1&f=1`), cached
  for a week; the ROM and its hash are not sent.
- The public Web API (`/API/API_*.php`) and the badge server send
  `Access-Control-Allow-Origin: *`, so the browser calls them directly.
- Code: `gb-web/src/lib/retroachievements.ts` (API calls, MD5, credentials),
  `gb-web/src/components/game/Achievements.tsx` (lazy-loaded list),
  `gb-web/src/components/settings/AchievementsTab.tsx`. No request is made while
  disconnected.

## Unlocking while playing

- **Sign-in**: Settings › Achievements › "Unlock while playing" asks for the username and
  **password once**. The password goes (through the relay) to RetroAchievements' `login2`
  and is never stored; only the session token RetroAchievements returns is kept in
  `localStorage` (`cartouche-ra-play`). "Sign out" forgets it. This is separate from the
  read-only connection above, which works as before.
- **Client**: rcheevos' `rc_client` (RetroAchievements' official C library, MIT, v12.5.0)
  compiled to WebAssembly (`gb-web/src/vendor/rcheevos.js`), driven by
  `gb-web/src/lib/ra-client.ts` and `gb-web/src/hooks/useRaSession.ts`. It is loaded only
  once a player signs in for unlocking.
- **While a recognized game runs**: `rc_client` identifies the ROM by its MD5 in the
  `achievementsets` request, so for unlocking the **hash is sent** to RetroAchievements
  (unlike the read-only list). It then checks the game's memory every frame and sends the
  session start, unlocks (`awardachievement`), leaderboard entries and periodic pings with
  rich presence (what the player is doing in the game, shown on their profile). Unlocks
  that can't be sent wait in memory and are retried while the game runs.
- **Memory**: `gb-core`'s `read_memory_ra(addr)` implements rcheevos' Game Boy memory map
  (`consoleinfo.c`): the 16-bit bus, with `$A000` cartridge RAM bank 0 and `$D000` work
  RAM bank 1; Color work RAM banks 2-7 at `$10000-$15FFF`; cartridge RAM banks 1-15 at
  `$16000-$33FFF`.
- **Softcore only.** Cartouche is not a validated emulator yet, so hardcore is not offered
  (RetroAchievements would demote hardcore unlocks from an unknown client to softcore
  anyway). Loading a save state or rewinding resets achievement progress (hit counts).

## The relay

RetroAchievements' emulator API (`https://retroachievements.org/dorequest.php`, what
`rc_client` calls) sends no CORS headers, so a page on `github.io` can't read its answers,
and it reads the emulator's identity from `User-Agent`, which browsers don't let `fetch`
set. `relay/retroachievements/worker.js` is a Cloudflare Worker, deployed at
`https://cartouche-ra.phmatray.workers.dev` and run by the project owner, that:

- accepts only the origins `https://phmatray.github.io`, `localhost` and `127.0.0.1` (403 otherwise),
  and answers the CORS preflight;
- takes the client identity from the `X-RA-Client` header
  (`Cartouche/<version> (Web) gb-core/<version>`), checks its format and sends it as
  `User-Agent`;
- forwards the POST body unchanged to `dorequest.php` and returns the answer with CORS
  headers;
- keeps nothing: no storage, and `observability` is disabled in `wrangler.toml` (no logs).

Cloudflare, as its host, receives the requests (IP address and contents, including the
username, the token, the password at sign-in, and the game hash).

Deploy (needs a Cloudflare account; `wrangler` asks to log in):

```bash
cd relay/retroachievements && npx wrangler deploy
```

For development, `VITE_RA_RELAY` overrides the relay URL the web app uses.

## Rebuilding rcheevos

`gb-web/rcheevos/build.sh` downloads the pinned rcheevos release (v12.5.0, SHA-256
checked), compiles it with `shim.c` (memory reads, server calls and events bridged to
JavaScript) into one ES module with the WebAssembly inlined, and copies rcheevos' license
to `gb-web/src/vendor/rcheevos.LICENSE`. It needs emscripten (`brew install emscripten`).

```bash
cd gb-web && rcheevos/build.sh
```

Don't edit `gb-web/src/vendor/rcheevos.js` by hand.

## What the owner has to do for hardcore (validation)

1. **Wait for eligibility.** The emulator must have been publicly available for at least
   six months (the public repository was created on 2026-09-26: eligible from 2027-03-26).
2. **Read the requirements:**
   [Hardcore compliance requirements](https://docs.retroachievements.org/general/hardcore-compliance-requirements.html)
   and the [rc_client integration guide](https://github.com/RetroAchievements/rcheevos/wiki/rc_client-integration).
   The user agent format, token login (never storing the password), the offline unlock
   queue, rich presence and leaderboards are already covered, as are the FOSS license and
   the published privacy policy (MIT and the Legal page).
3. **Ask RetroAchievements** (message the "RAdmin" account on retroachievements.org, as
   the rcheevos wiki says) to validate the `Cartouche/<version>` user agent. The relay
   sets it as `User-Agent`, so the browser identity problem is solved. Mention that it is
   a static web app, MIT, source public, and that the relay only adds CORS and the user
   agent.
4. **Build the hardcore rules into the player**: in hardcore, no save-state loading,
   rewind, slow motion (0.5×), frame advance, cheats or memory viewer (the debug drawer's
   memory view counts); switching into hardcore needs a reset; the hardcore state must be
   visible; hardcore on by default.

## Sources

- rc_client integration (user agent, hardcore demotion, token login):
  https://github.com/RetroAchievements/rcheevos/wiki/rc_client-integration
- rcheevos source (MIT): https://github.com/RetroAchievements/rcheevos (tag `v12.5.0`)
- Hardcore compliance requirements (six months, user agent format, auto-fail criteria):
  https://docs.retroachievements.org/general/hardcore-compliance-requirements.html
- Web API: https://api-docs.retroachievements.org/ (`API_GetGameList`,
  `API_GetGameInfoAndUserProgress`, `API_GetGameExtended`, `API_GetUserProfile`)
- EmulatorJS: shows RetroAchievements data only; its unofficial forks reach the API through
  public CORS proxies, and its player does not unlock:
  https://github.com/EmulatorJS/EmulatorJS/issues/1016
