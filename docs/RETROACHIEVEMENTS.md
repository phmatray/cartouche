# RetroAchievements

Cartouche shows a player's [RetroAchievements](https://retroachievements.org) for a
cartridge, **read-only**. It does not unlock achievements. This page says why, what
exists, and what the owner has to do before unlocking can ever be added.

## What exists

- **Settings › Achievements**: the player enters their RetroAchievements username and
  **web API key** (retroachievements.org › Settings › Keys). The key is checked with
  `API_GetUserProfile` and kept in this browser's `localStorage` (`cartouche-ra`), outside
  the settings backup. The password is never asked for. "Disconnect" forgets the key and
  the cached hash list.
- **Game page and the manual's Game tab**: for a connected player and a ROM stored in the
  browser, the list of the set's achievements with badge, points and whether (and when,
  softcore or hardcore) the player earned it, plus a link to the game on RetroAchievements.
- **Identification**: the RetroAchievements hash of a Game Boy / Game Boy Color ROM is the
  MD5 of the whole file (rcheevos `rc_hash`). It is compared **in the browser** with the
  hash lists of `API_GetGameList` (consoles 4 and 6, `h=1&f=1`), cached for a week. The ROM
  and its hash are never sent.
- Code: `gb-web/src/lib/retroachievements.ts` (API calls, MD5, credentials),
  `gb-web/src/components/game/Achievements.tsx` (lazy-loaded list),
  `gb-web/src/components/settings/AchievementsTab.tsx`. No request is made while
  disconnected.

## Why nothing is unlocked

Checked on 2026-09-27:

1. **The emulator API does not answer browsers.** Login, session, set download and unlocks
   go through `https://retroachievements.org/dorequest.php` (what rcheevos' `rc_client`
   calls). It sends no `Access-Control-Allow-Origin` header, so a page on `github.io` can't
   read its answers (Chrome: `TypeError: Failed to fetch`). The public Web API
   (`/API/API_*.php`) and the badge server do send `Access-Control-Allow-Origin: *`,
   which is why the read-only mode works.
2. **The Web API has no achievement logic.** In the documented `API_GetGameExtended`
   example, `MemAddr` is a 32-digit hex hash, not a trigger definition, so a set cannot be
   evaluated locally from it.
3. **Hardcore unlocks need an identified, reviewed client.** The server reads the `User-Agent`
   (format `Cartouche/1.2.1 (OS) core/x.y`) to recognize an emulator; an unknown one gets
   a "Warning: Unknown Emulator" entry and its hardcore unlocks are demoted to softcore.
   Chrome and Safari don't let `fetch` set `User-Agent`.
4. A proxy (server or public CORS proxy) would work around 1 and 3. It is deliberately
   **not** built: it would hide the client's identity from RetroAchievements and route
   players' keys through a third party.

## What the owner has to do to get unlocking

1. **Wait for eligibility.** The emulator must have been publicly available for at least
   six months (the public repository was created on 2026-09-26: eligible from 2027-03-26).
2. **Read the requirements:**
   [Hardcore compliance requirements](https://docs.retroachievements.org/general/hardcore-compliance-requirements.html)
   and the [rc_client integration guide](https://github.com/RetroAchievements/rcheevos/wiki/rc_client-integration).
   In hardcore: no save-state loading, rewind, slow motion (0.5×), frame advance, cheats or
   memory editing (the debug drawer's memory view counts); switching into hardcore needs a
   reset; the hardcore state must be visible; unlocks queued while offline; rich presence
   and leaderboards can't be turned off; FOSS license and privacy policy published
   (MIT and the Legal page already cover this).
3. **Ask RetroAchievements** (message the "RAdmin" account on retroachievements.org, as
   the rcheevos wiki says) for:
   - validation of a `Cartouche/<version>` user agent, and
   - a way for a browser client to reach the emulator API: CORS on `dorequest.php` for
     `https://phmatray.github.io`, and accepting the client identity from a header a
     browser can send (for example `X-RA-Client`) or from a request parameter, since
     Chrome and Safari don't let `fetch` set `User-Agent`.
   Mention that it is a static, client-only web app (no server), MIT, source public.
4. **Only after their answer**, build the client: compile rcheevos (MIT) to WASM next to
   `gb-core` (memory callback through a `peek` export covering rcheevos' Game Boy
   memory map in `consoleinfo.c`: the whole 16-bit bus, then Color work RAM banks 2-7 at
   `$10000-$15FFF` and cartridge RAM banks 1-15 at `$16000-$33FFF`), `rc_client_begin_login_with_token`
   (token in localStorage, never the password), per-frame `rc_client_do_frame`, unlock
   toasts, an offline unlock queue, and the hardcore rules above wired into the player.
   Credit rcheevos in `THIRD_PARTY_NOTICES.md` and the About credits.

## Sources

- rc_client integration (user agent, hardcore demotion, token login):
  https://github.com/RetroAchievements/rcheevos/wiki/rc_client-integration
- Hardcore compliance requirements (six months, user agent format, auto-fail criteria):
  https://docs.retroachievements.org/general/hardcore-compliance-requirements.html
- Web API: https://api-docs.retroachievements.org/ (`API_GetGameList`,
  `API_GetGameInfoAndUserProgress`, `API_GetGameExtended`, `API_GetUserProfile`)
- EmulatorJS: shows RetroAchievements data only; its unofficial forks reach the API through
  public CORS proxies, and its player does not unlock:
  https://github.com/EmulatorJS/EmulatorJS/issues/1016
