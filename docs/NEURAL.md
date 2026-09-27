# Neural 4× and Smooth motion

Two display features built on the emulator's own knowledge of each frame. The core can report,
per frame, what the PPU drew layer by layer: the BG and window tile maps, every scanline's scroll
and window registers, palettes, and the sprite layer (`gb-core/src/trace.rs`, off unless one of
these features is on). Ordinary upscalers only see finished pixels. These see the tile maps.

| | Neural 4× | Smooth motion |
|---|---|---|
| What it does | Rounds off pixel-art edges at 4× resolution | Draws in-between frames for 120 Hz and faster screens |
| How | A small convolutional network on the tile maps, plus a learned lookup table | The exact layer motion recorded by the emulator (no network) |
| Weights | 333,296 bytes (two files) | none |
| Where | Screen tab and Settings › Display: the **Neural** preset or Upscaling › Neural 4× | Settings › Display › Motion, off by default |
| Needs | WebGL 2 (the tile network also needs float render targets) | WebGL 2 and a display faster than 60 Hz (or the "Also on 60 Hz screens" switch) |

Neither changes emulation. Both are drawing only.

## Neural 4×

### What runs

Two learned models share the output. Each writes every 4×4 output block with the source pixel in
its central 2×2, so no pixel of the game is ever moved or recoloured; only the 12 outer subpixels
of each block are decided by the model.

**Tile-aware network** (`gb-web/src/neural/weights/tile4x.bin`, 136,648 bytes). It never sees
colours or the finished frame. It runs on each BG/window map as the Game Boy stores it: a 256×256
image of 2-bit colour ids.

- Input: the colour id of each map pixel, one-hot.
- 8 convolution layers of 3×3, 32 channels, ReLU, residual connections after the first. The
  receptive field is 8 pixels, so the output for an 8×8 tile depends only on that tile and its 8
  neighbours.
- A 1×1 head gives, for each of the 16 subpixels of a map pixel, logits over the 4 colour ids.
- Ids that do not appear in the pixel's 3×3 neighbourhood are masked, so no colour is invented.
  Weights under 0.2 are dropped after the softmax ("snap"), the rest renormalised: without that,
  faint tints flicker.
- The result is cached per map in a 1024×1024 weight atlas. A map cell is recomputed only when
  its tile data or map entry changes (and then its 8 neighbours too), a bounded number of cells
  per frame.
- The frame is then rebuilt line by line from each scanline's own SCX/SCY/WX/WY and window line
  counter, with that line's palette applied last. Scrolling moves the cached result exactly,
  palette fades only recolour it, and raster effects (status bars, split scrolling) come out right.

**Learned-classical table** (`gb-web/src/neural/weights/lc4x.bin`, 196,648 bytes). A pixel-space
upscaler for everything the tile path does not cover. For each quadrant of a 4×4 block, 16
colour-equality bits between pixel pairs of a 5×5 window index a table; each entry picks, per
free subpixel, one of 7 neighbours and a blend amount (5 bits). The bit pairs were chosen from
data and the table fitted in closed form. Equality bits make it independent of the palette, and
the tied table makes it exactly symmetric under rotations and flips.

**Which one draws a block.** The tile path draws a block when the block and its 8 neighbours all
come from the same layer (BG, or window) and the block's centre, rebuilt from the map and the
palette, equals the pixel the game showed. Everything else uses the table: sprites and the pixels
next to them, where BG meets window, map cells still being computed, VRAM or palettes written
mid-frame, and whole frames without a usable trace (the preset previews, the frame shown right
after a state load or during rewind). On the bundled homebrew, 95.8% of blocks take the tile
path, 4.1% are next to sprites, and 0.05% fall back for other reasons.

Palettes, colour correction, adjustments and LCD ghosting then run on the 4× picture, as they do
on the 1× picture for the other upscalers. DMG palettes are mapped by interpolation there, so a
blend of two shades becomes the same blend of their palette colours.

### How it was trained

