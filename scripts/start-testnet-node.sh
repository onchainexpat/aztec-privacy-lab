#!/usr/bin/env bash
# Boots an Aztec Alpha v4 testnet node + archiver.
#
# Usage:
#   ./scripts/start-testnet-node.sh
#
# Aztec Alpha v4 testnet settles to Sepolia (L1 chainId 11155111), so the
# defaults below point at Sepolia L1, NOT mainnet. Override via env:
#   AZTEC_DATA_DIR     — where world state + bb scratch live (default below)
#   AZTEC_PORT         — Aztec JSON-RPC port (default 8091)
#   L1_RPC_URL         — Sepolia execution RPC (comma-separated for failover)
#   L1_BEACON_URL      — Sepolia beacon (consensus) API, must serve blobs
#
# First start downloads a snapshot of recent rollup state and catches up via
# L1; several hours wall-clock typical.

set -euo pipefail

: "${AZTEC_DATA_DIR:=/mnt/nodes/aztec-testnet-v4}"
: "${AZTEC_PORT:=8091}"
# Admin API port. Default 8880 collides with a co-hosted sandbox node, so pick
# a distinct one here.
: "${AZTEC_ADMIN_PORT:=8881}"
# Local Sepolia stack (Nethermind execution + Lighthouse supernode beacon) on
# the LAN. Avoids the rate-limiting we hit on free public RPCs. The beacon MUST
# run with --supernode (PeerDAS): it has to custody enough data columns to
# reconstruct EIP-4844 blobs, which Aztec uses to rebuild L2 state.
# Override with public failover RPCs if the local stack is down, e.g.:
#   L1_RPC_URL=https://ethereum-sepolia-rpc.publicnode.com,https://sepolia.drpc.org
: "${L1_RPC_URL:=http://192.168.99.95:8546}"
: "${L1_BEACON_URL:=http://192.168.99.95:5152}"

mkdir -p "$AZTEC_DATA_DIR"
# Barretenberg scratch dir. Required by BBCircuitVerifier — without it the
# node crashes lazily the first time it tries to verify a block proof.
: "${BB_WORKING_DIRECTORY:=$AZTEC_DATA_DIR/bb}"
mkdir -p "$BB_WORKING_DIRECTORY"
export BB_WORKING_DIRECTORY
# publicnode (Sepolia) doesn't expose debug_traceTransaction. Aztec's archiver
# uses tracing for safety checks but tolerates its absence when this is set.
export ETHEREUM_ALLOW_NO_DEBUG_HOSTS=true
# Read-only archiver/RPC node — no sequencing, no peering. Without this the
# node tries to start LibP2P and crashes with "Announce address not provided".
export P2P_ENABLED=false

AZTEC_BIN="${AZTEC_BIN:-$HOME/.aztec/current/node_modules/.bin/aztec}"
if [[ ! -x "$AZTEC_BIN" ]]; then
  echo "aztec CLI not found at $AZTEC_BIN" >&2
  exit 1
fi

echo "Aztec testnet node — starting"
echo "  data:      $AZTEC_DATA_DIR"
echo "  bb scratch: $BB_WORKING_DIRECTORY"
echo "  port:      $AZTEC_PORT"
echo "  L1 RPC:    $L1_RPC_URL"
echo "  L1 beacon: $L1_BEACON_URL"
echo

exec "$AZTEC_BIN" start \
  --node \
  --archiver \
  --network alpha-testnet \
  --port "$AZTEC_PORT" \
  --admin-port "$AZTEC_ADMIN_PORT" \
  --data-directory "$AZTEC_DATA_DIR" \
  --l1-rpc-urls "$L1_RPC_URL" \
  --l1-consensus-host-urls "$L1_BEACON_URL"
