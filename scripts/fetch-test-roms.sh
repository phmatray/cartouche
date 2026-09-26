#!/usr/bin/env bash
# Download the third-party test ROMs used by `cargo test` into gb-core/test-roms/.
# They are git-ignored and must never be committed or redistributed.
#   - Blargg's gb-test-roms (via retrio/gb-test-roms, master)
#   - dmg-acid2 v1.0 and cgb-acid2 v1.1 (Matt Currie, MIT) + reference images
#   - homebrew smoke-test ROMs for tests/homebrew.rs, into test-roms/homebrew/ (pinned URLs,
#     SHA-256 checked; licences in THIRD_PARTY_NOTICES.md, section 3)
set -euo pipefail

DEST="$(cd "$(dirname "$0")/.." && pwd)/gb-core/test-roms"
mkdir -p "$DEST"

echo "Fetching Blargg test ROMs..."
curl -fsSL https://github.com/retrio/gb-test-roms/archive/refs/heads/master.tar.gz \
  | tar xzf - -C "$DEST" --strip-components=1

echo "Fetching acid2 ROMs and reference images..."
curl -fsSL -o "$DEST/dmg-acid2.gb" https://github.com/mattcurrie/dmg-acid2/releases/download/v1.0/dmg-acid2.gb
curl -fsSL -o "$DEST/dmg-acid2-reference.png" https://raw.githubusercontent.com/mattcurrie/dmg-acid2/master/img/reference-dmg.png
curl -fsSL -o "$DEST/cgb-acid2.gbc" https://github.com/mattcurrie/cgb-acid2/releases/download/v1.1/cgb-acid2.gbc
curl -fsSL -o "$DEST/cgb-acid2-reference.png" https://raw.githubusercontent.com/mattcurrie/cgb-acid2/master/img/reference.png

echo "Fetching homebrew smoke-test ROMs..."
HB="$DEST/homebrew"
mkdir -p "$HB"
# The author's own release where there is one, otherwise the author's upload on the gbdev
# Homebrew Hub. Pinned by SHA-256 so the smoke tests always run the same builds.
HH=https://hh3.gbdev.io/static/database-gb/entries
fetch() { # <file> <sha256> <url>
  curl -fsSL -o "$HB/$1" "$3"
  echo "$2  $HB/$1" | shasum -a 256 -c --quiet -
}
fetch ucity.gbc         9422ee2ca7b7ea1d46b58b2a429fff3f354dfd3e732dee1e7ae6220f148ce6e0 https://github.com/AntonioND/ucity/releases/download/v1.3/ucity.gbc
fetch ucity_compat.gbc  8b98cbb5303d2159a931332dc375642fb474b2c9473c7ba473ad94c98a8814bf https://github.com/AntonioND/ucity/releases/download/v1.3/ucity_compat.gbc
fetch gb240p.gb         733eb6e7ec0719752ddd5fcda4e715c2f2e20f4ac4bc971c4bd1d49272f9bb04 https://github.com/pinobatch/240p-test-mini/releases/download/v0.23/gb240p.gb
fetch geometrix.gbc     f13575af6bf87003c3eef8c2cab67a49ca6b02aa23ff6a31a38beb96d6eb1795 "$HH/geometrix/geometrix.gbc"
fetch aevilia.gbc       67e784ed61846bc84bfe9f45b9da343371eec6b896ed1b945b64c0aec7aa735b "$HH/aevilia/aevilia.gbc"
fetch catmario-gb.gbc   ffe4f597f654f6edc8804aaf8d1014c6f9373f448210fc40ccde9076b300e67e "$HH/catmario-gb/catmario-gb.gbc"
fetch aslimetravel.gbc  a92919a1e0d78683f0a245de55d3fc1a0fc07df74a758084ab2e552cb3bc115c "$HH/a-slime-travel/aslimetravel.gbc"
fetch gbhack.gbc        f93a27e8b6272771bbba96105a2754f27ffc3f8317d71c063bdbd60dd0d74527 "$HH/gbhack/gbhack.gbc"
fetch labirinth.gbc     b0a2efc53c9d1770e75cbdbb410e96fdf2bc6ea049249ea269bc1da0f4d92f8a "$HH/labirinth/Labirinth.gbc"
fetch shock-lobster.zip 44bebcf26ca17a5dc37d9d576cb28c1fd8d3fcb2e11b150c29f6be394d4eed4e https://github.com/tbsp/shock-lobster/releases/download/3/Shock.Lobster.zip
unzip -o -q "$HB/shock-lobster.zip" -d "$HB/shock-lobster"
echo "fe5d1e8ba8144431200bee34b71f3889a84c5a256442a4b1cf2a57f7e6c057f5  $HB/shock-lobster/shocklobster.gb" \
  | shasum -a 256 -c --quiet -

echo "Test ROMs ready in $DEST"
