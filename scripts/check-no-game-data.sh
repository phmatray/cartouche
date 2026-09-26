#!/usr/bin/env bash
# Fails if the tracked tree (index included) contains game data or training material:
# ROMs other than the six bundled homebrew ones, saves and save states, datasets,
# model checkpoints, any file over 2 MB, or anything referring to a local training directory.
# The only model data allowed in the repository is gb-web/src/neural/weights/*.bin.
set -euo pipefail
cd "$(git rev-parse --show-toplevel)"

max_bytes=$((2 * 1024 * 1024))
allowed_roms='^gb-web/public/roms/(tobutobugirl\.gb|tobutobugirldx\.gb|ucity\.gbc|cgb-acid2\.gbc|dmg-acid2\.gb|cpu_instrs\.gb)$'
banned_ext='\.(gb|gbc|sgb|sav|srm|state|npz|npy|pt|pth|ckpt|safetensors|onnx|h5|pkl)$'
fail=0

while IFS= read -r -d '' f; do
  lower=$(printf '%s' "$f" | tr '[:upper:]' '[:lower:]')
  if [[ $lower =~ $banned_ext && ! $f =~ $allowed_roms ]]; then
    echo "game data / model file not allowed: $f"; fail=1
  fi
  if [[ $lower == *cartouche-training* ]]; then
    echo "training path not allowed: $f"; fail=1
  fi
  if [[ -f $f ]] && (( $(wc -c < "$f") > max_bytes )); then
    echo "file over 2 MB: $f"; fail=1
  fi
done < <(git ls-files -z)

# Content: no reference to the local training directory (its files name the games).
if git grep -I -l -i 'cartouche-training' -- ':!scripts/check-no-game-data.sh'; then
  echo "^ these tracked files mention the local training directory"; fail=1
fi

if (( fail )); then exit 1; fi
echo "OK: no game data, datasets or checkpoints tracked."
