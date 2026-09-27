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
boot_roms='a1217b1969ea479f39264c04c0473f47fcaedafcc50c7bd6d8c5cc641a11f2b7  gb-core/boot/cgb_insert.bin
c60342c84a3eaccfedcd017dc83b6742f11e67f46300daec7dec8a0b2f8e684b  gb-core/boot/cgb_plain.bin
a5e7053186ee33c6b8b692c498247fb6a0e9119b041ada239d827ffea0024cb3  gb-core/boot/cgb_registration.bin
90925e83dc5e8835431ce631f15f0d79749e97746f0aea6edffd9057a8e6ef6d  gb-core/boot/cgb_shelf.bin
01bcbdd80449926f3ca043578814356ad9e17ed9678a9e2d6726905c14a3cf4f  gb-core/boot/dmg_insert.bin
cd2a0138c7d22c23b8430bf4d38a12940ae840b31681e2a8bb880aac497062d9  gb-core/boot/dmg_registration.bin
0eb1eafcff00428b50b848719d2b3f4679399ce971d10541d12c539701105fa0  gb-core/boot/dmg_shelf.bin
e349cfdf6779a050a1f7dd6039afbd1e5b9b485a8f653053f0e2c1c2566ba8ee  gb-core/boot/sgb_insert.bin
0e81f71c2caa729db9ace794445b88fe64dcdbac16f4b8febf212cfd2f5ec557  gb-core/boot/sgb_registration.bin
9bfe3d15bdd8160679f890611a80d38f33f5e38a0e2721d70d5c3bdb0fbd3510  gb-core/boot/sgb_shelf.bin'
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
