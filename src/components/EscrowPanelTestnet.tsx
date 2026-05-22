import { useEffect, useState } from 'react'
import {
  getResolvedTestnetClient,
  subscribeTestnetClient,
  type TestnetClient,
} from '../lib/browser-testnet'
import type { SandboxState } from '../lib/sandbox-state'
import { PrivacyLeakage } from './ui/PrivacyLeakage'
import type { GoodsEscrowContract } from '../contracts/GoodsEscrow'

interface Props {
  state: SandboxState
  onClose: () => void
}

const STATUS_OPEN = 0
const STATUS_PURCHASED = 1
const STATUS_RELEASED = 2
const STATUS_REFUNDED = 3

function statusLabel(s: number): string {
  switch (s) {
    case STATUS_OPEN: return 'open · awaiting fulfiller'
    case STATUS_PURCHASED: return 'purchased · awaiting delivery'
    case STATUS_RELEASED: return 'released · fulfiller paid'
    case STATUS_REFUNDED: return 'refunded'
    default: return `unknown (${s})`
  }
}

// Pack a UTF-8 string (first 31 bytes) into a single field-sized bigint.
function stringToField(s: string): bigint {
  const bytes = new TextEncoder().encode(s).slice(0, 31)
  let acc = 0n
  for (const b of bytes) acc = acc * 256n + BigInt(b)
  return acc
}

