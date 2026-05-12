# Aztec Privacy Lab

Dashboard for trying privacy-varied Noir contracts on Aztec — see what stays hidden vs what leaks for each design.

**Phase 1 status:** AMM (Uniswap V2 in Noir) deployed end-to-end on the local Aztec sandbox using the bundled `@aztec/noir-contracts.js` reference contracts. Dashboard renders the full 7-variation privacy matrix and the live deployment state (AMM/Token/LP addresses + admin's private balances).

## Run it

Three steps — node, deploy, dashboard.

```bash
# 1. Start the Aztec local network on port 8090
#    (port 8080 is held by another service on this machine)
#    minTxsPerBlock=0 + enforceTimeTable=false relax the proposer constraints;
#    without these the proposer stalls around block 30 and L1→L2 claims fail.
#    Even with both, the proposer still skips genuinely idle slots — the
#    BridgePanel's Claim handler self-pokes L2 with a 1-wei public transfer
#    between retries to force a block roll past the message checkpoint.
aztec start --local-network --port 8090 \
  --sequencer.minTxsPerBlock 0 \
  --sequencer.enforceTimeTable false
```

```bash
# 2. In a second shell, deploy the AMM stack
npm run sandbox:setup
# Deploys two Token contracts + LP Token + AMM, mints 1M of each
# token to the admin's private balance, writes addresses to
# public/sandbox-state.json.

# 3. (optional but recommended) seed the AMM with initial liquidity + run a sample swap
npm run sandbox:seed
# Pool starts at 100k/200k AZA/AZB, sample 1,000 AZA → AZB swap.
# Reserves + last-swap info appended to the state file.
```

```bash
# 4. Start the dashboard
npm run dev
# → http://localhost:5173
```

The dashboard header shows `node 4.2.1 · l1-chain 31337 · block N` and a green "Sandbox AMM — pool seeded" panel with all addresses + current reserves + last swap. Click **Try variant a** → **Initialize browser PXE** → **Run swap** to execute a private swap entirely in the tab.

## Stack

- Vite + React 19 + TypeScript + Tailwind v4
- `@aztec/aztec.js`, `@aztec/wallets/embedded`, `@aztec/accounts`, `@aztec/noir-contracts.js`, `@aztec/pxe` — all 4.2.1
- `vite-plugin-node-polyfills` to satisfy `Buffer`/`process` references in aztec.js (only matters for the dashboard; scripts run in Node directly)
- `tsx` for running the deploy scripts

## What's where

```
contracts-l1/           Solidity workspace (Forge)
  MockSwapRouter/       1:1 exactInputSingle planted at the V3 mainnet address via anvil_setCode
contracts/              Noir workspace (aztec-nargo)
  Nargo.toml            workspace declaration
  private_swap_wrapper/
    Nargo.toml          variant c commitment-hidden swap amount
    src/main.nr
  public_total_crowdfunding/
    Nargo.toml          variant lp2 — public total counter + private donor
    src/main.nr
  per_donor_receipts/
    Nargo.toml          variant lp3 — public per-donor receipts (hashed identity)
    src/main.nr
  target/*.json         Compiled Aztec artifacts (consumed by codegen + the deploy script)
scripts/
  setup-sandbox.ts       Deploy Token + AMM + PrivateSwapWrapper, mint private balances,
                         serialize contract instances
  seed-and-swap.ts       Seed initial liquidity, run sample swap, write reserves to state file
  deploy-l1-portal.ts    Deploy L1 TestERC20 + TokenPortal, redeploy L2 bridge against real portal
  plant-mock-router.ts   Forge-compile MockSwapRouter, plant its runtime at the V3 mainnet address
  wire-uniswap-stack.ts  Deploy output TestERC20+portal+UniswapPortal+L2 bridge, redeploy L2 Uniswap, fund router
  run-uniswap-swap.ts    End-to-end L2→L1→swap→L1→L2 loop (gather witnesses, retry on outbox cadence)
public/
  sandbox-state.json     Deployed addresses + serialized contract instances (read by the dashboard
                         and by the in-browser PXE to rehydrate without re-deploying)
src/
  App.tsx                Mount point
  lib/
    network.ts           Sandbox + testnet config (nodeUrl, faucet, explorer)
    aztec.ts             Aztec node JSON-RPC client wrapper
    wallet.ts            Wallet connect stub (Azguard in-page RPC)
    sandbox-state.ts     Fetches and caches sandbox-state.json
    browser-sandbox.ts   Lazy-imports @aztec/wallets/embedded + PXE in the browser,
                         registers the test account, rehydrates contract instances
  data/
    variations.ts        7 AMM privacy variations + verdicts + reasoning
  components/
    Shell.tsx            Page layout
    NetworkBadge.tsx     Sandbox / Testnet dropdown
    WalletConnect.tsx    Connect button + connected-state pill
    NodeStatus.tsx       Live node version, chain id, block
    SandboxState.tsx     "AMM deployed" panel with addresses + balances
    PrivacyMatrix.tsx    Grid of 7 variation cards
    VariationCard.tsx    One card: verdict, axes, expandable explainer
    SwapPanel.tsx        Click-to-swap, add/remove-LP, commit-amount with live reserves
    LaunchpadMatrix.tsx  3 launchpad variation cards
    LaunchpadPanel.tsx   Both Crowdfunding flows (lp1: fully private, lp2: public total)
    StatsStrip.tsx       Top-of-page stats: live sections, contracts deployed, L2 block, L1 escrow
    ui/Copyable.tsx      Click-to-copy address pill with ✓ feedback
    ui/VerdictBadge.tsx  Shared verdict pill (buildable/hard/research/blocked)
    ui/AxisPill.tsx      Shared public/private pill
    ui/MatrixHeader.tsx  Shared title + subtitle + legend for matrix sections
    LendingMatrix.tsx    4 lending variation cards
    LendingPanel.tsx     Secret-keyed private deposit + borrow against the bundled Lending
    CrossChainCard.tsx   Phase 2 status panel: L2 contracts deployed, L1 portal gap explained
    VotingPanel.tsx      Anonymous voting + double-vote-revert demo
    BridgePanel.tsx      L1 → L2 deposit (via bridgeTokensPublic) + claim_public on L2
  contracts/             Codegen output — `aztec codegen` produces this from contracts/target/
    PrivateSwapWrapper.ts
```

Phase 1 uses pre-built Noir contracts from `@aztec/noir-contracts.js` instead of authoring our own. The interesting privacy work happens in *which* variations the dashboard surfaces and *how* it explains the trade-offs — not in re-implementing Uniswap V2 in Noir from scratch. Custom Noir contracts come in later phases for the variants the reference set doesn't cover (variant c — commitment-hidden amounts).

## Networks

- **Sandbox** (default): local Aztec node on `localhost:8090`. Full deploy + interactive demos.
- **Testnet (Alpha v4)**: read-only via `https://aztec.drpc.org`. The network toggle switches the live node-status panel to live testnet state (block height, version) but interactive demos stay sandbox-bound — the deploy scripts use the local network's pre-funded test accounts and would need Azguard + faucet-funded testnet accounts to run against the public testnet.

## Roadmap

See `/home/fervor/.claude/plans/i-want-to-experiment-greedy-conway.md`. Phases:

0. **Foundations** — done.
1. **Pure-Aztec AMM** — done (read-only display). Token + AMM deployed, privacy matrix live, deploy script reproducible.
1.5. **Browser-interactive swap (variant a)** — done. Click "Try variant a" → "Initialize browser PXE" → "Run swap". The PXE runs in the tab (~10 MB of WASM), the test account secret never leaves the page, the AMM contract instance is rehydrated from `sandbox-state.json`, the swap is proved locally and submitted, and live reserves + private balance refresh after the tx mines.
1.6. **Variants (f) and (c) live** — done. Variant (f) drives `add_liquidity` / `remove_liquidity` from the same panel and tracks the user's private LP-share balance (a UTXO note on the LP token). Variant (c) deploys a custom Noir contract (`PrivateSwapWrapper`) authored in this repo at `contracts/` — Pedersen-commits to a private amount via `commit_amount(amount, randomness)`, with an `open_commitment` utility for verifiers. The remaining research-grade piece is binding the commitment to a curve-respect proof.
2. **Cross-chain bridge — full bidirectional round-trip live.** `npm run sandbox:l1-portal` deploys `TestERC20` + `TokenPortal.sol` on anvil, redeploys the L2 `TokenBridge` with the real portal address, and initialises the portal against the Aztec registry. The dashboard's `BridgePanel` handles both directions in the browser:
   - **L1 → L2** via `bridgeTokensPublic` → portal escrows TestERC20 → archiver picks up the message → `claim_public` mints AZA to the L2 recipient.
   - **L2 → L1** via `setPublicAuthwit` (to let the bridge burn) + `exit_to_l1_public` → AZA burned → L2→L1 message in outbox → `computeL2ToL1MembershipWitness` + `portal.withdrawFunds` releases the escrowed TestERC20 on L1 to the recipient.

   Verified end-to-end: bridge 1,000 then withdraw 500. L1 deployer 1,000,000 → 999,500 TestERC20; portal escrow 0 → 500; admin L2 public AZA 200,000 → 200,000 (net zero after 1,000 in / 500 out / 500 still on L2).

   **Uniswap-on-L1 router blocker — resolved via `anvil_setCode`.** `npm run sandbox:mock-router` Forge-compiles a minimal `MockSwapRouter.sol` (a 1:1 `exactInputSingle`), deploys it on anvil to get its runtime bytecode, then plants that runtime at the hardcoded mainnet address `0xE592427A0AEce92De3Edee1F18E0157C05861564` via `anvil_setCode`.

   **Full Uniswap stack wired.** `npm run sandbox:uniswap` then deploys a second L1 `TestERC20` (output token), a paired L1 `TokenPortal`, the L1 `UniswapPortal.sol`, a second L2 `TokenBridge` for the output side, redeploys the L2 `UniswapContract` against the real L1 UniswapPortal address, initialises both L1 portals against the registry + corresponding L2 contracts, grants the output bridge minter rights on the L2 token, and pre-funds the mock router with 1 M output tokens + the input portal with 100 k input tokens.

   **End-to-end swap closed from the browser.** `BridgePanel` has the full three-button Uniswap-from-L2 flow, verified working end-to-end:
   - **Swap** → L2 `swap_public` burns AZA, emits two L2→L1 messages.
   - **Relay swap on L1** → reads both messages from the tx effect, computes membership witnesses, retries `UniswapPortal.swapPublic` until the sandbox's cheat-code outbox advance covers the epoch (12 s backoff). On success, decodes the L1 `Inbox.MessageSent` log to capture the output mint's leaf index.
   - **Claim AZB on L2** → `outputBridge.claim_public(admin, amount, secret, leafIndex)`. Between retries, self-pokes L2 with a 1-wei public transfer so a block rolls past the message checkpoint (the sandbox proposer otherwise skips idle slots).

   Verified ledger after one round-trip: L1 input portal escrow 100,000 → 99,500 (-500 released to UniswapPortal); admin L2 public AZA 200,000 → 199,500 (-500 burned in the L2 swap); admin L2 public AZB +500 (minted via the output bridge claim). The same flow lives in `scripts/run-uniswap-swap.ts` as a Node version with identical logic for reproducibility outside the browser.
3. **Lending (Aave/Compound style)** — variants ld1 and ld3 live (bundled Lending contract). ld1 = secret-keyed private positions (deposit/borrow from private balances; debt-asset mints to public). ld3 = fully public Aave baseline (deposit_public uses setPublicAuthwit, borrow_public is address-keyed). Same contract, same oracle (PriceFeed 1:1, 80% LTV) — direct comparison of the privacy delta. ld2 (mixed) and ld4 (anonymous liquidation) remain documented as follow-ups.

3.5. **Anonymous voting** — bundled `PrivateVoting` contract. One vote per address via Aztec's nullifier mechanism (a `SingleUseClaim` keyed by the voter's address inside a private function). Public yes/no tallies tick up; observers see only `tally += 1` and an emitted nullifier hash, not the voter. Try voting twice — the second attempt reverts with "duplicate siloed nullifier", the contract's anti-double-vote guard.
4. **Launchpad / ICO** — all three variants live. lp1: bundled Crowdfunding (fully private raise). lp2: custom Noir `PublicTotalCrowdfunding` (public total counter + private donors). lp3: custom Noir `PerDonorReceipts` (public receipt slots keyed by pedersen_hash(donor_addr, donor_salt) + private donor identity). Donors who want to prove participation can reveal their (addr, salt) opening later.
3. **Lending (Aave/Compound style)** — one buildable variation, rest are explainers.
4. **Launchpad / ICO** — private claim against public allocation.
5. **Testnet migration** — flip the network toggle on, deploy contracts to Alpha v4.

## Not for production

Research/demo code. Not audited. Do not deposit real funds.
