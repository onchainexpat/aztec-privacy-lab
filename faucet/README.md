# Aztec Privacy Lab — Testnet Faucet

Small Express service that mints AZA / AZB to per-tab visitor accounts so the
dashboard's interactive demos work on Aztec Alpha v4 testnet. Designed to run
in a Docker container on a VPS, exposed publicly via Tailscale Funnel (or any
HTTPS-fronted reverse proxy).

## API

| Endpoint | Body / Query | Returns |
|---|---|---|
| `POST /mint` | `{to: AztecAddress, token: "AZA"\|"AZB"}` | `{txHash, amount, token, to}` (fire-and-forget — tx submitted but not awaited) |
| `GET /health` | — | `{ok, admin, token0, token1, mintAmount}` |

Per-recipient cooldown defaults to 1 hour (`MINT_COOLDOWN_SECONDS`).

## Why this exists separately

The dashboard ships as a static Vite site (Vercel). Visitors run their own
per-tab Schnorr account in the browser (real proofs, paid by SponsoredFPC).
For the interactive demos they need AZA / AZB to deposit into ld2, swap on the
AMM, etc. Vercel serverless functions can't host the mint flow — the
@aztec/* dependency tree is too large for the function bundle limit, and the
real-prover IVC step exceeds the 10s free-tier timeout. A dedicated tiny
server is the right shape.

## Deploy

1. **Copy the deployed contract state in.** The faucet needs to know the
   canonical AZA + AZB contract instances. From the project root:

       cp public/testnet-state.json faucet/testnet-state.json

   Re-run after any `npm run testnet:setup` redeploy.

2. **Set the admin Schnorr secret.**

       cp faucet/.env.example faucet/.env
       # paste the TESTNET_SECRET/SALT/SIGNING produced by
       # `npm run testnet:generate-key` (the same ones that deployed
       # the testnet contracts)

3. **Build + run.**

       cd faucet
       docker compose up -d --build

   First boot syncs the PXE state to `/data` (mounted volume). Takes a few
   minutes against `rpc.testnet.aztec-labs.com`. Subsequent restarts are
   fast.

4. **Expose via Tailscale Funnel.** Inside the VPS:

       tailscale funnel --bg --tcp=8095 8095

   (Or `tailscale funnel --bg 8095` for HTTPS proxying with a public
   hostname.) The public URL goes into the dashboard's faucet config.

## Isolation

The container drops all capabilities, runs as uid 10001, has a read-only
root filesystem (only `/data` is writable), and lives on its own systemd
slice via docker. Memory + CPU caps via compose. The admin secret is only
mounted into this one container, never into other services on the host.

If the faucet ever has an RCE, the worst it should produce is:

- spam mints from the admin account on testnet (testnet only, no real funds)
- exhaust the per-volume 2 GB of memory budget
- consume CPU

Anything beyond that requires a Docker / kernel escape.

## Restart-safe

The PXE state at `/data/...` and the rate-limit DB at `/data/faucet.sqlite`
both persist across restarts. The container can be `docker compose
restart`-ed without re-syncing the L2 from genesis.
