import { useEffect, useState } from 'react'
import {
  getResolvedTestnetClient,
  subscribeTestnetClient,
  type TestnetClient,
} from '../lib/browser-testnet'
import type { SandboxState } from '../lib/sandbox-state'
import { resolveTestnetNodeUrl } from '../lib/testnet-url'
import { PrivacyLeakage } from './ui/PrivacyLeakage'
import type { SealedBidAuctionContract } from '../contracts/SealedBidAuction'
import { TxResult } from './ui/TxResult'

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

export function AuctionPanelTestnet({ state, onClose }: Props) {
  const [client, setClient] = useState<TestnetClient | null>(getResolvedTestnetClient())
  const [contract, setContract] = useState<SealedBidAuctionContract | null>(null)
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

  useEffect(() => subscribeTestnetClient(setClient), [])

  // L2 time can drift; poll the L2 block header so the countdown matches the
  // contract's `self.context.timestamp()` view.
  useEffect(() => {
    let cancelled = false
    async function poll() {
      try {
        // Read the L2 header via our node (resolveTestnetNodeUrl) rather than
        // state.sandboxUrl (the public RPC), so this poll isn't 429-prone.
        const res = await fetch(await resolveTestnetNodeUrl(), {
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

  // Attach the SealedBidAuction contract to the per-tab wallet.
  useEffect(() => {
    if (!client || !cfg) return
    let cancelled = false
    ;(async () => {
      try {
        const [{ jsonParseWithSchema }, { ContractInstanceWithAddressSchema }, mod, { AztecAddress }] =
          await Promise.all([
            import('@aztec/foundation/json-rpc'),
            import('@aztec/stdlib/contract'),
            import('../contracts/SealedBidAuction'),
            import('@aztec/aztec.js/addresses'),
          ])
        const inst = jsonParseWithSchema(
          JSON.stringify(cfg.instance),
          ContractInstanceWithAddressSchema,
        )
        await (client.wallet as unknown as {
          registerContract: (i: unknown, a: unknown) => Promise<void>
        }).registerContract(inst, mod.SealedBidAuctionContractArtifact)
        const c = await mod.SealedBidAuctionContract.at(
          AztecAddress.fromString(cfg.address),
          client.wallet,
        )
        if (!cancelled) setContract(c as unknown as SealedBidAuctionContract)
      } catch (e) {
        if (!cancelled) setError(formatError(e))
      }
    })()
    return () => {
      cancelled = true
    }
  }, [client, cfg])

  async function refreshStatus(c: SealedBidAuctionContract, cl: TestnetClient) {
    const [bidsR, revealedR, winningR, winnerR, settledR] = await Promise.all([
      c.methods.get_bid_count().simulate({ from: cl.address }),
      c.methods.get_revealed_count().simulate({ from: cl.address }),
      c.methods.get_winning_bid().simulate({ from: cl.address }),
      c.methods.get_winner().simulate({ from: cl.address }),
      c.methods.get_settled().simulate({ from: cl.address }),
    ])
    setStatus({
      bidCount: Number(bidsR.result),
      revealedCount: Number(revealedR.result),
      winningBid: winningR.result as bigint,
      winner: (winnerR.result as { toString(): string }).toString(),
      settled: Boolean(settledR.result),
    })
  }

  useEffect(() => {
    if (contract && client) void refreshStatus(contract, client)
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [contract, client])

  async function handlePlaceBid() {
    if (!contract || !client) return
    setBusy(true)
    setError(null)
    try {
      const amount = BigInt(bidAmount)
      if (amount <= 0n) throw new Error('bid must be positive')
      const { Fr } = await import('@aztec/aztec.js/fields')
      const salt = Fr.random()
      await contract.methods
        .place_bid(amount, salt)
        .send({ from: client.address, fee: client.feeOpts })
      const next: LocalCommitment = {
        amount,
        salt: salt.toString(),
        placedAt: Math.floor(Date.now() / 1000),
      }
      setCommitments((prev) => [...prev, next])
      await refreshStatus(contract, client)
    } catch (e) {
      setError(formatError(e))
    } finally {
      setBusy(false)
    }
  }

  async function handleRevealBid(c: LocalCommitment) {
    if (!contract || !client) return
    setBusy(true)
    setError(null)
    try {
      const { Fr } = await import('@aztec/aztec.js/fields')
      const salt = Fr.fromString(c.salt)
      await contract.methods
        .reveal_bid(c.amount, salt)
        .send({ from: client.address, fee: client.feeOpts })
      await refreshStatus(contract, client)
    } catch (e) {
      setError(formatError(e))
    } finally {
      setBusy(false)
    }
  }

  return (
    <section className="mt-10 rounded-2xl border border-black/10 bg-white p-6">
      <div className="flex items-center justify-between">
        <h3 className="text-lg font-semibold">Sealed-bid auction — variant g5 (testnet)</h3>
        <button onClick={onClose} className="text-sm text-black/50 underline-offset-4 hover:underline">
          Close
        </button>
      </div>
      <p className="mt-2 text-sm text-black/60">
        Live on Aztec testnet. Place any number of sealed bids during the bid window with your
        per-tab account. Each bid is a one-way commitment hash on chain — amounts stay hidden.
        When the reveal window opens, you choose which bids to reveal. Bids you keep sealed stay
        private <em>forever</em>.
      </p>
      <p className="mt-2 rounded border border-emerald-200 bg-emerald-50 p-2 text-xs text-emerald-900">
        <strong>Privacy property:</strong> commitment = pedersen(your_address, amount, salt).
        Each placed bid emits a single opaque field element on chain. Observers count placements
        but learn nothing about amounts. At reveal you choose what (if anything) to publish.
      </p>

      {!client ? (
        <p className="mt-4 rounded border border-amber-200 bg-amber-50 p-3 text-sm text-amber-900">
          Initialize your testnet account in the wallet panel above first (the per-tab Schnorr
          account funded by SponsoredFPC). Then this panel activates.
        </p>
      ) : !contract ? (
        <p className="mt-4 text-sm text-black/50">Attaching contract…</p>
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
                {busy ? 'Working…' : 'Place sealed bid'}
              </button>
              {!inBidWindow && (
                <span className="text-xs text-black/50">Bid window closed.</span>
              )}
            </div>
            <PrivacyLeakage
              className="mt-2"
              publicLeaks={['bid counter +1', 'opaque commitment hash']}
              staysPrivate={['bidder address', 'bid amount', 'salt']}
            />
          </div>

          <div className="mt-4 rounded-xl border border-black/10 p-4">
            <p className="text-sm font-medium">
              Your local commitments ({commitments.length})
            </p>
            <p className="mt-1 text-xs text-black/50">
              Saved client-side only. If you refresh the page, the salts are gone and the bids
              stay sealed forever — a feature, not a bug.
            </p>
            <PrivacyLeakage
              className="mt-2"
              publicLeaks={['your address', 'revealed bid amount', 'winner state update']}
              staysPrivate={['other unrevealed bids of yours (and everyone elses)']}
            />
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
                      bid {i + 1}: {c.amount.toString()} (salt {c.salt.slice(0, 10)}…)
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
                {status.bidCount} bids placed — {status.revealedCount} revealed —{' '}
                {status.winningBid > 0n
                  ? `current top: ${status.winningBid.toString()}`
                  : 'no reveals yet'}
              </p>
              {status.winningBid > 0n && (
                <p className="mt-1 font-mono text-[11px] text-black/70">
                  winner: {status.winner.slice(0, 14)}…
                </p>
              )}
              <button
                disabled
                className="mt-3 rounded-full bg-[var(--color-ink)] px-3 py-1.5 text-xs font-medium text-[var(--color-paper)] opacity-50"
                title="operator-only — the demo issuer settles the auction after the reveal window"
              >
                {status.settled ? 'Settled' : 'Settle (operator-only)'}
              </button>
              <p className="mt-2 text-[11px] text-black/45">
                settle is operator-only (the demo issuer runs it after the reveal window). Your
                place_bid / reveal_bid actions above are what a visitor runs.
              </p>
            </div>
          )}

          {error && <TxResult message={error} />}
        </>
      )}
    </section>
  )
}

function formatError(e: unknown): string {
  if (e instanceof Error) return `${e.name}: ${e.message}`
  return String(e)
}
