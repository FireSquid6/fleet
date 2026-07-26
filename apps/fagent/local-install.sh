#!/usr/bin/env bash
set -euo pipefail

cd "$(dirname "$0")"

mkdir -p "$HOME/.local/bin"
bun run ./build.ts
cp ./out/fagent "$HOME/.local/bin/fagent"
