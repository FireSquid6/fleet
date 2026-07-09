#!/usr/bin/env bash
#
# dev.sh — bring up the whole fleet locally for development:
#   1. start a fleet-ship  (host, from fleet-ship-config.yaml)
#   2. start a fleet-bridge (aggregator, from fleet-bridge-config.yaml)
#   3. register the ship with the bridge
#   4. start the fleet-client (React UI, proxying /bridge -> the bridge)
#
# Ctrl+C tears all three down. Ports come from the yaml configs; BRIDGE_URL
# (where the client proxies to) comes from .env.
set -euo pipefail
cd "$(dirname "$0")"

# --- config ---------------------------------------------------------------
# Load .env (BRIDGE_URL, etc.) into the environment.
set -a
[ -f .env ] && . ./.env
set +a

SHIP_CONFIG="fleet-ship-config.yaml"
BRIDGE_CONFIG="fleet-bridge-config.yaml"

port_of() { grep -E '^port:' "$1" | head -1 | awk '{print $2}'; }
SHIP_PORT="$(port_of "$SHIP_CONFIG")"
BRIDGE_PORT="$(port_of "$BRIDGE_CONFIG")"

SHIP_URL="http://localhost:${SHIP_PORT}"
BRIDGE_URL="${BRIDGE_URL:-http://localhost:${BRIDGE_PORT}}"
export BRIDGE_URL

# Data directories the configs point at (created up front so the servers can
# write into them on first run).
mkdir -p ./dev-data/fleet-ship-data ./.dev-data/fleet-bridge-data

# --- lifecycle ------------------------------------------------------------
pids=()
cleanup() {
  echo
  echo "dev.sh: shutting down…"
  for pid in "${pids[@]:-}"; do kill "$pid" 2>/dev/null || true; done
  wait 2>/dev/null || true
}
trap cleanup EXIT INT TERM

wait_for() { # <url> <name>
  for _ in $(seq 1 60); do
    if curl -sf -o /dev/null "$1"; then return 0; fi
    sleep 0.25
  done
  echo "dev.sh: timed out waiting for $2 at $1" >&2
  return 1
}

# --- 1. fleet-ship --------------------------------------------------------
echo "dev.sh: starting fleet-ship at ${SHIP_URL} …"
bun apps/fleet-ship/src/index.ts start -c "$SHIP_CONFIG" &
pids+=($!)
wait_for "${SHIP_URL}/system-resources" "fleet-ship"

# --- 2. fleet-bridge ------------------------------------------------------
echo "dev.sh: starting fleet-bridge at ${BRIDGE_URL} …"
bun apps/fleet-bridge/src/index.ts start -c "$BRIDGE_CONFIG" &
pids+=($!)
wait_for "${BRIDGE_URL}/ships" "fleet-bridge"

# --- 3. register the ship -------------------------------------------------
echo "dev.sh: registering ${SHIP_URL} with the bridge …"
if curl -sf -X POST "${BRIDGE_URL}/ships" \
  -H 'content-type: application/json' \
  -d "{\"url\":\"${SHIP_URL}\"}" >/dev/null; then
  echo "dev.sh: ship registered."
else
  echo "dev.sh: ship not newly registered (already known to the bridge?) — continuing."
fi

# --- 4. fleet-client ------------------------------------------------------
# Run from the app dir so its bunfig.toml (Tailwind plugin) is picked up.
# BRIDGE_URL is exported above, so the client's proxy targets the bridge.
echo "dev.sh: starting fleet-client (proxying /bridge -> ${BRIDGE_URL}) …"
# Foreground (not exec) so the cleanup trap still tears down the ship and bridge
# when the client exits or is interrupted.
( cd apps/fleet-client && bun --hot src/index.ts )