There is no high-resolution ground truth for Game Boy art. Both models learn to imitate a teacher:
**xBRZ 4×**, Zenju's pixel-art scaler (the original C++, run as a separate tool during training;
none of its code is in Cartouche). The goal was to keep what xBRZ does well on edges while fixing
what it does not do for this use: it moves source pixels (the central 2×2 of 5.6% of blocks on
held-out games), and it flickers when pixels near an edge change.

- **Data.** Frames recorded with the core's trace from a private collection of Game Boy and Game
  Boy Color games, on the order of a thousand titles, played by a scripted input bot. The games,
  the frames, the tiles and the datasets are not distributed and are not in this repository. Only
  the weight files are: numbers, with a header of sizes and pixel-pair indices.
- **Held-out games.** About a tenth of the games were set aside before training and never used to
  fit or select anything. Model choices (such as the snap threshold) were made on training games.
- **Tile-aware network.** Teacher targets: xBRZ run on the real colours of each crop (the game's
  own palette; sprites with transparency), each output colour mapped back to weights over the
  colour ids of its 3×3 neighbourhood. Loss: soft cross-entropy on the 12 free subpixels. The same
  random rotation or flip is applied to input and target, so the network learns a symmetric
  version of the teacher. About 230,000 map crops; about 80 minutes on one laptop GPU (Apple M1 Max).
- **Learned-classical table.** A greedy forward selection of the 16 equality bits (over
  rotation- and flip-closed groups of pixel pairs), then a least-squares fit of each table entry
  to the teacher, on about 23 million quadrant samples. About 35 minutes on the CPU.

### How it was evaluated

The same protocol for every candidate, on held-out games and, separately, on the six bundled
homebrew ROMs (the only frames this repository may show):

- **Exactness**: the share of 4×4 blocks whose centre sample, and whole central 2×2, equal the
  source pixel.
- **Jaggy**: 1 minus the local structure-tensor coherence around pixel-art stair steps (lower is
  smoother edges). **Blend**: the share of output pixels whose colour is none of the colours of
  their 3×3 source neighbourhood (softness). **Dither kept**: the share of pixels over checkerboard
  dithering left identical to nearest.
- **Flicker**: on consecutive frames, the output of frame A is moved by the emulator's exact motion
  vectors and compared with the output of frame B, on output pixels whose own source pixel did
  not change. **Flicker 3×3**: only where the whole 3×3 source neighbourhood is unchanged.

Results on the bundled homebrew (88 frames and 60 consecutive pairs of Tobu Tobu Girl, Tobu Tobu
Girl Deluxe, µCity, dmg-acid2, cgb-acid2 and cpu_instrs):

| Method | Exact centre / 2×2 % | Jaggy | Blend % | Dither kept % | Flicker % | Flicker 3×3 % |
|---|---|---|---|---|---|---|
| Nearest | 100 / 100 | 0.6613 | 0 | 100 | 0 | 0 |
| EPX (Scale4x) | 99.96 / 99.84 | 0.4643 | 0 | 77.8 | 0.3350 | 0.0121 |
| xBRZ 4× (teacher) | 99.39 / 97.43 | 0.4002 | 1.56 | 66.9 | 0.4315 | 0.0206 |
| Learned-classical table alone | 100 / 100 | 0.3998 | 1.89 | 59.5 | 0.4617 | 0.0350 |
| Tile-aware network alone | 100 / 100 | 0.4006 | 1.19 | 70.3 | 0.3595 | 0.0183 |
| **Neural 4× as shipped** | **100 / 100** | **0.4026** | **1.36** | **67.7** | **0.4117** | **0.0387** |

What this says, plainly:

- Edges are as smooth as xBRZ's (jaggy within 0.003), and unlike xBRZ no source pixel ever moves.
- It flickers about 5% less than xBRZ over all changed pixels, but more where the 3×3 neighbourhood is
  still. The tile-aware network alone flickers least; the shipped version gives up some of that
  around sprites, where the network alone drew visible speckle, and uses the table there.
- It does not beat its teacher on edge quality: it was trained to imitate it. Better edges would
  need a better teacher or real high-resolution art.

On the held-out games the shipped version keeps 100% exactness and flickers 15% less than xBRZ
(0.215% against 0.253% of pixels); those frames are not shown here.

