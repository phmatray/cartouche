# Device sync

Settings › Sync keeps a player's own devices in step (an iPhone Home Screen app and a Mac browser, say):
battery saves, save states with their pictures, favorites, play time, each game's screen settings and the
settings every game uses, and, only if both devices turn it on, the ROMs themselves. No account, no server
of ours, no cloud copy.

Code: `gb-web/src/lib/sync/` (`crypto.ts`, `manifest.ts`, `local.ts`, `engine.ts`, `status.ts`) and
`gb-web/src/components/sync/`. The transport is the WebRTC room layer of the online link cable
(`lib/p2p/room.ts`, docs/ONLINE_LINK.md).

## Pairing

1. Device A draws 32 random bytes (the pairing secret) and shows them as a QR code and as 54 characters
   (Crockford base32 of the 256 bits, plus 10 bits of SHA-256 checksum so a typo is caught before any network use).
2. Device B scans the QR code with its camera *inside the app* (a Home Screen app on iPhone has its own storage,
   apart from Safari's, so the Camera app can't be used; iOS Safari has no `BarcodeDetector`, so frames are
   decoded in JavaScript by the `qr` package, loaded only when the camera opens), or the code is typed or pasted.
3. Both derive the keys below and meet in the room named after the secret. Each sends a random 16-byte nonce;
   each answers the other's nonce with `HMAC(auth, "proof|room|device id|" + their nonce + own nonce)`. Nothing
   else is accepted from a peer until its proof checks out and it has said it checked ours.
4. Both then replace the shown secret with `HKDF(secret, salt = both nonces, "rekey")` and remember the other
   device (id, name, that new secret). The code that was on screen is useless from then on.

Unpairing forgets the secret on this device and, if the other one is connected, tells it to forget too.

## Crypto

All from WebCrypto, derived from the 256-bit secret with HKDF-SHA-256 (salt `cartouche-sync/v1`):

| info | use |
|---|---|
| `room` (128 bits) | the room name on the relays (hex) |
| `enc` | AES-256-GCM key: every message is `[version][random 12-byte IV][ciphertext + tag]`, the room name as additional data |
| `auth` | HMAC-SHA-256 key for the challenge |

This sits on top of WebRTC's DTLS, which already encrypts the data channel end to end.

## Threat model

- **Nostr relays** (public, not ours) carry only the WebRTC handshake, itself encrypted by Trystero with a key
  derived from the room name. They see that two browsers met under some topic and their IP addresses. They never
  see the secret, the keys, or any save.
- **Someone on the network** sees DTLS traffic, then AES-GCM inside it.
- **Someone who saw the pairing code** could pair in place of the other device while the code is on screen
  (so it should be shown only to the device being paired). Once pairing is done the code is dead: both devices
  moved to a secret derived with the handshake's nonces, which never left the encrypted channel.
- **A lost device** still holds the secret: unpair it from the remaining device (which then never joins that
  room again). A stranger with the lost device's data could only sync with a device that still lists it.
- **Not covered:** anything running in the page itself (a malicious browser extension, an XSS) can read
  IndexedDB and localStorage, where saves and pairing secrets live, like everything else in the app.
- A paired device is trusted as the player's own: it can send saves, states, settings and (when enabled) ROMs.
  Received records are still checked (hash against the manifest, SHA-1 for ROMs, known setting names and types).

## Protocol

Messages are JSON with binary fields (`pack` in crypto.ts), each sealed.

1. `hello` / `proof` / `ok`: the challenge above.
2. `man`: one device sends its manifest; the other answers with its own. The device with the smaller id starts
   on arrival (and every 3 minutes with auto-sync on); "Sync now" starts from either side.
3. Each works out what it needs (`manifest.ts`, pure and unit-tested), copies aside its own older side of any
   conflict, writes small records, then sends `want`: the big records it needs, each with the offset it already has.
4. `chunk` (192 KB each), paced by the data channel's buffer. Pieces are written to their own IndexedDB database
   (`cartouche-sync`) as they arrive, so a transfer cut by a closed tab, a reload or a lost network resumes where it
   stopped. A finished record is checked against its hash before it is stored, and only over what the plan saw:
   if the local save or state changed meanwhile (the game was played), the incoming one is not stored, the base
   stays put, and the next sync keeps both.
5. `done` from each side; then both remember the hashes they now share ("base"), and the report (with its notes)
   is kept with the paired device. Leftover pieces for that device are dropped. If items failed, the device that
   leads tries again after 15 s, up to three times.

Keys are shared between devices: a game is its ROM's SHA-1 (it may have another id on the other device), else
`@id` (bundled games). A device that keeps a save for a game without its ROM stores it under the other device's
id and remembers that id's SHA-1 (`localStorage['cartouche.sync.alias']`), so the save keeps the same key on both
sides. Manifests carry hashes, modification times and sizes; small records carry their value.

## Conflict rules

- Battery saves and save states: compared with the base. Changed on one side only: that side wins, whatever the
  clocks say. Changed on both (or never synced and different): both kept. The newer keeps its place; the older
  becomes a separate save named `Main (iPhone, 27 Sep)`, or, for a state, moves to the first save slot free on both
  devices. With no free slot both are left as they are and the player is told. The same choices are made on both
  devices, so they end with the same records.
- Settings and favorites: last writer wins (a value still at its default loses to any choice). A game's own
  screen settings removed on one device are removed on the other.
- Play time, sessions, last played: the larger of each.
- Deletions of saves and states don't sync: a save deleted on one device comes back from the other.
- The game running at the moment is left alone (its saves sync next time), and so are all saves while a link
  cable page (same screen or online) is open. This holds across the browser's tabs: an open player and the local
  link cable page hold a shared Web Lock (`lib/play-lock.ts`) that sync checks when it plans and when a record lands.

## What stays on each device

Screen size, touch controls, volume, key bindings, smooth motion, haptics, box art (consent and files) and
screenshots.

## Limits

- Both devices must have Cartouche open at once, on Settings › Sync or with "Sync automatically" on. iOS stops the
  connection when the app goes to the background.
- No TURN server by default: some networks never connect directly (see docs/ONLINE_LINK.md; the TURN settings of
  Play online apply here too).
- Measured on one machine (localhost, WebKit iPhone profile receiving from desktop Chrome): pairing by camera
  about 1 s after the scan starts; a first sync of a few saves and states well under a second; an 8 MB ROM at
  about 1 MB/s.
- A room where nobody has proved itself for 16 s is joined again from scratch (a device that reloads sometimes
  never gets its new connection up otherwise). In tests a WebKit reload relinked in 7 to 9 s, once in 21 s.
- One tab per browser runs the links (Web Lock `cartouche-sync-engine`): the others show its link states and pass it
  their "Sync now" and unpairing over a BroadcastChannel, and the next one takes over when it closes.
- Test knob: `localStorage['cartouche.sync.throttle']` = ms to wait between the chunks a browser sends.
