/**
 * Aztec testnet faucet for the privacy-lab dashboard.
 *
 *   POST /mint   { to: AztecAddress, token: "AZA" | "AZB" }
 *     → { txHash } (fire-and-forget; tx is submitted but not awaited)
 *
 *   GET /health  → { ok, nodeVersion, l1ChainId, rollupVersion, admin }
 *
 * Designed to run in a Docker container on a VPS, exposed publicly via
 * Tailscale Funnel or similar. The admin Schnorr account secret comes from
 * environment variables — never bake it into the image.
 */
import express, { type Request, type Response } from 'express'
import { AztecAddress } from '@aztec/aztec.js/addresses'

import { loadTestnetState } from './state.ts'
import { bootWallet, type FaucetWallet } from './wallet.ts'
import { checkRateLimit, recordMint } from './rate-limit.ts'

const PORT = Number(process.env.PORT ?? '8095')
const CORS_ORIGIN = process.env.CORS_ORIGIN ?? '*'
const MINT_AMOUNT = BigInt(process.env.MINT_AMOUNT ?? '10000')

const ALLOWED_TOKENS = new Set(['AZA', 'AZB'])
const ADDRESS_RE = /^0x[0-9a-fA-F]{64}$/

interface MintBody {
  to?: unknown
  token?: unknown
}

async function main() {
  const state = loadTestnetState()
  console.log(`[faucet] loaded testnet state, network=${state.network ?? 'testnet'}`)

  console.log(`[faucet] booting wallet — first run can take a few minutes`)
  const wallet = await bootWallet(state)
  console.log(`[faucet] wallet ready`)

  const app = express()
  app.use(express.json({ limit: '8kb' }))
  app.use((req, res, next) => {
    res.setHeader('Access-Control-Allow-Origin', CORS_ORIGIN)
    res.setHeader('Access-Control-Allow-Methods', 'POST, GET, OPTIONS')
    res.setHeader('Access-Control-Allow-Headers', 'Content-Type')
    if (req.method === 'OPTIONS') {
      res.status(204).end()
      return
    }
    next()
  })

  app.get('/health', async (_req, res) => {
    res.json({
      ok: true,
      admin: wallet.admin.toString(),
      token0: state.token0.address,
      token1: state.token1.address,
      mintAmount: MINT_AMOUNT.toString(),
    })
  })

  app.post('/mint', async (req: Request, res: Response) => {
    const body = (req.body ?? {}) as MintBody
    const to = typeof body.to === 'string' ? body.to.trim() : ''
    const token = typeof body.token === 'string' ? body.token.toUpperCase().trim() : ''

    if (!ADDRESS_RE.test(to)) {
      res.status(400).json({ error: 'invalid `to` — expected 0x-prefixed 64-hex Aztec address' })
      return
    }
    if (!ALLOWED_TOKENS.has(token)) {
      res.status(400).json({ error: `invalid \`token\` — expected one of ${[...ALLOWED_TOKENS].join(', ')}` })
      return
    }

    const decision = checkRateLimit(to, token)
    if (!decision.allowed) {
      res.status(429).json({ error: decision.reason, retryAfterSeconds: decision.retryAfterSeconds })
      return
    }

    try {
      const contract = token === 'AZA' ? wallet.token0 : wallet.token1
      const recipient = AztecAddress.fromString(to)

      console.log(`[faucet] minting ${MINT_AMOUNT} ${token} → ${to}`)
      // Submit and return immediately. Real proving + block inclusion can take
      // minutes; the client polls its own PXE for the balance bump.
      const sent = await mint(contract, recipient, wallet)
      recordMint(to, token)
      res.json({ txHash: sent.txHash, amount: MINT_AMOUNT.toString(), token, to })
    } catch (err) {
      console.error('[faucet] mint failed:', err)
      const message = err instanceof Error ? err.message : String(err)
      res.status(500).json({ error: `mint failed: ${message}` })
    }
  })

  app.listen(PORT, () => {
    console.log(`[faucet] listening on :${PORT}`)
  })
}

async function mint(
  contract: FaucetWallet['token0'],
  to: AztecAddress,
  wallet: FaucetWallet,
): Promise<{ txHash: string }> {
  // mint_to_public is a public function — no private execution needed beyond
  // the account contract's entrypoint (which still needs an IVC proof). The
  // Token contract treats msg_sender as the minter check; the admin is
  // pre-registered as a minter at deploy time.
  const sent = await contract.methods
    .mint_to_public(to, MINT_AMOUNT)
    .send({ from: wallet.admin, fee: wallet.feeOpts })
  // .send() resolves to a result that contains the tx hash. The exact shape
  // varies a bit across versions; coerce safely.
  const txHash =
    (sent as { txHash?: { toString: () => string } }).txHash?.toString() ??
    (sent as { tx?: { txHash?: { toString: () => string } } }).tx?.txHash?.toString() ??
    'unknown'
  return { txHash }
}

main().catch((err) => {
  console.error('[faucet] fatal:', err)
  process.exit(1)
})