### The WebGL implementation

`gb-web/src/neural/`: `trace.ts` (map decoding, dirty cells, line palettes), `weights.ts` (file
formats, uniform-buffer layout), `upscaler.ts` (the network as fragment passes, the compose pass,
the table), `governor.ts` (automatic fallback). Checked against the reference implementation used
for the numbers above, on the bundled homebrew:

- The table path is bit-exact (0 differing channels over 88 frames).
- The tile path differs by at most 1/255 on 0.13% of pixels (8-bit weight atlas), and picks the
  same path as the reference for every block.
- After a frame's VRAM changes, the incremental cache reaches exactly the from-scratch result
  within 9 frames on all 60 consecutive pairs (median: 1 frame) with a 64-cell budget.
- These results are the same in Chrome (ANGLE Metal) and in WebKit (Safari's engine), on the same Mac.

Cost on an Apple M1 Max, wall clock over hundreds of frames with a final readback, Chrome / WebKit:
0.19 / 0.13 ms for a frame drawn by the table alone, 0.29 / 0.56 ms for a frame drawn from the tile
cache, 1.3–1.7 / 2.5–3.9 ms for a frame that also recomputes 32–192 map cells, 23 / 26 ms to
rebuild every used map at once. Phones were not measured. A full scene change is spread over
several frames (192 cells per frame), with the table drawing the cells not yet computed. The core's
layer trace, on while Neural 4× or Smooth motion is in use, cost 11–15% more emulation time per
frame when it was measured.

**Automatic fallback.** The time of the neural passes is measured with
`EXT_disjoint_timer_query_webgl2` when the browser has it, otherwise from the time between frames.
When the median of the last 60 frames is over budget, Neural 4× steps down: tile network and
table, then the table alone, then Nearest. It never steps back up by itself; changing the setting
starts over.

**Caches.** Loading a state, rewinding and switching games throw the tile cache away; the next
frames are drawn by the table until the maps are recomputed.

## Smooth motion

An in-between frame at time τ between two emulated frames A and B, drawn at 4×:

- **BG**: both frames are placed into the 256×256 map using each line's own scroll registers.
  Each output line scrolls by the in-between value of its own line's scroll, so status bars that
  do not scroll stay put and half-pixel positions become real positions at 4×. Areas where the
  game redraws tiles to keep the picture still are detected by a vote and kept still. Map content
  neither frame showed is drawn from the VRAM snapshot.
- **Window**: moved by WX and its line counter.
- **Sprites**: matched between frames by OAM slot and tile (else the nearest sprite with the same
  tile and attributes), moved to their in-between position, and put back with the DMG or CGB
  priority rules.
- **When it holds a real frame instead**: a scene cut (the previous frame, moved by its scroll,
  predicts less than 75% of the new one), uneven motion (the BG did not move by the same amount
  in the last two frames, like games that scroll every other frame: an in-between frame would show
  a position the game never drew), a loaded state, rewind, and any speed other than 1×.

The display runs half a Game Boy frame behind: at 120 Hz that is about 8 ms of added delay. It is
on only when the measured display rate is over 75 Hz (or when forced), and Neural 4× pauses while
it runs: the in-between frames are drawn with sharp pixels.

**Measured.** Scored against real emulated frames (the true frame between two others), on the
bundled homebrew, with the reference implementation that the shipped shaders match bit for bit
(0 differing pixels on 36 test pairs, in Chrome and WebKit): on µCity's scrolling map, 114 of 114 in-between frames are
identical to the real frame (repeating the frame gets 65.9% of pixels right, a 50% blend 51.8%,
TV-style block matching 89.5%); on Tobu Tobu Girl and Tobu Tobu Girl Deluxe, 99.7% and 99.6% of
pixels are right (98.9% and 98.8% by repeating the frame). On held-out games, 81.7% of steady-
motion in-between frames are pixel-perfect. Uneven motion is the common case in real games, which
is why the guard holds those frames. The perceived smoothness was not measured. Cost: 0.27 ms
(Chrome) and 0.57 ms (WebKit) per generated frame on the M1 Max.
