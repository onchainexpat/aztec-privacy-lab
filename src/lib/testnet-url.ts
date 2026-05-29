// Single source of truth for the Aztec testnet node URL the browser talks to.
//
// Default: the canonical public RPC (rpc.testnet.aztec-labs.com), which has
// historically rate-limited under load via its QuickNode L1 backend (see
// describeTxError in tx-status.ts). To point the dashboard at a self-hosted
// node — e.g. our own archiver in /mnt/nodes/aztec-testnet-v4 exposed via
// Tailscale Funnel — set VITE_TESTNET_NODE_URL at build time:
//
//   VITE_TESTNET_NODE_URL=https://fervor.tail3e3a0c.ts.net:8443
//
// Vercel: Project → Settings → Environment Variables → add VITE_TESTNET_NODE_URL.
// Local: drop the same line in .env.local (gitignored).
//
// Vite inlines import.meta.env at build time, so the value baked into the
// shipped bundle reflects whatever was set when `vite build` ran. Empty/unset
// → public RPC (no behavior change vs. today).

export const TESTNET_NODE_URL: string =
  (import.meta.env.VITE_TESTNET_NODE_URL as string | undefined)?.trim() ||
  'https://rpc.testnet.aztec-labs.com'
