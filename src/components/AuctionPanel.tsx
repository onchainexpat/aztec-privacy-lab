import { useEffect, useState } from 'react'
import { initBrowserSandbox, type BrowserSandbox } from '../lib/browser-sandbox'
import type { SandboxState } from '../lib/sandbox-state'

interface Props {
  state: SandboxState
  onClose: () => void
}

interface AuctionStatus {
  bidCount: number
  revealedCount: number
  winningBid: bigint
  winner: string
  settled: boolean
}

interface LocalCommitment {
  amount: bigint
  salt: string // hex
  placedAt: number
}

function formatTime(seconds: number): string {
  if (seconds <= 0) return 'closed'
  const m = Math.floor(seconds / 60)
  const s = seconds % 60
  return `${m}m ${s}s`
}

export function AuctionPanel({ state, onClose }: Props) {
  const [sandbox, setSandbox] = useState<BrowserSandbox | null>(null)
  const [progress, setProgress] = useState<string | null>(null)
  const [error, setError] = useState<string | null>(null)
  const [busy, setBusy] = useState(false)
  const [status, setStatus] = useState<AuctionStatus | null>(null)
  const [bidAmount, setBidAmount] = useState<string>('500')
  const [commitments, setCommitments] = useState<LocalCommitment[]>([])
  const [now, setNow] = useState<number>(Math.floor(Date.now() / 1000))

  const cfg = state.sealedBidAuction
  const bidDeadline = cfg ? Number(cfg.bidDeadline) : 0
  const revealDeadline = cfg ? Number(cfg.revealDeadline) : 0
  const inBidWindow = now < bidDeadline
  const inRevealWindow = now >= bidDeadline && now < revealDeadline

  useEffect(() => {
    let cancelled = false
    // Query L2 block timestamp because sandbox L2 time drifts ahead of
    // wall-clock - the contract checks `self.context.timestamp()` which is the
    // L2 time, so the UI countdown must use the same source to stay honest.
    async function poll() {
      try {
        const res = await fetch(state.sandboxUrl, {
          method: 'POST',
          headers: { 'content-type': 'application/json' },
          body: JSON.stringify({
            jsonrpc: '2.0', id: 1, method: 'node_getBlockHeader', params: [],
          }),
        })
        const data = (await res.json()) as {
          result?: { globalVariables?: { timestamp?: string | number | bigint } }
        }
        const ts = data?.result?.globalVariables?.timestamp
        if (ts != null && !cancelled) {
          setNow(Number(ts))
          return
        }
      } catch {
        // fall through to wall-clock fallback
      }
      if (!cancelled) setNow(Math.floor(Date.now() / 1000))
    }
    void poll()
    const tick = setInterval(poll, 5000)
    return () => {
      cancelled = true
      clearInterval(tick)
    }
  }, [state.sandboxUrl])

  async function refreshStatus(sb: BrowserSandbox) {
    if (!sb.sealedBidAuction) return
    const [bidsR, revealedR, winningR, winnerR, settledR] = await Promise.all([
      sb.sealedBidAuction.methods.get_bid_count().simulate({ from: sb.admin }),
      sb.sealedBidAuction.methods.get_revealed_count().simulate({ from: sb.admin }),
      sb.sealedBidAuction.methods.get_winning_bid().simulate({ from: sb.admin }),
      sb.sealedBidAuction.methods.get_winner().simulate({ from: sb.admin }),
      sb.sealedBidAuction.methods.get_settled().simulate({ from: sb.admin }),
    ])
    setStatus({
      bidCount: Number(bidsR.result),
      revealedCount: Number(revealedR.result),
      winningBid: winningR.result as bigint,
      winner: (winnerR.result as { toString(): string }).toString(),
      settled: Boolean(settledR.result),
    })
  }

  async function handleInit() {
    setError(null)
    setBusy(true)
    try {
      const sb = await initBrowserSandbox(state, setProgress)
      if (!sb.sealedBidAuction) {
        throw new Error('SealedBidAuction not deployed - re-run sandbox:setup')
      }
      setSandbox(sb)
      await refreshStatus(sb)
    } catch (e) {
      setError(formatError(e))
    } finally {
      setBusy(false)
    }
  }

  async function handlePlaceBid() {
    if (!sandbox?.sealedBidAuction) return
    setBusy(true)
    setError(null)
    try {
      const amount = BigInt(bidAmount)
      if (amount <= 0n) throw new Error('bid must be positive')
      const { Fr } = await import('@aztec/aztec.js/fields')
      const salt = Fr.random()
      await sandbox.sealedBidAuction.methods
        .place_bid(amount, salt)
        .send({ from: sandbox.admin })
      const next: LocalCommitment = {
        amount,
        salt: salt.toString(),
        placedAt: Math.floor(Date.now() / 1000),
      }
      setCommitments((prev) => [...prev, next])
      await refreshStatus(sandbox)
    } catch (e) {
      setError(formatError(e))
    } finally {
      setBusy(false)
    }
  }

  async function handleRevealBid(c: LocalCommitment) {
    if (!sandbox?.sealedBidAuction) return
    setBusy(true)
    setError(null)
    try {
      const { Fr } = await import('@aztec/aztec.js/fields')
      const salt = Fr.fromString(c.salt)
      await sandbox.sealedBidAuction.methods
        .reveal_bid(c.amount, salt)
        .send({ from: sandbox.admin })
      await refreshStatus(sandbox)
    } catch (e) {
      setError(formatError(e))
    } finally {
      setBusy(false)
    }
  }

  async function handleSettle() {
    if (!sandbox?.sealedBidAuction) return
    setBusy(true)
    setError(null)
    try {
      await sandbox.sealedBidAuction.methods
        .settle()
        .send({ from: sandbox.admin })
      await refreshStatus(sandbox)
    } catch (e) {
      setError(formatError(e))
    } finally {
      setBusy(false)
    }
  }

  return (
    <section className="mt-10 rounded-2xl border border-black/10 bg-white p-6">
      <div className="flex items-center justify-between">
        <h3 className="text-lg font-semibold">Sealed-bid auction - variant g5</h3>
        <button onClick={onClose} className="text-sm text-black/50 underline-offset-4 hover:underline">
          Close
        </button>
      </div>
      <p className="mt-2 text-sm text-black/60">
        Place any number of sealed bids during the bid window. Each bid is a one-way commitment
        hash on chain - amounts stay hidden. When the reveal window opens, you choose which bids
        to reveal. Bids you keep sealed stay private <em>forever</em>.
      </p>
      <p className="mt-2 rounded border border-emerald-200 bg-emerald-50 p-2 text-xs text-emerald-900">
        <strong>Privacy property:</strong> commitment = pedersen(your_address, amount, salt).
        Each placed bid emits a single opaque field element on chain. Observers count placements
        but learn nothing about amounts. At reveal you choose what (if anything) to publish.
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
              <p className="text-[10px] uppercase tracking-wide text-black/40">Bid window</p>
              <p className="mt-1 font-mono text-sm">
                {inBidWindow ? formatTime(bidDeadline - now) + ' left' : 'closed'}
              </p>
            </div>
            <div className="rounded-xl border border-black/10 bg-zinc-50 p-3 text-xs">
              <p className="text-[10px] uppercase tracking-wide text-black/40">Reveal window</p>
              <p className="mt-1 font-mono text-sm">
                {inRevealWindow
                  ? formatTime(revealDeadline - now) + ' left'
                  : now < bidDeadline
                    ? 'opens after bids close'
                    : 'closed'}
              </p>
            </div>
            <div className="rounded-xl border border-black/10 bg-zinc-50 p-3 text-xs">
              <p className="text-[10px] uppercase tracking-wide text-black/40">On-chain state</p>
              <p className="mt-1 font-mono text-xs">
                bids: {status?.bidCount ?? '-'} / revealed: {status?.revealedCount ?? '-'}
              </p>
              <p className="mt-1 font-mono text-xs">
                top bid: {status?.winningBid?.toString() ?? '-'}
              </p>
            </div>
          </div>

          <div className="mt-5 rounded-xl border border-black/10 p-4">
            <p className="text-sm font-medium">Place a sealed bid</p>
            <div className="mt-2 flex flex-wrap items-center gap-3">
              <input
                type="number"
                min={1}
                value={bidAmount}
                onChange={(e) => setBidAmount(e.target.value)}
                disabled={!inBidWindow || busy}
                className="w-32 rounded border border-black/15 px-2 py-1 text-sm disabled:opacity-40"
              />
              <button
                onClick={handlePlaceBid}
                disabled={!inBidWindow || busy}
                className="rounded-full bg-violet-600 px-4 py-2 text-sm font-medium text-white hover:opacity-90 disabled:opacity-50"
              >
                {busy ? 'Working...' : 'Place sealed bid'}
              </button>
              {!inBidWindow && (
                <span className="text-xs text-black/50">Bid window closed.</span>
              )}
            </div>
          </div>

          <div className="mt-4 rounded-xl border border-black/10 p-4">
            <p className="text-sm font-medium">
              Your local commitments ({commitments.length})
            </p>
            <p className="mt-1 text-xs text-black/50">
              Saved client-side only. If you refresh the page, the salts are gone and the bids
              stay sealed forever - a feature, not a bug.
            </p>
            {commitments.length === 0 ? (
              <p className="mt-2 text-xs text-black/40">no bids placed in this session</p>
            ) : (
              <ul className="mt-2 space-y-2">
                {commitments.map((c, i) => (
                  <li
                    key={i}
                    className="flex flex-wrap items-center justify-between gap-2 rounded border border-black/10 bg-white px-3 py-2 text-xs"
                  >
                    <span className="font-mono">
                      bid {i + 1}: {c.amount.toString()} (salt {c.salt.slice(0, 10)}...)
                    </span>
                    <button
                      onClick={() => handleRevealBid(c)}
                      disabled={!inRevealWindow || busy}
                      className="rounded-full bg-amber-500 px-3 py-1 text-xs font-medium text-white hover:opacity-90 disabled:opacity-40"
                    >
                      {inRevealWindow
                        ? 'Reveal'
                        : inBidWindow
                          ? 'Reveal (after bids close)'
                          : 'Reveal (window closed)'}
                    </button>
                  </li>
                ))}
              </ul>
            )}
          </div>

          {status && (
            <div className="mt-4 rounded-xl border border-black/10 p-4 text-sm">
              <p className="font-medium">Auction state</p>
              <p className="mt-1 text-xs text-black/60">
                {status.bidCount} bids placed - {status.revealedCount} revealed -{' '}
                {status.winningBid > 0n
                  ? `current top: ${status.winningBid.toString()}`
                  : 'no reveals yet'}
              </p>
              {status.winningBid > 0n && (
                <p className="mt-1 font-mono text-[11px] text-black/70">
                  winner: {status.winner.slice(0, 14)}...
                </p>
              )}
              <button
                onClick={handleSettle}
                disabled={now < revealDeadline || status.settled || busy}
                className="mt-3 rounded-full bg-[var(--color-ink)] px-3 py-1.5 text-xs font-medium text-[var(--color-paper)] hover:opacity-90 disabled:opacity-50"
              >
                {status.settled
                  ? 'Settled'
                  : now < revealDeadline
                    ? 'Settle (after reveal window)'
                    : 'Settle auction'}
              </button>
            </div>
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
