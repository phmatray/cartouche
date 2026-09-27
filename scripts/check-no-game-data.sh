#!/usr/bin/env bash
# Fails if the tracked tree (index included) contains game data or training material:
# ROMs other than the six bundled homebrew ones and the allowlisted GB Studio ones, saves and save states,
# datasets, model checkpoints, any file over 2 MB, or anything referring to a local training directory.
# The only model data allowed in the repository is gb-web/src/neural/weights/*.bin.
# scripts/rom-allowlist.sha1 lists each hosted GB Studio ROM ("<sha1>  <path>", shasum format): a ROM is allowed
# there only with that exact content, and only a listed ROM is exempt from the 2 MB limit.
set -euo pipefail
cd "$(git rev-parse --show-toplevel)"

max_bytes=$((2 * 1024 * 1024))
allowed_roms='^gb-web/public/roms/(tobutobugirl\.gb|tobutobugirldx\.gb|ucity\.gbc|cgb-acid2\.gbc|dmg-acid2\.gb|cpu_instrs\.gb)$'
allowlist=scripts/rom-allowlist.sha1
banned_ext='\.(gb|gbc|sgb|sav|srm|state|npz|npy|pt|pth|ckpt|safetensors|onnx|h5|pkl)$'
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

# Content: no reference to the local training directory (its files name the games).
if git grep -I -l -i 'cartouche-training' -- ':!scripts/check-no-game-data.sh'; then
  echo "^ these tracked files mention the local training directory"; fail=1
fi

if (( fail )); then exit 1; fi
echo "OK: no game data, datasets or checkpoints tracked."
