#!/usr/bin/env bash
# Full testnet redeploy — recovery tool for when Aztec resets Alpha v4 testnet
# (which wipes every deployed contract + the deployer's account).
#
# Runs the focused deploy scripts in dependency order: setup (account + AZA/AZB
# tokens + AMM + ld2 + voting) MUST go first because everything else reads
# token0/token1 from public/testnet-state.json; the rest can follow in any order.
#
# Usage (keys stay in your shell, never in the repo):
#   TESTNET_SECRET=0x... TESTNET_SALT=0x... TESTNET_SIGNING=0x... \
#     npm run testnet:redeploy-all
#
# SLOW: each step submits real testnet txs (proving + inclusion); a full run is
# ~1-2 hours and depends on testnet/SponsoredFPC being healthy. If a step fails
# transiently (Timeout awaiting isMined, SponsoredFPC wobble), re-run that one
# step's npm script directly, then continue with the remaining steps.
set -euo pipefail

for v in TESTNET_SECRET TESTNET_SALT TESTNET_SIGNING; do
  if [ -z "${!v:-}" ]; then
    echo "missing env $v — export the deployer keys first" >&2
    exit 1
  fi
done

steps=(
  testnet:setup                 # account + tokens + AMM (a/f) + ld2 + voting
  testnet:deploy-launchpad      # lp1 crowdfunding
  testnet:deploy-extras         # attestation, battleshipPvp(g3), auction(g5), wordle(g6), lottery(g7), goodsEscrow, batchPay
  testnet:deploy-payroll        # payroll (+ demo_add_payslip)
  testnet:deploy-rewards        # rewards (+ demo_claim)
  testnet:deploy-blackjack      # blackjack(g4) contract
  testnet:deploy-launchpad-extras  # lp2, lp3
  testnet:deploy-lending-extras    # ld1/ld3: PriceFeed + Lending + token1 minter
)

for s in "${steps[@]}"; do
  echo ""
  echo "=================== $s ==================="
  if ! npm run "$s"; then
    echo "FAILED at: $s — fix/retry this step, then re-run the remaining steps." >&2
    exit 1
  fi
done

echo ""
echo "✓ all testnet contracts redeployed; commit public/testnet-state.json + push to rebuild prod"
