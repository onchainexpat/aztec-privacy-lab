#!/usr/bin/env bash
# Boots an Aztec Alpha v4 testnet node + archiver.
#
# Usage:
#   ./scripts/start-testnet-node.sh
#
# Defaults assume free public L1 RPCs (publicnode.com). Override via env:
#   AZTEC_DATA_DIR     — where the world state lives (default below)
#   AZTEC_PORT         — Aztec JSON-RPC port (default 8091)
#   L1_RPC_URL         — Ethereum mainnet execution RPC
#   L1_BEACON_URL      — Ethereum mainnet beacon (consensus) API
#
# First start: downloads a snapshot of recent rollup state, then catches up
# via L1. Several hours wall-clock typical.

set -euo pipefail

: "${AZTEC_DATA_DIR:=/mnt/nodes/aztec-testnet-v4}"
: "${AZTEC_PORT:=8091}"
: "${L1_RPC_URL:=https://ethereum-rpc.publicnode.com}"
: "${L1_BEACON_URL:=https://ethereum-beacon-api.publicnode.com}"

mkdir -p "$AZTEC_DATA_DIR"

AZTEC_BIN="${AZTEC_BIN:-$HOME/.aztec/current/node_modules/.bin/aztec}"
if [[ ! -x "$AZTEC_BIN" ]]; then
  echo "aztec CLI not found at $AZTEC_BIN" >&2
  exit 1
fi

echo "Aztec testnet node — starting"
echo "  data: $AZTEC_DATA_DIR"
echo "  port: $AZTEC_PORT"
echo "  L1 RPC:    $L1_RPC_URL"
echo "  L1 beacon: $L1_BEACON_URL"
echo

exec "$AZTEC_BIN" start \
  --node \
  --archiver \
  --network alpha-testnet \
  --port "$AZTEC_PORT" \
  --data-directory "$AZTEC_DATA_DIR" \
  --l1-rpc-urls "$L1_RPC_URL" \
  --l1-consensus-host-urls "$L1_BEACON_URL"
