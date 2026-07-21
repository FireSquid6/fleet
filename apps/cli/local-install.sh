#!/usr/bin/env bash
set -euo pipefail

cd "$(dirname "$0")"

mkdir -p "$HOME/.local/bin"
bun run ./build.ts
cp ./out/fleet "$HOME/.local/bin/fleet"
rm -f "$HOME/.local/bin/fleet-agent"
