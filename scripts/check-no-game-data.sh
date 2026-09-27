#!/usr/bin/env bash
# Fails if the tracked tree (index included) contains game data or training material:
# ROMs other than the six bundled homebrew ones and the allowlisted GB Studio ones, saves and save states,
# datasets, model checkpoints, boot ROM / BIOS images other than Cartouche's hash-pinned ones (built from gb-core/boot-src), any file
# over 2 MB, a copy of the Nintendo logo outside the bundled ROMs, or anything referring to a local training directory.
# The only model data allowed in the repository is gb-web/src/neural/weights/*.bin.
# scripts/rom-allowlist.sha1 lists each hosted GB Studio ROM ("<sha1>  <path>", shasum format): a ROM is allowed
# there only with that exact content, and only a listed ROM is exempt from the 2 MB limit.
set -euo pipefail
cd "$(git rev-parse --show-toplevel)"

max_bytes=$((2 * 1024 * 1024))
allowed_roms='^gb-web/public/roms/(tobutobugirl\.gb|tobutobugirldx\.gb|ucity\.gbc|cgb-acid2\.gbc|dmg-acid2\.gb|cpu_instrs\.gb)$'
allowlist=scripts/rom-allowlist.sha1
# Archives and Cartouche backups (.cartouche/.cartshelf) are banned too: the app imports both, so a ROM can hide in them.
banned_ext='\.(gb|gbc|sgb|sav|srm|state|npz|npy|pt|pth|ckpt|safetensors|onnx|h5|pkl|zip|7z|rar|gz|tgz|bz2|xz|zst|tar|br|lz|lz4|lzma|zlib|z|cartouche|cartshelf)$'
# Boot ROMs / BIOS dumps: only Cartouche's own boot ROMs (a fork of SameBoy's, MIT; gb-core/boot-src/build.sh
# rebuilds them byte for byte), at these paths with exactly this content (THIRD_PARTY_NOTICES.md). Any other file named like a boot ROM or BIOS image fails.
boot_roms='9e1a9b3600a4691715a164c945871a868744d20fac9a914cc369d5d55e82ca82  gb-core/boot/cgb_insert.bin
c60342c84a3eaccfedcd017dc83b6742f11e67f46300daec7dec8a0b2f8e684b  gb-core/boot/cgb_plain.bin
79a8651c12beee62d4ba545f8083897323579251f5ffd01df349bca529046fc6  gb-core/boot/cgb_registration.bin
2eac192764a8e87311829438b526547032bd1e28ffb7b2e9ec9bfc2f8d080d2f  gb-core/boot/cgb_shelf.bin
5a0b71323549fb43ad8f99d4bf08f2745f59f3484e7d4d3bd95be4eef893eb54  gb-core/boot/dmg_insert.bin
0c5f6687b9ec059c779243e4c809394e8bff2972d5e8667e8b3abce4c12881dd  gb-core/boot/dmg_registration.bin
90757cccc731af2c27c95dcb8aa11864dc1d0258daf7cfa36081ca483cffecea  gb-core/boot/dmg_shelf.bin
c88c90cd3a70e8b6083a9f7ed05365e229858a66c3ac43d465cb6c6ddba05d3c  gb-core/boot/sgb_insert.bin
8e00273125221a8c3d4d61ee2eeb88eed7fe66cdf22da6a8472d578941e51902  gb-core/boot/sgb_registration.bin
921d048bcfd67a7add0d56622024e9ba9cc86ba0ffec00edc3973615c69ebf6b  gb-core/boot/sgb_shelf.bin'
boot_like='(boot|bios).*\.(bin|rom|gb|gbc)$|(^|/)[^/]*(rom|dmg0|cgb0)[^/]*\.(bin|rom)$|^gb-core/boot/'
fail=0

# Listed with its SHA-1, and the file has exactly that content.
listed() { [[ -f $1 ]] && grep -qxF "$(shasum -a 1 "$1" | cut -d' ' -f1)  $1" "$allowlist"; }

while IFS= read -r -d '' f; do
  lower=$(printf '%s' "$f" | tr '[:upper:]' '[:lower:]')
  ok_rom=0
  if [[ $lower =~ $banned_ext ]] && listed "$f"; then ok_rom=1; fi
  if [[ $lower =~ $banned_ext && ! $f =~ $allowed_roms ]] && (( ! ok_rom )); then
    echo "game data / model file not allowed: $f"; fail=1
  fi
  if [[ $lower =~ $boot_like ]] && ! { [[ -f $f ]] && grep -qxF "$(shasum -a 256 "$f" | cut -d' ' -f1)  $f" <<< "$boot_roms"; }; then
    echo "boot ROM / BIOS file not allowed: $f"; fail=1
  fi
  if [[ $lower == *cartouche-training* ]]; then
    echo "training path not allowed: $f"; fail=1
  fi
  if [[ -f $f ]] && (( ! ok_rom )) && (( $(wc -c < "$f") > max_bytes )); then
    echo "file over 2 MB: $f"; fail=1
  fi
done < <(git ls-files -z)

# Every allowlisted ROM is tracked (a stale line would allow a file nobody reviewed).
while read -r _ path; do
  if [[ -n $path ]] && ! git ls-files --error-unmatch -- "$path" >/dev/null 2>&1; then
    echo "allowlisted but not tracked: $path"; fail=1
  fi
done < "$allowlist"
while read -r _ path; do
  if ! git ls-files --error-unmatch -- "$path" >/dev/null 2>&1; then
    echo "allowlisted boot ROM not tracked: $path"; fail=1
  fi
done <<< "$boot_roms"

# Content: no copy of the Nintendo logo (a boot ROM dump carries it) in any tracked file but the bundled ROMs,
# whose headers need it: raw in a binary, or written out as a byte array or base64 in a text file (scripts/logo_scan.py).
# Matched by the SHA-1 of its 48 bytes, so neither script holds any of them. It also fails any archive by its magic
# bytes (zip, gzip, 7z, xz, zstd, bzip2, rar, zlib, lzma), whatever the file is named: the extension check above is only by name.
python3 scripts/logo_scan.py --self-test >/dev/null
logo_hits=$(git ls-files --eol -z | python3 scripts/logo_scan.py)
if [[ -n $logo_hits ]]; then
  echo "Nintendo logo bytes or archives not allowed in:"; echo "$logo_hits"; fail=1
fi

# Content: no reference to the local training directory (its files name the games).
if git grep -I -l -i 'cartouche-training' -- ':!scripts/check-no-game-data.sh'; then
  echo "^ these tracked files mention the local training directory"; fail=1
fi

if (( fail )); then exit 1; fi
echo "OK: no game data, datasets or checkpoints tracked."
