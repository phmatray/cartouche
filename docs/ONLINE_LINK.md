# Online link cable

Link cable over the internet between two browsers, peer to peer. Each player runs only their own Game Boy,
their own cartridge and their own battery save; only the serial port's bytes cross the network.
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

While linked: speed is fixed at 1×; rewind and loading states are off; battery saves work as usual.

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

Verified end to end on localhost (Playwright): Chrome↔Chrome and Chrome↔WebKit (iPhone 15 profile) lobbies;
invite link; both ready → both games; pause on one side shows *Player N paused* on the other; a reload of one
player's page reconnects (usually 1–6 s); a closed tab leads to *Connection lost* and, after 20 s, to 0xFF
(the goodbye sent while a page unloads doesn't arrive, so a closed tab reads as lost rather than *left*).
Not tested: a real network drop (taking a browser offline doesn't cut WebRTC on localhost).
