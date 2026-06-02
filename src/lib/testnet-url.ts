// Resolves which Aztec testnet node URL the browser talks to, with runtime
// failover.
//
// Primary  = VITE_TESTNET_NODE_URL if set at build time, else the public RPC.
// Fallback = the canonical public RPC (rpc.testnet.aztec-labs.com).
//
// We self-host a node (Nethermind + Lighthouse + Aztec archiver) exposed via
// Tailscale Funnel to dodge the public RPC's QuickNode rate-limiting (429s).
// But a home-hosted node is a single point of failure, so rather than baking
// it in as the only option, resolveTestnetNodeUrl() health-checks the primary
// and falls back to the public RPC when it's unreachable. The site gets the
// no-rate-limit win when our node is up, and degrades to today's behavior
// (public RPC) when it isn't — no redeploy needed to recover.
//
// Set the override in Vercel (Project → Settings → Environment Variables) or
// .env.local:
//   VITE_TESTNET_NODE_URL=https://fervor.tail3e3a0c.ts.net:8443

export const PUBLIC_TESTNET_RPC = 'https://rpc.testnet.aztec-labs.com'

// The configured primary. Vite inlines import.meta.env at build time.
const PRIMARY =
  (import.meta.env.VITE_TESTNET_NODE_URL as string | undefined)?.trim() || PUBLIC_TESTNET_RPC

// Static export for code that just needs *a* URL to show or to seed a script
// (display, logging). Use resolveTestnetNodeUrl() for anything that actually
// opens a client and wants failover.
export const TESTNET_NODE_URL = PRIMARY

// Cache the resolution so we probe at most once per TTL window per session.
// Short enough to recover within a minute if the node comes back (or to notice
// it going down mid-session), cheap enough to not probe on every panel mount.
let resolved: { url: string; at: number } | null = null
const TTL_MS = 60_000

async function isReachable(url: string, timeoutMs = 4000): Promise<boolean> {
  try {
    const ctrl = new AbortController()
    const timer = setTimeout(() => ctrl.abort(), timeoutMs)
    const res = await fetch(url, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'node_getBlockNumber', params: [] }),
      signal: ctrl.signal,
    })
    clearTimeout(timer)
    if (!res.ok) return false
    const json = await res.json()
    return json?.result != null
  } catch {
    return false
  }
}

/**
 * Returns the node URL to use right now: the configured primary if it's
 * reachable, otherwise the public RPC. When the primary IS the public RPC
 * (no override configured), returns it without a probe.
 */
export async function resolveTestnetNodeUrl(): Promise<string> {
  if (PRIMARY === PUBLIC_TESTNET_RPC) return PUBLIC_TESTNET_RPC
  const now = Date.now()
  if (resolved && now - resolved.at < TTL_MS) return resolved.url
  const url = (await isReachable(PRIMARY)) ? PRIMARY : PUBLIC_TESTNET_RPC
  resolved = { url, at: now }
  return url
}

// AztecNode methods that touch the tx mempool / submission path. Our self-hosted
// node runs with P2P disabled (archiver/RPC only), so it can serve state reads
// but has no way to propagate a submitted tx to a sequencer — sends would never
// mine. So when reads are routed to our node, we route just these methods to the
// public RPC (which has sequencer connectivity). Everything else — the L1-backed
// reads that were getting rate-limited (429) — stays on our node.
//
// This also keeps your home IP private: reads still go through the Tailscale
// Funnel (which relays via Tailscale's ingress, never exposing the origin IP),
// and sends go to the third-party public RPC — at no point is the home IP
// advertised (unlike re-enabling libp2p, which Funnel can't tunnel).
const SEND_PATH_METHODS = new Set([
  'sendTx',
  'getTxReceipt',
  'getTxEffect',
  'getPendingTxs',
  'getPendingTxCount',
  'getTxsByHash',
  'isValidTx',
])

/**
 * Build the AztecNode the wallet/PXE should use. When reads resolve to our
 * self-hosted node, returns a split node: tx submission/tracking → public RPC,
 * all reads → our node. When reads resolve to the public RPC (fallback), returns
 * a plain public client (no split needed).
 *
 * `createClient` is @aztec's createAztecNodeClient, passed in so this module
 * stays free of heavy @aztec imports (callers lazy-load it).
 */
export function makeTestnetNode<N extends object>(
  createClient: (url: string) => N,
  readUrl: string,
): N {
  const readNode = createClient(readUrl)
  if (readUrl === PUBLIC_TESTNET_RPC) return readNode // public handles everything
  const sendNode = createClient(PUBLIC_TESTNET_RPC)
  return new Proxy(readNode, {
    get(target, prop, receiver) {
      if (typeof prop === 'string' && SEND_PATH_METHODS.has(prop)) {
        const fn = (sendNode as Record<string, unknown>)[prop]
        return typeof fn === 'function' ? (fn as (...a: unknown[]) => unknown).bind(sendNode) : fn
      }
      const v = Reflect.get(target, prop, receiver)
      return typeof v === 'function' ? (v as (...a: unknown[]) => unknown).bind(target) : v
    },
  }) as N
}
