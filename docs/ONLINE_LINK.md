# Online link cable

Link cable over the internet between two browsers, peer to peer. Each player runs only their own Game Boy,
their own cartridge and their own battery save; only the serial port's bytes cross the network. When both players
hold both games, each browser runs both consoles in step instead and only the buttons cross ([Lockstep mode](#lockstep-mode-both-players-hold-both-games)).
Route: `/link-cable/online` (lobby), then `/game/:id/play?online=<room>&save=<profile>` for each player.

## Connection (`gb-web/src/lib/p2p/`)

- **Trystero** (Nostr strategy) finds the other browser. Public Nostr relays carry only the WebRTC handshake,
  encrypted with a key derived from the room code; after that, everything goes over WebRTC's ordered, reliable
  data channel, browser to browser. Cartouche runs no server.
- Rejected: **PeerJS cloud**. It depends on one shared, rate-limited broker (0.peerjs.com) that we don't control,
  and where the peer ID alone is enough to connect. Trystero spreads discovery over several
  relays operated by different people, and keeps working if one of them goes down.
- `room.ts` is generic (typed JSON messages, peers in arrival order, ping, `onJoin`/`onLeave`) so device sync can
  use it too. Trystero re-announces the room every ~5 s, so a player who reloads is found by the room as it is;
  the room is only joined again from scratch after 16 s alone, on `online`, on return to the foreground, or when
  a silent peer is still listed by WebRTC (Trystero ignores that peer ID until its dead connection closes).
  Tearing the room down right after a drop raced the returning player's handshake (reconnects of 15–22 s).
- Relays: a fixed list of five (Trystero's pick for our app ID, minus `relay.mostr.pub`, which answers every
  connection with a redirect and filled the console, and one that doesn't answer). Re-probe
  `defaultRelayUrls` and swap entries if relays die.
- Privacy: the relays see only the encrypted handshake, but they see both IP addresses, and each player learns
  the other's (inherent to WebRTC). Trystero's default STUN servers (Google, Cloudflare) are contacted. The
  handshake key derives from the 6-character code (~2^28 codes), so someone recording the relays could brute-force
  it offline: it keeps strangers out of a room, it is not a secret. The lobby's notes say this.
- NAT traversal: public STUN only (Trystero's defaults). **No TURN relay**: some network pairs (carrier-grade NAT,
  strict office or school firewalls) cannot connect. The lobby says so, and *Connection settings* takes a TURN
  URL, username and credential, kept in this browser (`localStorage['cartouche.p2p.turn']`).
- Room codes: 6 characters from `346789ABCDEFGHJKMNPQRTUVWXY` (no 0/O, 1/I/L, 2/Z, 5/S), ~387 million codes.
  Invite link `…/link-cable/online?room=CODE`, Web Share when available, copy, and a QR code (`uqr`, no dependencies; rejected: hand-rolled Reed-Solomon, and
  `qrcode`, which is heavier). Both libraries are in a lazy `p2p` chunk (71 KB, 25.7 KB gzipped) loaded with the
  online lobby: the library's first load does not change.
- An iPhone Home Screen app can't be opened by a link (it opens Safari), so the code is shown big enough to read
  out and can be typed into the app.

## Session (`gb-web/src/lib/netlink/session.ts`)

Messages: `hi` (seat: host, game, ready, playing, paused), `bye`, `full`, and the serial pair `x` / `r`.
A `hi` every 2 s doubles as a heartbeat. A peer that has been silent for 6 s counts as gone: a newcomer is then
adopted (this is how a reload reconnects, usually within 1–6 s), otherwise the room answers `full`. The host is
Player 1, and keeps that seat across reloads (`sessionStorage['cartouche.netlink.hosted']`, per tab); if both
sides still claim the same role, the lower peer ID is Player 1. Every message from the other browser is checked
for shape and types before use, and a transfer's length is clamped to 8 × 512 cycles.
A reload reconnects the cable but reboots the game from its battery save (unless the play URL has `&resume=1`);
online play never writes the solo resume point.
`localStorage['cartouche.netlink.delay']` (ms, test knob) delays everything this browser sends. The lobby's ping
comes from Trystero and ignores it.

## Serial protocol (lockstep at transfer granularity)

Core hooks (`gb-core/src/serial.rs`, WASM: `set_link_remote`, `link_stalled`, `link_take_request`,
`link_remote_reply`, `link_remote_clock`, `link_take_reply`):

1. The console that starts an **internal-clock** transfer stalls right there (`run_frame` returns early and
   finishes that frame on a later call). It sends `x {seq, byte, cycles}`.
2. The partner, on `x`: if its game listens (external clock armed), it takes the byte and completes over
   `cycles`, raising its serial interrupt at the matching point, and answers `r {seq, SB}`. If it is clocking a
   transfer itself, it answers 0xFF (two masters). Otherwise it **holds** the byte until the game arms a
   transfer, for at most one frame of its own time (`HOLD_CYCLES`), then answers 0xFF as an unplugged cable would.
3. On `r`, the stalled console takes the byte and completes the transfer on its usual schedule. So the clocking
   side's emulation does not depend on latency at all (tested: identical state for 0-, 3- and 40-step delays);
   it only runs later. The frame is finished at once when the answer arrives, not at the next display refresh, so
   several bytes can cross within one frame on a fast line.
4. Sequence numbers make a lost exchange safe to replay: after a reconnection the pending request is resent,
   a repeated request gets the same answer and isn't clocked twice.
5. Bounded wait: after 600 ms the player sees *Waiting for Player N* (or *paused*, or *connection lost*), with
   *Unplug the cable*. After 20 s without an answer (unless the other player reported a pause) the transfer
   completes with 0xFF and the game handles a missing partner as it would on hardware. A pause the other player
   reported counts through a lost connection too (an iPhone that switches apps pauses, then goes silent).

Infrared is not carried in this mode: its pulses are timed in CPU cycles, which one round trip per byte can't preserve.
It is in lockstep mode (below).

While linked: speed is fixed at 1×; rewind and loading states are off; battery saves work as usual.

## Lockstep mode (both players hold both games)

Chosen on its own when each player has the other's game (the same game on both sides, or two games both hold);
otherwise the byte mode above runs as before. Each browser then runs **both** consoles, joined by the core's own
cable (`run_frame_linked`, serial and infrared), and only the buttons cross the network. `gb-web/src/lib/netlink/`:
`lockstep.ts` (input scheduler, message guards), `session.ts` (handshake), `useLockstep.ts` (player page).

1. Handshake, once both games run: each side sends `roms {g, s}`, the SHA-1 of its game and of every game it holds
   (library entries with a SHA-1: imported ROMs, the bundled catalog games and the hosted GB Studio games). No ROM
   ever crosses. If each holds the other's game, the host measures the round trip (median of 5 echoes through the
   room, test delay included) and sends `boot {seed, d, save}`: the clock seed (epoch seconds, see
   `set_emulated_clock`), the input delay and its battery save. The guest answers `boot {save}`. Until then the
   offer and the host's boot go again with every heartbeat.
2. Both browsers switch both consoles on the same way: plain `load_rom` (the game's own console, no start-up
   animation, no colourisation or Super Game Boy), the player's battery save as sent, the clock seed, cheat codes
   off. Player 1's console always runs first in the pair. The game restarts once, from its battery save, when the
   mode is chosen (a toast says so). If one side can't (the partner's game doesn't load, or its SHA-1 differs), it
   sends `boot {abort}` and both go back to the byte mode, each with a toast saying why.
3. Every frame each side sends `i {f, b}`: its buttons, sampled now, for frame now + D. Frame n runs once both
   inputs for n are known; the first D frames run with no button. D = `clamp(ceil(rtt / 2 / 16.74) + 1, 2, 10)`,
   fixed for the session. Frames follow the Game Boy's pace from the start, so a frame a short wait held back is
   made up (up to 4 per refresh; after half a second behind, a pause, the pace starts over).
4. Every 60 frames: `h {f, x}`, both consoles' `state_hash` XOR-ed. A mismatch stops both sides on
   *Desynchronised — the two games no longer match*, with *Unplug the cable*. Test knob:
   `localStorage['cartouche.netlink.desync'] = '1'` sends wrong hashes.
5. Each browser shows its own seat's screen, plays its own console's sound (the other's is dropped) and writes only
   its own battery save. The partner's inputs late more than 600 ms bring the usual *Waiting for Player N* banner
   (paused, lost, left); unplugging goes on alone from the current state.

### Rollback (on top of lockstep)

Input delay alone costs D frames of lag, 6 (100 ms) at a 150 ms round trip. Rollback cuts it to
`rollbackDelay(D) = max(min(D, 2), D − 4)`: 2 frames up to a ~200 ms round trip, and whatever the 4-frame window can't
cover beyond that (6 at 300 ms). `lockstep.ts` + `useLockstep.ts`, on the player page's own core (as the lockstep
slice, not the link worker):

1. A frame whose partner buttons aren't here yet runs on a guess: their last known buttons (`Lockstep.predict`).
   Before it runs, both consoles' `save_state()` and the buttons they held go into a ring of WINDOW + 2 slots.
2. When the partner's buttons for a guessed frame F arrive and differ (`Lockstep.remote` returns F), the next frame
   first sets both consoles' buttons as they were before F, loads their F states (a load keeps the held buttons),
   and runs F … now again with what is known now: sound drained (`clear_audio_buffer`), no frame drawn. Then the
   current frame runs as usual.
3. More than 4 frames (WINDOW, from the budget below) ahead of the partner's buttons, the frame waits, as in
   lockstep; a long wait brings the usual *Waiting for Player N* banner.
4. The hash check runs on confirmed frames only: the state before frame 60n once every input before it is known
   (from the ring slot, or the consoles when it is the current frame). Test knob:
   `localStorage['cartouche.netlink.stats'] = '1'` keeps `{frame, rollbacks, rerun}` in `globalThis.__rb`.

The guessed frames' sound was already heard, so a correction can drop or repeat a few milliseconds of it; the
screen shows the corrected game from the next frame. Achievements see the frames as drawn.

Every received message is checked for shape, types and ranges (`isLockMsg`, `isHashMsg`, `isRomsMsg` with at most
4096 SHA-1s, `isBootMsg` with the save capped at 128 KiB + clock, and `abort` only alone). A reload mid-session
goes back to the byte mode for that page (no resume).

## Rollback budget

A rollback loads both consoles' states at the mispredicted frame and re-runs every frame since, inside one display
frame. Measured in headless Chromium (desktop, Apple M1 Max), two linked consoles on an emulated clock, median of
60–300 runs:

| Game | State size | 1 frame, both consoles | + `save_state` ×2 | Re-run 2 / 5 / 8 / 10 frames (load ×2, save ×2 each) |
|---|---|---|---|---|
| Tobu Tobu Girl Deluxe (GBC) | 58 KB | 1.8 ms | 1.8 ms | 3.7 / 9.2 / 18.4 / 23.2 ms |
| Dawn Will Come (GB Studio) | 83 KB | 2.7 ms | 2.8 ms | 5.5 / 13.5 / 21.3 / 26.4 ms |
| µCity (GBC, 128 KB RAM) | 181 KB | 2.6 ms | 2.7 ms | 5.4 / 13.4 / 21.3 / 26.9 ms |

Saving the states costs next to nothing; the re-run is the frames themselves, about 2.7 ms each. Ten frames take
23–27 ms, over the 12 ms budget, so the **rollback window is 4 frames** (≈ 11 ms at the slowest game above). An
iPhone-class device was not measured; it is slower, so the window is not larger than the desktop's.

The save state carries the cartridge clock's position (MBC3: its emulated time and the dots into the current second,
in the mapper block): without it, loading a state in a deterministic session caught the clock up to "now", and a
rolled-back run no longer matched a straight one (`gb-core/tests/determinism.rs`). Older states still load.

## Measurements (localhost, two Chrome contexts; artificial one-way delay added on each side)

Real two-ROM test with a falling-block puzzle game in 2-player mode: the link handshake goes through, both
consoles reach the versus screen in step, and game traffic flows both ways. Throughput counts completed exchanges:

| Round trip | Link bytes/s in game | Share of time the clocking console waits |
|---|---|---|
| ~1 ms | 26–34 | 3–4 % |
| ~50 ms | 10–13 | 57–76 % |
| ~100 ms | 6.5–8.4 | ~80 % |
| ~150 ms | 5.3–6.4 | 82–86 % |

Each byte costs one round trip. **Only the clocking console is independent of latency.** The listening console
keeps running and sees bytes one round trip apart, so a game whose listening side times out after a few frames
will drop the link at ~100 ms. **Turn-based exchanges** (trading, turn-based battles, menus) *may* work, only
slower (a few hundred bytes at 100 ms ≈ tens of seconds), **but no trade or battle has been verified with a real
game yet**: the synthetic Rust tests cover the exchange pattern, the two turn-based games tried never used the
cable in the screens reached. **Real-time link games stutter**: the game above runs at a fraction of its speed
once the round trip passes a few tens of ms.

Lockstep mode (same setup, headless Chromium, hosted GB Studio games, a button pressed every second on each side):

| Round trip | Input delay D | Frame rate, each side |
|---|---|---|
| ~1 ms | 2 | 58.5–58.6 fps |
| ~50 ms | 3 | 59.4–59.5 fps |
| ~150 ms | 6 | 59.3–59.7 fps |
| ~300 ms | 10 | 59.5–59.6 fps |

The hashes still matched after 5 minutes at ~150 ms (59.7 fps both sides); with the desync knob on one side, both
showed *Desynchronised* within 2 s. Two different games held by both players (Dawn Will Come ↔ Poltersprite) run
in lockstep too; a game the other player lacks falls back to the byte mode. No real-time link game was at hand to
play: the tests check that both browsers run the same frames, not a game's own link play.

Rollback (same setup, Dawn Will Come on both sides, a button pressed or released twice a second on each side; frame
rate from the frames advanced, re-runs not counted; 5 s samples; the machine was shared with other builds, load
average ~20, which explains the dips):

| Round trip | Input delay | Frame rate, each side (mean, 5 s samples) | Rollbacks/s, each side | Frames re-run per rollback |
|---|---|---|---|---|
| ~50 ms | 2 | 59.7 (59.5–59.8) | 0–2 | 2–3 |
| ~150 ms | 2 | 59.5 (54.8–62.0), 5 minutes | 1–2 | 1.2–4 |
| ~300 ms | 6 | 58.2 (53.0–61.7) | 1–2 | 3–4 |

No desync in any run (hash check every 60 confirmed frames); with the desync knob on one side, both showed
*Desynchronised* within 5 s. A re-run of 4 frames costs ≈ 11 ms (see *Rollback budget*).

Verified end to end on localhost (Playwright): Chrome↔Chrome and Chrome↔WebKit (iPhone 15 profile) lobbies;
invite link; both ready → both games; pause on one side shows *Player N paused* on the other; a reload of one
player's page reconnects (usually 1–6 s); a closed tab leads to *Connection lost* and, after 20 s, to 0xFF
(the goodbye sent while a page unloads doesn't arrive, so a closed tab reads as lost rather than *left*).
Not tested: a real network drop (taking a browser offline doesn't cut WebRTC on localhost).
