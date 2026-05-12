// Client wrapper around the testnet faucet (see ../../faucet/).
//
// The faucet base URL comes from Vite's VITE_FAUCET_URL env var at build time.
// When unset, the dashboard surfaces an honest "no faucet configured" state
// instead of pretending to be interactive.

const FAUCET_URL = (
  (import.meta as ImportMeta & { env: Record<string, string | undefined> }).env
    .VITE_FAUCET_URL ?? ''
).replace(/\/$/, '')

export function isFaucetConfigured(): boolean {
  return FAUCET_URL.length > 0
}

export interface MintResponse {
  txHash: string
  amount: string
  token: 'AZA' | 'AZB'
  to: string
}

export interface MintError {
  error: string
  retryAfterSeconds?: number
}

export async function faucetMint(to: string, token: 'AZA' | 'AZB'): Promise<MintResponse> {
  if (!FAUCET_URL) {
    throw new Error('Faucet not configured (VITE_FAUCET_URL is empty).')
  }
  const res = await fetch(`${FAUCET_URL}/mint`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ to, token }),
  })
  const json = (await res.json().catch(() => ({}))) as Partial<MintResponse> & Partial<MintError>
  if (!res.ok) {
    const e = json as MintError
    const suffix =
      typeof e.retryAfterSeconds === 'number' ? ` (retry in ${e.retryAfterSeconds}s)` : ''
    throw new Error(`${e.error ?? `faucet returned ${res.status}`}${suffix}`)
  }
  return json as MintResponse
}

export async function faucetHealth(): Promise<{
  ok: boolean
  admin: string
  token0: string
  token1: string
  mintAmount: string
}> {
  if (!FAUCET_URL) throw new Error('Faucet not configured.')
  const res = await fetch(`${FAUCET_URL}/health`)
  if (!res.ok) throw new Error(`faucet /health returned ${res.status}`)
  return res.json()
}

export { FAUCET_URL }
