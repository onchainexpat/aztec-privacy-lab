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
import { NO_WAIT } from '@aztec/aztec.js/contracts'

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
  /** When true, mint as a private note instead of into the public balance.
   *  Mint_to_private is a private function on the Token contract, so this
   *  variant generates a real IVC proof in the faucet's PXE (~30 s extra
   *  wall clock per request). Needed for AMM-side demos where the swap
   *  call expects the caller to have private notes. */
  private?: unknown
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
    const isPrivate = body.private === true

    if (!ADDRESS_RE.test(to)) {
      res.status(400).json({ error: 'invalid `to` — expected 0x-prefixed 64-hex Aztec address' })
      return
    }
    if (!ALLOWED_TOKENS.has(token)) {
      res.status(400).json({ error: `invalid \`token\` — expected one of ${[...ALLOWED_TOKENS].join(', ')}` })
      return
    }

    const rateKey = `${token}${isPrivate ? ':priv' : ''}`
    const decision = checkRateLimit(to, rateKey)
    if (!decision.allowed) {
      res.status(429).json({ error: decision.reason, retryAfterSeconds: decision.retryAfterSeconds })
      return
    }

    try {
      const contract = token === 'AZA' ? wallet.token0 : wallet.token1
      const recipient = AztecAddress.fromString(to)

      console.log(`[faucet] minting ${MINT_AMOUNT} ${token} ${isPrivate ? 'private' : 'public'} → ${to}`)
      const sent = await mint(contract, recipient, wallet, isPrivate)
      recordMint(to, rateKey)
      res.json({
        txHash: sent.txHash,
        amount: MINT_AMOUNT.toString(),
        token,
        private: isPrivate,
        to,
      })
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
  isPrivate: boolean,
): Promise<{ txHash: string }> {
  // wait: NO_WAIT returns TxSendResultImmediate immediately after submission —
  // client polls its own PXE for the balance bump rather than the server
  // awaiting block inclusion.
  const interaction = isPrivate
    ? contract.methods.mint_to_private(to, MINT_AMOUNT)
    : contract.methods.mint_to_public(to, MINT_AMOUNT)
  const sent = await interaction.send({
    from: wallet.admin,
    fee: wallet.feeOpts,
    wait: NO_WAIT,
  })
  return { txHash: sent.txHash.toString() }
}

main().catch((err) => {
  console.error('[faucet] fatal:', err)
  process.exit(1)
})
