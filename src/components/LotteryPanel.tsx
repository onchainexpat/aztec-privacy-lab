import { useEffect, useState } from 'react'
import { initBrowserSandbox, type BrowserSandbox } from '../lib/browser-sandbox'
import type { SandboxState } from '../lib/sandbox-state'
import { PrivacyLeakage } from './ui/PrivacyLeakage'

interface Props {
  state: SandboxState
  onClose: () => void
}

interface LocalTicket {
  number: number
  salt: string
  claimed: boolean
}

const ENTRY_FEE = 1000n
const PHASE_OPEN = 0
const PHASE_DRAWING = 1
const PHASE_DRAWN = 2
const PHASE_CLOSED = 3

function phaseLabel(p: number): string {
  switch (p) {
    case PHASE_OPEN: return 'open · buying tickets'
    case PHASE_DRAWING: return 'drawing · awaiting result'
    case PHASE_DRAWN: return 'drawn · claims open'
    case PHASE_CLOSED: return 'closed'
    default: return `unknown (${p})`
  }
}

export function LotteryPanel({ state, onClose }: Props) {
  const [sandbox, setSandbox] = useState<BrowserSandbox | null>(null)
  const [progress, setProgress] = useState<string | null>(null)
  const [error, setError] = useState<string | null>(null)
  const [busy, setBusy] = useState(false)
  const [pickInput, setPickInput] = useState<string>('42')
  const [tickets, setTickets] = useState<LocalTicket[]>([])
  const [phase, setPhase] = useState<number>(PHASE_OPEN)
  const [ticketCount, setTicketCount] = useState<number>(0)
  const [winningNumber, setWinningNumber] = useState<number>(0)
  const [winnersCount, setWinnersCount] = useState<number>(0)
  const [privateAza, setPrivateAza] = useState<bigint | null>(null)

  const cfg = state.lottery
  const maxNumber = cfg ? Number(cfg.maxNumber) : 100

  async function refreshBalance(sb: BrowserSandbox) {
    const { result } = await sb.token0.methods
      .balance_of_private(sb.admin)
      .simulate({ from: sb.admin })
    setPrivateAza(result as bigint)
  }

  async function refreshStatus(sb: BrowserSandbox) {
    if (!sb.lottery) return
    const [phaseR, countR, winningR, winnersR] = await Promise.all([
      sb.lottery.methods.get_phase().simulate({ from: sb.admin }),
      sb.lottery.methods.get_ticket_count().simulate({ from: sb.admin }),
      sb.lottery.methods.get_winning_number().simulate({ from: sb.admin }),
      sb.lottery.methods.get_winners_count().simulate({ from: sb.admin }),
    ])
    setPhase(Number(phaseR.result))
    setTicketCount(Number(countR.result))
    setWinningNumber(Number(winningR.result))
    setWinnersCount(Number(winnersR.result))
  }

  async function handleInit() {
    setError(null)
    setBusy(true)
    try {
      const sb = await initBrowserSandbox(state, setProgress)
      if (!sb.lottery) throw new Error('Lottery not deployed - re-run sandbox:setup')
      setSandbox(sb)
      await refreshBalance(sb)
      await refreshStatus(sb)
    } catch (e) {
      setError(formatError(e))
    } finally {
      setBusy(false)
    }
  }

  async function handleBuyTicket() {
    if (!sandbox?.lottery) return
    const num = parseInt(pickInput, 10)
    if (!Number.isInteger(num) || num < 1 || num > maxNumber) {
      setError(`number must be 1..${maxNumber}`)
      return
    }
    setBusy(true)
    setError(null)
    try {
      const { Fr } = await import('@aztec/aztec.js/fields')
      const salt = Fr.random()
      const authwitNonce = Fr.random()
      await sandbox.lottery.methods
        .buy_ticket(num, salt, authwitNonce)
        .send({ from: sandbox.admin })
      setTickets((prev) => [...prev, { number: num, salt: salt.toString(), claimed: false }])
      await refreshStatus(sandbox)
      await refreshBalance(sandbox)
    } catch (e) {
      setError(formatError(e))
    } finally {
      setBusy(false)
    }
  }

  async function handleRequestDraw() {
    if (!sandbox?.lottery) return
    setBusy(true)
    setError(null)
    try {
      await sandbox.lottery.methods.request_draw().send({ from: sandbox.admin })
      await refreshStatus(sandbox)
    } catch (e) {
      setError(formatError(e))
    } finally {
      setBusy(false)
    }
  }

  async function handleFinalizeDraw() {
    if (!sandbox?.lottery || !cfg) return
    setBusy(true)
    setError(null)
    try {
      const { Fr } = await import('@aztec/aztec.js/fields')
      const seed = Fr.fromString(cfg.seed)
      const salt = Fr.fromString(cfg.salt)
      await sandbox.lottery.methods
        .finalize_draw(seed, salt)
        .send({ from: sandbox.admin })
      await refreshStatus(sandbox)
    } catch (e) {
      setError(formatError(e))
    } finally {
      setBusy(false)
    }
  }

  async function handleClaim(t: LocalTicket) {
    if (!sandbox?.lottery) return
    setBusy(true)
    setError(null)
    try {
      const { Fr } = await import('@aztec/aztec.js/fields')
      const salt = Fr.fromString(t.salt)
      await sandbox.lottery.methods
        .claim_prize(t.number, salt)
        .send({ from: sandbox.admin })
      setTickets((prev) =>
        prev.map((p) => (p === t ? { ...p, claimed: true } : p)),
      )
      await refreshStatus(sandbox)
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

  const winningTickets = phase >= PHASE_DRAWN && winningNumber > 0
    ? tickets.filter((t) => t.number === winningNumber)
    : []

  return (
    <section className="mt-10 rounded-2xl border border-black/10 bg-white p-6">
      <div className="flex items-center justify-between">
        <h3 className="text-lg font-semibold">Lottery - variant g7</h3>
        <button onClick={onClose} className="text-sm text-black/50 underline-offset-4 hover:underline">
          Close
        </button>
      </div>
      <p className="mt-2 text-sm text-black/60">
        Pick a number 1-{maxNumber}, pay {Number(ENTRY_FEE).toLocaleString()} AZA from your
        private balance. The operator draws a winning number when the round closes. If your number
        matches, you can prove it - non-winners stay anonymous on chain.
      </p>
      <p className="mt-2 rounded border border-emerald-200 bg-emerald-50 p-2 text-xs text-emerald-900">
        <strong>Privacy property:</strong> ticket = pedersen(player, number, salt). Public state
        is just a counter of ticket commitments. The anonymity set is all ticket holders; only
        winners have incentive to reveal.
      </p>
      <p className="mt-2 rounded border border-amber-200 bg-amber-50 p-2 text-xs text-amber-900">
        <strong>RNG note:</strong> sandbox uses operator commit-reveal (seed hash committed at
        deploy, revealed at finalize) - same trust model as g6 Wordle. The contract also emits
        an L2-&gt;L1 message at request_draw as an architectural hook for a real Chainlink VRF
        portal (same pattern as variant h Uniswap or variant i Base bridge).
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
              <p className="text-[10px] uppercase tracking-wide text-black/40">Phase</p>
              <p className="mt-1 font-mono text-sm">{phaseLabel(phase)}</p>
            </div>
            <div className="rounded-xl border border-black/10 bg-zinc-50 p-3 text-xs">
              <p className="text-[10px] uppercase tracking-wide text-black/40">On-chain state</p>
              <p className="mt-1 font-mono text-sm">tickets: {ticketCount}</p>
              <p className="mt-1 font-mono text-xs">winners: {winnersCount}</p>
              {winningNumber > 0 && (
                <p className="mt-1 font-mono text-xs">winning #: {winningNumber}</p>
              )}
            </div>
            <div className="rounded-xl border border-black/10 bg-zinc-50 p-3 text-xs">
              <p className="text-[10px] uppercase tracking-wide text-black/40">Your balance</p>
              <p className="mt-1 font-mono text-sm">
                {privateAza === null ? '-' : Number(privateAza).toLocaleString()} AZA
              </p>
            </div>
          </div>

          <div className="mt-5 rounded-xl border border-black/10 p-4">
            <p className="text-sm font-medium">Buy a ticket</p>
            <div className="mt-2 flex flex-wrap items-center gap-3">
              <input
                type="number"
                min={1}
                max={maxNumber}
                value={pickInput}
                onChange={(e) => setPickInput(e.target.value)}
                disabled={phase !== PHASE_OPEN || busy}
                className="w-24 rounded border border-black/15 px-2 py-1 text-sm disabled:opacity-40"
              />
              <button
                onClick={handleBuyTicket}
                disabled={
                  phase !== PHASE_OPEN ||
                  busy ||
                  (privateAza !== null && privateAza < ENTRY_FEE)
                }
                className="rounded-full bg-violet-600 px-4 py-2 text-sm font-medium text-white hover:opacity-90 disabled:opacity-50"
              >
                {busy ? 'Working...' : `Buy ticket · ${Number(ENTRY_FEE).toLocaleString()} AZA`}
              </button>
              {phase !== PHASE_OPEN && (
                <span className="text-xs text-black/50">Ticket sales closed.</span>
              )}
            </div>
            <PrivacyLeakage
              className="mt-2"
              publicLeaks={['ticket counter +1', 'contract public balance +1000 AZA']}
              staysPrivate={['buyer address', 'chosen number', 'salt']}
            />
          </div>

          <div className="mt-4 rounded-xl border border-black/10 p-4">
            <p className="text-sm font-medium">
              Your local tickets ({tickets.length})
            </p>
            <p className="mt-1 text-xs text-black/50">
              Saved client-side only. Number + salt needed to claim if your number wins.
            </p>
            {tickets.length === 0 ? (
              <p className="mt-2 text-xs text-black/40">no tickets in this session</p>
            ) : (
              <ul className="mt-2 space-y-1">
                {tickets.map((t, i) => {
                  const isWinner = phase >= PHASE_DRAWN && t.number === winningNumber
                  return (
                    <li key={i} className="flex items-center justify-between text-xs">
                      <span className="font-mono">
                        #{i + 1} number = {t.number}{' '}
                        {isWinner && (
                          <span className="ml-1 rounded bg-emerald-100 px-1 py-0.5 text-emerald-900">
                            WINNER
                          </span>
                        )}
                        {t.claimed && (
                          <span className="ml-1 text-black/40">(claimed)</span>
                        )}
                      </span>
                      {isWinner && !t.claimed ? (
                        <button
                          onClick={() => handleClaim(t)}
                          disabled={busy}
                          className="rounded-full bg-emerald-600 px-3 py-1 text-xs font-medium text-white hover:opacity-90 disabled:opacity-50"
                        >
                          Claim prize
                        </button>
                      ) : (
                        <span className="font-mono text-[10px] text-black/40">
                          salt {t.salt.slice(0, 10)}...
                        </span>
                      )}
                    </li>
                  )
                })}
              </ul>
            )}
            {phase >= PHASE_DRAWN && tickets.length > 0 && winningTickets.length === 0 && (
              <p className="mt-2 text-xs text-black/50">
                None of your numbers matched. Your tickets stay encrypted in your PXE forever.
              </p>
            )}
          </div>

          {/* Operator controls */}
          <div className="mt-4 rounded-xl border border-amber-200 bg-amber-50/40 p-4">
            <p className="text-sm font-medium text-amber-950">Operator controls</p>
            <div className="mt-2 flex flex-wrap items-center gap-3">
              <button
                onClick={handleRequestDraw}
                disabled={phase !== PHASE_OPEN || busy}
                className="rounded-full bg-amber-600 px-3 py-1.5 text-xs font-medium text-white hover:opacity-90 disabled:opacity-50"
              >
                Request draw
              </button>
              <button
                onClick={handleFinalizeDraw}
                disabled={phase !== PHASE_DRAWING || busy}
                className="rounded-full bg-amber-600 px-3 py-1.5 text-xs font-medium text-white hover:opacity-90 disabled:opacity-50"
              >
                Finalize (reveal seed)
              </button>
            </div>
            <PrivacyLeakage
              className="mt-2"
              publicLeaks={['phase transition', 'L2->L1 message hash (VRF hook)']}
              staysPrivate={['committed seed (until finalize)']}
            />
            <PrivacyLeakage
              className="mt-2"
              publicLeaks={['seed', 'salt', 'winning number']}
              staysPrivate={['nothing further (round resolved)']}
              caveat="finalize reveals the operator's seed - that's the trust point. Real Chainlink VRF via portal would remove this caveat."
            />
            <p className="mt-3 text-xs text-amber-900/70">
              Two-step operator flow: request_draw transitions the round into the drawing phase
              (also emits an L2-&gt;L1 message as a hook for a real VRF portal); finalize_draw
              reveals the committed seed and derives the winning number deterministically.
            </p>
          </div>

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
