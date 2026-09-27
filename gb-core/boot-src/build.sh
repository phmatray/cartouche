#!/usr/bin/env bash
# Rebuilds the boot ROMs in gb-core/boot/ from cartouche_boot.asm, byte for byte (`git diff gb-core/boot` stays
# empty on an unchanged tree). Needs Node (gen.mjs builds the animation tables) and rgbds at exactly this version.
set -euo pipefail
cd "$(dirname "$0")"

RGBDS=v1.0.4
[[ "$(rgbasm -V)" == "rgbasm $RGBDS" ]] || { echo "rgbds $RGBDS required (found: $(rgbasm -V 2>&1 || true))" >&2; exit 1; }

tmp=$(mktemp -d)
trap 'rm -rf "$tmp"' EXIT
node gen.mjs "$tmp"

build() { # output name, rgbasm defines...
  local name=$1; shift
  rgbasm "$@" -I "$tmp" -o "$tmp/$name.o" cartouche_boot.asm
  rgblink -x -o "../boot/$name.bin" "$tmp/$name.o"
}

build cgb_plain -D CGB -D CONCEPT=0
for concept in 1:registration 2:insert 3:shelf; do
  n=${concept%%:*} name=${concept#*:}
  build "dmg_$name" -D CONCEPT="$n"
  build "cgb_$name" -D CGB -D CONCEPT="$n"
  build "sgb_$name" -D SGB -D CONCEPT="$n"
done
ls -l ../boot
