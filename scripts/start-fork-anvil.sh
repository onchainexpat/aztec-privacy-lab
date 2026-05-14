#!/usr/bin/env bash
# Start Anvil in mainnet-fork mode on port 8546 so the Aztec sandbox can run
# against real Uniswap V3 (SwapRouter at 0xE592...1564) and real WETH/USDC.
#
# After this is running, start Aztec with:
#   ETHEREUM_HOSTS=http://localhost:8546 aztec start --local-network
#
# Override the upstream RPC via env if publicnode is rate-limited:
#   FORK_RPC=https://eth.llamarpc.com ./scripts/start-fork-anvil.sh

set -euo pipefail

FORK_RPC="${FORK_RPC:-https://eth-mainnet.public.blastapi.io}"
PORT="${FORK_PORT:-8546}"
# Fork block selection:
# - Pre-Cancun (block < 19426587 ≈ March 13, 2024) is missing opcodes (PUSH0,
#   MCOPY, TLOAD/TSTORE) that Aztec's L1 contracts compile against, causing
#   `NotActivated` reverts on deploy.
# - Forking at a recent block with active blob usage breaks Aztec L1
#   publication (Block blob_gas_price > max_fee_per_blob_gas).
# - Sweet spot: fork shortly after Dencun activation (block 19426587) when
#   blob usage was light, plus force `--hardfork cancun` so anvil uses
#   post-Cancun rules for new blocks. blob_gas_price decays toward 1 wei
#   as anvil mines new blocks without blobs.
FORK_BLOCK="${FORK_BLOCK:-19500000}"
HARDFORK="${HARDFORK:-cancun}"

echo "Anvil — fork mainnet"
echo "  fork from:  $FORK_RPC"
echo "  fork block: $FORK_BLOCK (post-Dencun, blob gas active but low)"
echo "  hardfork:   $HARDFORK"
echo "  serving:    http://localhost:$PORT"
echo "  default mnemonic: 'test test test ... junk' (10000 ETH on account[0])"
echo

# Pin the fork block + hardfork so anvil applies post-Cancun rules to new
# blocks (needed for Aztec's L1 contracts). Aztec warps timestamps forward
# via cheat codes, so the calendar date doesn't matter.
exec anvil \
  --fork-url "$FORK_RPC" \
  --fork-block-number "$FORK_BLOCK" \
  --hardfork "$HARDFORK" \
  --port "$PORT" \
  --host 0.0.0.0 \
  --chain-id 31337 \
  --no-rate-limit