export function EscrowPanelTestnet({ state, onClose }: Props) {
  const [client, setClient] = useState<TestnetClient | null>(getResolvedTestnetClient())
  const [contract, setContract] = useState<GoodsEscrowContract | null>(null)
  const [error, setError] = useState<string | null>(null)
  const [busy, setBusy] = useState(false)
  const [privateAza, setPrivateAza] = useState<bigint | null>(null)

  const [itemDesc, setItemDesc] = useState<string>('MacBook Air M3 (wishlist)')
  const [amount, setAmount] = useState<string>('5000')

  const [escrowId, setEscrowId] = useState<string | null>(null)
  const [escrowSalt, setEscrowSalt] = useState<string | null>(null)
  const [status, setStatus] = useState<number>(-1)
  const [escrowCount, setEscrowCount] = useState<number>(0)
  const [releasedCount, setReleasedCount] = useState<number>(0)

  const cfg = state.goodsEscrow

  useEffect(() => subscribeTestnetClient(setClient), [])

  // Attach the GoodsEscrow contract to the per-tab wallet.
  useEffect(() => {
    if (!client || !cfg) return
    let cancelled = false
    ;(async () => {
      try {
        const [{ jsonParseWithSchema }, { ContractInstanceWithAddressSchema }, mod, { AztecAddress }] =
          await Promise.all([
            import('@aztec/foundation/json-rpc'),
            import('@aztec/stdlib/contract'),
            import('../contracts/GoodsEscrow'),
            import('@aztec/aztec.js/addresses'),
          ])
        const inst = jsonParseWithSchema(
          JSON.stringify(cfg.instance),
          ContractInstanceWithAddressSchema,
        )
        await (client.wallet as unknown as {
          registerContract: (i: unknown, a: unknown) => Promise<void>
        }).registerContract(inst, mod.GoodsEscrowContractArtifact)
        const c = await mod.GoodsEscrowContract.at(AztecAddress.fromString(cfg.address), client.wallet)
        if (!cancelled) setContract(c as unknown as GoodsEscrowContract)
      } catch (e) {
        if (!cancelled) setError(formatError(e))
      }
    })()
    return () => {
      cancelled = true
    }
  }, [client, cfg])

  async function refreshBalance(cl: TestnetClient) {
    const { result } = await cl.token0.methods
      .balance_of_private(cl.address)
      .simulate({ from: cl.address })
    setPrivateAza(result as bigint)
  }

  async function refreshGlobal(c: GoodsEscrowContract, cl: TestnetClient) {
    const [cR, rR] = await Promise.all([
      c.methods.get_escrow_count().simulate({ from: cl.address }),
      c.methods.get_released_count().simulate({ from: cl.address }),
    ])
    setEscrowCount(Number(cR.result))
    setReleasedCount(Number(rR.result))
  }

  async function refreshStatus(c: GoodsEscrowContract, cl: TestnetClient, id: string) {
    const { Fr } = await import('@aztec/aztec.js/fields')
    const r = await c.methods.get_status(Fr.fromString(id)).simulate({ from: cl.address })
    setStatus(Number(r.result))
  }

  useEffect(() => {
    if (contract && client) {
      void refreshBalance(client)
      void refreshGlobal(contract, client)
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [contract, client])

  async function handleCreate() {
    if (!contract || !client) return
    setBusy(true)
    setError(null)
    try {
      const { Fr } = await import('@aztec/aztec.js/fields')
      const amt = BigInt(amount)
      const itemHash = Fr.fromString('0x' + stringToField(itemDesc).toString(16))
      const salt = Fr.random()
      const authwitNonce = Fr.random()
      // deadline: far future so the happy path isn't interrupted.
      const deadline = BigInt(Math.floor(Date.now() / 1000) + 3600 * 24)
      // create_escrow internally calls token0.transfer_to_public(buyer, escrow,
      // amount, authwitNonce). On testnet authorize that inner transfer here.
      const authwit = await client.wallet.createAuthWit(client.address, {
        caller: contract.address,
        call: await client.token0.methods
          .transfer_to_public(client.address, contract.address, amt, authwitNonce)
          .getFunctionCall(),
      })
      const sim = await contract.methods
        .create_escrow(amt, itemHash, deadline, salt, authwitNonce)
        .simulate({ from: client.address })
      await contract.methods
        .create_escrow(amt, itemHash, deadline, salt, authwitNonce)
        .send({ from: client.address, fee: client.feeOpts, authWitnesses: [authwit] })
      const id = '0x' + (sim.result as bigint).toString(16).padStart(64, '0')
      setEscrowId(id)
      setEscrowSalt(salt.toString())
      await refreshStatus(contract, client, id)
      await refreshGlobal(contract, client)
      await refreshBalance(client)
    } catch (e) {
      setError(formatError(e))
    } finally {
      setBusy(false)
    }
  }

  return (
    <section className="mt-10 rounded-2xl border border-black/10 bg-white p-6">
      <div className="flex items-center justify-between">
        <h3 className="text-lg font-semibold">P2P goods escrow — testnet (zkp2p-style)</h3>
        <button onClick={onClose} className="text-sm text-black/50 underline-offset-4 hover:underline">
          Close
        </button>
      </div>
      <p className="mt-2 text-sm text-black/60">
        Live on Aztec testnet. "Buy me this on Amazon." A buyer locks USDC against a commitment to
        an item. A fulfiller buys it IRL; an attestor validates the purchase + delivery evidence
        (in production, a zkEmail/zkTLS proof of Amazon's confirmation emails) and the escrow
        releases USDC. If no one fulfills before the deadline, the buyer refunds.
      </p>
      <p className="mt-2 rounded border border-emerald-200 bg-emerald-50 p-2 text-xs text-emerald-900">
        <strong>Privacy property:</strong> buyer creates the escrow via a private function (L2
        identity hidden); escrow_id = pedersen(buyer, salt) so only the buyer can refund without
        revealing they were the buyer. The link between the on-chain USDC and the off-chain Amazon
        order is never published — only an opaque order-id nullifier.
      </p>
      <p className="mt-2 rounded border border-amber-200 bg-amber-50 p-2 text-xs text-amber-900">
        <strong>Trust model:</strong> mirrors zkp2p's real architecture — a trusted{' '}
        <code className="font-mono text-[10px]">AttestationService</code> validates the evidence
        off-chain. On testnet the attestor is the demo issuer, so the attest steps below are
        attestor-only; you run the buyer's create_escrow.
      </p>

      {!client ? (
        <p className="mt-4 rounded border border-amber-200 bg-amber-50 p-3 text-sm text-amber-900">
          Initialize your testnet account in the wallet panel above first (the per-tab Schnorr
          account funded by SponsoredFPC). You also need private AZA — grab some from the wallet
          panel's faucet. Then this panel activates.
        </p>
      ) : !contract ? (
        <p className="mt-4 text-sm text-black/50">Attaching contract…</p>
      ) : (
        <>
          <div className="mt-4 grid grid-cols-1 gap-3 md:grid-cols-3">
            <div className="rounded-xl border border-black/10 bg-zinc-50 p-3 text-xs">
              <p className="text-[10px] uppercase tracking-wide text-black/40">Global state</p>
              <p className="mt-1 font-mono text-sm">escrows: {escrowCount}</p>
              <p className="mt-1 font-mono text-xs">released: {releasedCount}</p>
            </div>
            <div className="rounded-xl border border-black/10 bg-zinc-50 p-3 text-xs">
              <p className="text-[10px] uppercase tracking-wide text-black/40">Your escrow</p>
              <p className="mt-1 font-mono text-sm">
                {status < 0 ? 'none yet' : statusLabel(status)}
              </p>
            </div>
            <div className="rounded-xl border border-black/10 bg-zinc-50 p-3 text-xs">
              <p className="text-[10px] uppercase tracking-wide text-black/40">Your balance</p>
              <p className="mt-1 font-mono text-sm">
                {privateAza === null ? '-' : Number(privateAza).toLocaleString()} AZA
              </p>
            </div>
          </div>

          {/* Step 1: buyer creates escrow — visitor-runnable */}
          <div className="mt-5 rounded-xl border border-black/10 p-4">
            <p className="text-sm font-medium">1 · Buyer: lock USDC against an item</p>
            <div className="mt-2 flex flex-wrap items-center gap-2">
              <input
                type="text"
                value={itemDesc}
                onChange={(e) => setItemDesc(e.target.value)}
                disabled={busy || !!escrowId}
                className="w-64 rounded border border-black/15 px-2 py-1 text-sm disabled:opacity-40"
              />
              <input
                type="number"
                min={1}
                value={amount}
                onChange={(e) => setAmount(e.target.value)}
                disabled={busy || !!escrowId}
                className="w-28 rounded border border-black/15 px-2 py-1 text-sm disabled:opacity-40"
              />
              <button
                onClick={handleCreate}
                disabled={busy || !!escrowId}
                className="rounded-full bg-violet-600 px-4 py-2 text-sm font-medium text-white hover:opacity-90 disabled:opacity-50"
              >
                {busy ? 'Working…' : 'Lock escrow'}
              </button>
            </div>
            {escrowId && (
              <p className="mt-2 font-mono text-[10px] text-black/50">
                escrow_id {escrowId.slice(0, 18)}… · refund salt{' '}
                {escrowSalt ? escrowSalt.slice(0, 12) + '…' : '—'} (kept locally; needed to refund
                after the deadline if unfulfilled)
              </p>
            )}
            <PrivacyLeakage
              className="mt-2"
              publicLeaks={['escrow counter +1', 'amount locked', 'item commitment hash']}
              staysPrivate={['buyer address (private kernel)', 'item plaintext', 'refund salt']}
            />
          </div>

          {/* Step 2: attestor confirms purchase — attestor-only on testnet */}
          <div className="mt-4 rounded-xl border border-amber-200 bg-amber-50/40 p-4">
            <p className="text-sm font-medium text-amber-950">
              2 · Attestor: confirm Amazon purchase (attestor-only)
            </p>
            <p className="mt-1 text-xs text-amber-900/80">
              In production this is gated by a zkEmail proof of Amazon's order-confirmation email.
              On testnet the attestor is the demo issuer, so this is disabled for a visitor.
            </p>
            <button
              disabled
              className="mt-2 rounded-full bg-amber-600 px-3 py-1.5 text-xs font-medium text-white opacity-50"
              title="attestor-only — the demo issuer attests the purchase"
            >
              Attest purchase (attestor-only)
            </button>
          </div>

          {/* Step 3: attestor confirms delivery + release — attestor-only on testnet */}
          <div className="mt-4 rounded-xl border border-emerald-200 bg-emerald-50/40 p-4">
            <p className="text-sm font-medium text-emerald-950">
              3 · Attestor: confirm delivery + release USDC (attestor-only)
            </p>
            <p className="mt-1 text-xs text-emerald-900/80">
              Gated by a zkEmail proof of Amazon's delivery-confirmation email in production.
              Releases the escrowed USDC to the fulfiller. Attestor-only — the demo issuer runs it.
            </p>
            <button
              disabled
              className="mt-2 rounded-full bg-emerald-600 px-3 py-1.5 text-xs font-medium text-white opacity-50"
              title="attestor-only — the demo issuer confirms delivery + releases"
            >
              Attest delivery + release (attestor-only)
            </button>
          </div>

          {status === STATUS_RELEASED && (
            <p className="mt-4 rounded-lg border border-emerald-200 bg-emerald-50 p-3 text-sm text-emerald-900">
              Escrow released — fulfiller paid {Number(amount).toLocaleString()} AZA. The Amazon
              order ↔ on-chain payment link was never published; observers only saw an opaque
              order-id nullifier get consumed.
            </p>
          )}

          {error && (
            <pre className="mt-3 max-h-48 overflow-auto rounded-lg border border-rose-200 bg-rose-50 p-3 text-xs text-rose-900">
              {error}
            </pre>
          )}
        </>
      )}
    </section>
  )
}

function formatError(e: unknown): string {
  if (e instanceof Error) return `${e.name}: ${e.message}`
  return String(e)
}
