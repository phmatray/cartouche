#!/bin/bash
set -e

echo "Building Rust WASM core..."
cd "$(dirname "$0")/../gb-core"
# Keep local paths (panic locations of registry crates) out of the binary.
RUSTFLAGS="--remap-path-prefix=$HOME=~" wasm-pack build --target web --out-dir pkg

echo "Building React frontend..."
cd ../gb-web
npm ci
npm run build

echo "Build complete!"
