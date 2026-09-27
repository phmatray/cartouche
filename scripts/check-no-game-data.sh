#!/usr/bin/env bash
# Fails if the tracked tree (index included) contains game data or training material:
# ROMs other than the six bundled homebrew ones and the allowlisted GB Studio ones, saves and save states,
# datasets, model checkpoints, boot ROM / BIOS images other than the three hash-pinned SameBoy ones, any file
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
# Boot ROMs / BIOS dumps: only SameBoy's open-source (MIT) boot ROMs, at these paths with exactly this content
# (THIRD_PARTY_NOTICES.md). Any other file named like a boot ROM or BIOS image fails.
boot_roms='6f64da4cecd7e54e2f928eb3e3ba7810a7a567d0d247cc71737d1771e073a916  gb-core/boot/sameboy_dmg_boot.bin
f767b8e7e510a255f81328c89dba6e0c996b370e1bc86aebb8584a7da47a5bba  gb-core/boot/sameboy_cgb_boot.bin
b60d493a7944ccf74c81f1e7b6bf38c2c7029e296648ea0e74cb22b10dd1fcb8  gb-core/boot/sameboy_sgb_boot.bin'
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
