import { useEffect, useState } from 'react'
import { initBrowserSandbox, type BrowserSandbox } from '../lib/browser-sandbox'
import type { SandboxState } from '../lib/sandbox-state'
import { PrivacyLeakage } from './ui/PrivacyLeakage'

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

export function EscrowPanel({ state, onClose }: Props) {
  const [sandbox, setSandbox] = useState<BrowserSandbox | null>(null)
  const [progress, setProgress] = useState<string | null>(null)
  const [error, setError] = useState<string | null>(null)
  const [busy, setBusy] = useState(false)
  const [privateAza, setPrivateAza] = useState<bigint | null>(null)

  const [itemDesc, setItemDesc] = useState<string>('MacBook Air M3 (wishlist)')
  const [amount, setAmount] = useState<string>('5000')
  const [orderId, setOrderId] = useState<string>('AMZ-114-7782931')

  // Active escrow tracked locally
  const [escrowId, setEscrowId] = useState<string | null>(null)
  const [escrowSalt, setEscrowSalt] = useState<string | null>(null)
  const [status, setStatus] = useState<number>(-1)
  const [escrowCount, setEscrowCount] = useState<number>(0)
  const [releasedCount, setReleasedCount] = useState<number>(0)

  async function refreshBalance(sb: BrowserSandbox) {
    const { result } = await sb.token0.methods
      .balance_of_private(sb.admin)
      .simulate({ from: sb.admin })
    setPrivateAza(result as bigint)
  }

  async function refreshGlobal(sb: BrowserSandbox) {
    if (!sb.goodsEscrow) return
    const [cR, rR] = await Promise.all([
      sb.goodsEscrow.methods.get_escrow_count().simulate({ from: sb.admin }),
      sb.goodsEscrow.methods.get_released_count().simulate({ from: sb.admin }),
    ])
    setEscrowCount(Number(cR.result))
    setReleasedCount(Number(rR.result))
  }

  async function refreshStatus(sb: BrowserSandbox, id: string) {
    if (!sb.goodsEscrow) return
    const { Fr } = await import('@aztec/aztec.js/fields')
    const r = await sb.goodsEscrow.methods
      .get_status(Fr.fromString(id))
      .simulate({ from: sb.admin })
    setStatus(Number(r.result))
  }

  async function handleInit() {
    setError(null)
    setBusy(true)
    try {
      const sb = await initBrowserSandbox(state, setProgress)
      if (!sb.goodsEscrow) throw new Error('GoodsEscrow not deployed - re-run sandbox:setup')
      setSandbox(sb)
      await refreshBalance(sb)
      await refreshGlobal(sb)
    } catch (e) {
      setError(formatError(e))
    } finally {
      setBusy(false)
    }
  }

  async function handleCreate() {
    if (!sandbox?.goodsEscrow) return
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
      const sim = await sandbox.goodsEscrow.methods
        .create_escrow(amt, itemHash, deadline, salt, authwitNonce)
        .simulate({ from: sandbox.admin })
      await sandbox.goodsEscrow.methods
        .create_escrow(amt, itemHash, deadline, salt, authwitNonce)
        .send({ from: sandbox.admin })
      const id = '0x' + (sim.result as bigint).toString(16).padStart(64, '0')
      setEscrowId(id)
      setEscrowSalt(salt.toString())
      await refreshStatus(sandbox, id)
      await refreshGlobal(sandbox)
      await refreshBalance(sandbox)
    } catch (e) {
      setError(formatError(e))
    } finally {
      setBusy(false)
    }
  }

  async function handleAttestPurchase() {
    if (!sandbox?.goodsEscrow || !escrowId) return
    setBusy(true)
    setError(null)
    try {
      const { Fr } = await import('@aztec/aztec.js/fields')
      const { pedersenHash } = await import('@aztec/foundation/crypto/sync')
      const orderHash = pedersenHash([stringToField(orderId)])
      await sandbox.goodsEscrow.methods
        .attest_purchase(Fr.fromString(escrowId), orderHash.toBigInt())
        .send({ from: sandbox.admin })
      await refreshStatus(sandbox, escrowId)
    } catch (e) {
      setError(formatError(e))
    } finally {
      setBusy(false)
    }
  }

  async function handleAttestDelivery() {
    if (!sandbox?.goodsEscrow || !escrowId) return
    setBusy(true)
    setError(null)
    try {
      const { Fr } = await import('@aztec/aztec.js/fields')
      // Fulfiller payout to admin (self) in the demo.
      await sandbox.goodsEscrow.methods
        .attest_delivery(Fr.fromString(escrowId), sandbox.admin)
        .send({ from: sandbox.admin })
      await refreshStatus(sandbox, escrowId)
      await refreshGlobal(sandbox)
      await refreshBalance(sandbox)
    } catch (e) {
      setError(formatError(e))
    } finally {
      setBusy(false)
    }
  }

  useEffect(() => {
    if (!sandbox) return
    void refreshBalance(sandbox)
  }, [sandbox])

  return (
    <section className="mt-10 rounded-2xl border border-black/10 bg-white p-6">
      <div className="flex items-center justify-between">
        <h3 className="text-lg font-semibold">P2P goods escrow - zkp2p-style</h3>
        <button onClick={onClose} className="text-sm text-black/50 underline-offset-4 hover:underline">
          Close
        </button>
      </div>
      <p className="mt-2 text-sm text-black/60">
        "Buy me this on Amazon." A buyer locks USDC against a commitment to an item. A fulfiller
        buys it IRL; an attestor validates the purchase + delivery evidence (in production, a
        zkEmail/zkTLS proof of Amazon's confirmation emails) and the escrow releases USDC. If no
        one fulfills before the deadline, the buyer refunds.
      </p>
      <p className="mt-2 rounded border border-emerald-200 bg-emerald-50 p-2 text-xs text-emerald-900">
        <strong>Privacy property:</strong> buyer creates the escrow via a private function (L2
        identity hidden); escrow_id = pedersen(buyer, salt) so only the buyer can refund without
        revealing they were the buyer. The link between the on-chain USDC and the off-chain Amazon
        order is never published - only an opaque order-id nullifier (prevents the same order
        fulfilling two escrows, like zkp2p).
      </p>
      <p className="mt-2 rounded border border-amber-200 bg-amber-50 p-2 text-xs text-amber-900">
        <strong>Trust model:</strong> mirrors zkp2p's real architecture - a trusted{' '}
        <code className="font-mono text-[10px]">AttestationService</code> validates the evidence
        off-chain. Here the attestor is a privileged address. The trustless upgrade replaces it
        with an in-circuit zkEmail proof of Amazon's DKIM-signed emails (see the zkEmail PoC).
      </p>

      {!sandbox ? (
        <div className="mt-4">
          <button
            onClick={handleInit}
            disabled={busy}
            className="rounded-full bg-[var(--color-ink)] px-4 py-2 text-sm font-medium text-[var(--color-paper)] hover:opacity-90 disabled:opacity-50"
          >
            {busy ? 'Initializing...' : 'Initialize browser PXE'}
          </button>
          {progress && busy && <p className="mt-2 text-xs text-black/50">{progress}</p>}
        </div>
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

          {/* Step 1: buyer creates escrow */}
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
                {busy ? 'Working...' : 'Lock escrow'}
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

          {/* Step 2: attestor confirms purchase */}
          <div className="mt-4 rounded-xl border border-amber-200 bg-amber-50/40 p-4">
            <p className="text-sm font-medium text-amber-950">
              2 · Attestor: confirm Amazon purchase
            </p>
            <p className="mt-1 text-xs text-amber-900/80">
              In production this is gated by a zkEmail proof of Amazon's order-confirmation email.
              The order id is hashed + nullified so the same order can't fulfill two escrows.
            </p>
            <div className="mt-2 flex flex-wrap items-center gap-2">
              <input
                type="text"
                value={orderId}
                onChange={(e) => setOrderId(e.target.value)}
                disabled={busy || status !== STATUS_OPEN}
                className="w-56 rounded border border-black/15 px-2 py-1 font-mono text-xs disabled:opacity-40"
              />
              <button
                onClick={handleAttestPurchase}
                disabled={busy || status !== STATUS_OPEN}
                className="rounded-full bg-amber-600 px-3 py-1.5 text-xs font-medium text-white hover:opacity-90 disabled:opacity-50"
              >
                Attest purchase
              </button>
            </div>
          </div>

          {/* Step 3: attestor confirms delivery + release */}
          <div className="mt-4 rounded-xl border border-emerald-200 bg-emerald-50/40 p-4">
            <p className="text-sm font-medium text-emerald-950">
              3 · Attestor: confirm delivery + release USDC
            </p>
            <p className="mt-1 text-xs text-emerald-900/80">
              Gated by a zkEmail proof of Amazon's delivery-confirmation email in production.
              Releases the escrowed USDC to the fulfiller (self, in this demo).
            </p>
            <button
              onClick={handleAttestDelivery}
              disabled={busy || status !== STATUS_PURCHASED}
              className="mt-2 rounded-full bg-emerald-600 px-3 py-1.5 text-xs font-medium text-white hover:opacity-90 disabled:opacity-50"
            >
              Attest delivery + release
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
