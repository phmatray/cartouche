#!/usr/bin/env bash
# Builds src/vendor/rcheevos.js: RetroAchievements' rcheevos (MIT) and shim.c, compiled to one WebAssembly module
# inlined in an ES module (loaded only once a player turns on unlocking). Needs emscripten (brew install emscripten).
# Run from gb-web: rcheevos/build.sh
set -euo pipefail
VERSION=12.5.0
SHA256=e6df83de4e18f0a19206e711e1e589624dcfcf6bf529c14f6dd2bb2d1ced983f
cd "$(dirname "$0")"
work=$(mktemp -d)
trap 'rm -rf "$work"' EXIT
curl -sSfL "https://github.com/RetroAchievements/rcheevos/archive/refs/tags/v$VERSION.tar.gz" -o "$work/src.tgz"
echo "$SHA256  $work/src.tgz" | shasum -a 256 -c -
tar xzf "$work/src.tgz" -C "$work"
src="$work/rcheevos-$VERSION"
emcc -Oz -flto -DRC_NO_THREADS -I"$src/include" -I"$src/src" \
  shim.c "$src"/src/rc_client.c "$src"/src/rc_compat.c "$src"/src/rc_util.c "$src"/src/rc_version.c \
  "$src"/src/rapi/*.c "$src"/src/rcheevos/*.c "$src"/src/rhash/md5.c \
  -sMODULARIZE -sEXPORT_ES6 -sEXPORT_NAME=createRcheevos -sSINGLE_FILE -sENVIRONMENT=web,node \
  -sALLOW_MEMORY_GROWTH -sFILESYSTEM=0 \
  -sEXPORTED_FUNCTIONS=_malloc,_free -sEXPORTED_RUNTIME_METHODS=UTF8ToString,stringToNewUTF8,HEAPU32 \
  -o ../src/vendor/rcheevos.js
cp "$src/LICENSE" ../src/vendor/rcheevos.LICENSE
echo "built src/vendor/rcheevos.js from rcheevos $VERSION"
