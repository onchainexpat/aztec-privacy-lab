import { useEffect, useState } from 'react'
import {
  getResolvedTestnetClient,
  subscribeTestnetClient,
  type TestnetClient,
} from '../lib/browser-testnet'
import type { SandboxState } from '../lib/sandbox-state'
import { PrivacyLeakage } from './ui/PrivacyLeakage'
import type { LotteryContract } from '../contracts/Lottery'
import { TxResult } from './ui/TxResult'

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

export function LotteryPanelTestnet({ state, onClose }: Props) {
  const [client, setClient] = useState<TestnetClient | null>(getResolvedTestnetClient())
  const [contract, setContract] = useState<LotteryContract | null>(null)
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

  useEffect(() => subscribeTestnetClient(setClient), [])

  // Attach the Lottery contract to the per-tab wallet.
  useEffect(() => {
    if (!client || !cfg) return
    let cancelled = false
    ;(async () => {
      try {
        const [{ jsonParseWithSchema }, { ContractInstanceWithAddressSchema }, mod, { AztecAddress }] =
          await Promise.all([
            import('@aztec/foundation/json-rpc'),
            import('@aztec/stdlib/contract'),
            import('../contracts/Lottery'),
            import('@aztec/aztec.js/addresses'),
          ])
        const inst = jsonParseWithSchema(
          JSON.stringify(cfg.instance),
          ContractInstanceWithAddressSchema,
        )
        await (client.wallet as unknown as {
          registerContract: (i: unknown, a: unknown) => Promise<void>
        }).registerContract(inst, mod.LotteryContractArtifact)
        const c = await mod.LotteryContract.at(AztecAddress.fromStringUnsafe(cfg.address), client.wallet)
        if (!cancelled) setContract(c as unknown as LotteryContract)
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

  async function refreshStatus(c: LotteryContract, cl: TestnetClient) {
    const [phaseR, countR, winningR, winnersR] = await Promise.all([
      c.methods.get_phase().simulate({ from: cl.address }),
      c.methods.get_ticket_count().simulate({ from: cl.address }),
      c.methods.get_winning_number().simulate({ from: cl.address }),
      c.methods.get_winners_count().simulate({ from: cl.address }),
    ])
    setPhase(Number(phaseR.result))
    setTicketCount(Number(countR.result))
    setWinningNumber(Number(winningR.result))
    setWinnersCount(Number(winnersR.result))
  }

  useEffect(() => {
    if (contract && client) {
      void refreshBalance(client)
      void refreshStatus(contract, client)
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [contract, client])

  async function handleBuyTicket() {
    if (!contract || !client) return
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
      // buy_ticket internally calls token0.transfer_to_public(player, lottery,
      // ENTRY_FEE, authwitNonce). On testnet the visitor must authorize that
      // inner transfer explicitly (the embedded wallet won't auto-inject it).
      const authwit = await client.wallet.createAuthWit(client.address, {
        caller: contract.address,
        call: await client.token0.methods
          .transfer_to_public(client.address, contract.address, ENTRY_FEE, authwitNonce)
          .getFunctionCall(),
      })
      await contract.methods
        .buy_ticket(num, salt, authwitNonce)
        .send({ from: client.address, fee: client.feeOpts, authWitnesses: [authwit] })
      setTickets((prev) => [...prev, { number: num, salt: salt.toString(), claimed: false }])
      await refreshStatus(contract, client)
      await refreshBalance(client)
    } catch (e) {
      setError(formatError(e))
    } finally {
      setBusy(false)
    }
  }

  async function handleClaim(t: LocalTicket) {
    if (!contract || !client) return
    setBusy(true)
    setError(null)
    try {
      const { Fr } = await import('@aztec/aztec.js/fields')
      const salt = Fr.fromString(t.salt)
      await contract.methods
        .claim_prize(t.number, salt)
        .send({ from: client.address, fee: client.feeOpts })
      setTickets((prev) => prev.map((p) => (p === t ? { ...p, claimed: true } : p)))
      await refreshStatus(contract, client)
    } catch (e) {
      setError(formatError(e))
    } finally {
      setBusy(false)
    }
  }

  const winningTickets = phase >= PHASE_DRAWN && winningNumber > 0
    ? tickets.filter((t) => t.number === winningNumber)
    : []

  return (
    <section className="mt-10 rounded-2xl border border-black/10 bg-white p-6">
      <div className="flex items-center justify-between">
        <h3 className="text-lg font-semibold">Lottery — variant g7 (testnet)</h3>
        <button onClick={onClose} className="text-sm text-black/50 underline-offset-4 hover:underline">
          Close
        </button>
      </div>
      <p className="mt-2 text-sm text-black/60">
        Live on Aztec testnet. Pick a number 1-{maxNumber}, pay {Number(ENTRY_FEE).toLocaleString()}{' '}
        AZA from your private balance. The operator draws a winning number when the round closes. If
        your number matches, you can prove it — non-winners stay anonymous on chain.
      </p>
      <p className="mt-2 rounded border border-emerald-200 bg-emerald-50 p-2 text-xs text-emerald-900">
        <strong>Privacy property:</strong> ticket = pedersen(player, number, salt). Public state
        is just a counter of ticket commitments. The anonymity set is all ticket holders; only
        winners have incentive to reveal.
      </p>
      <p className="mt-2 rounded border border-amber-200 bg-amber-50 p-2 text-xs text-amber-900">
        <strong>RNG note:</strong> uses operator commit-reveal (seed hash committed at deploy,
        revealed at finalize). The contract also emits an L2-&gt;L1 message at request_draw as an
        architectural hook for a real Chainlink VRF portal.
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
                {busy ? 'Working…' : `Buy ticket · ${Number(ENTRY_FEE).toLocaleString()} AZA`}
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
                          salt {t.salt.slice(0, 10)}…
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

          {/* Operator controls — operator-only on testnet */}
          <div className="mt-4 rounded-xl border border-amber-200 bg-amber-50/40 p-4">
            <p className="text-sm font-medium text-amber-950">Operator controls</p>
            <div className="mt-2 flex flex-wrap items-center gap-3">
              <button
                disabled
                className="rounded-full bg-amber-600 px-3 py-1.5 text-xs font-medium text-white opacity-50"
                title="operator-only — the demo issuer runs the draw"
              >
                Request draw (operator-only)
              </button>
              <button
                disabled
                className="rounded-full bg-amber-600 px-3 py-1.5 text-xs font-medium text-white opacity-50"
                title="operator-only — the demo issuer reveals the seed to finalize"
              >
                Finalize (operator-only)
              </button>
            </div>
            <p className="mt-2 text-[11px] text-amber-900/70">
              request_draw and finalize_draw are operator-only — the demo issuer runs them. As a
              visitor you buy tickets and claim prizes; the draw is triggered by the issuer.
            </p>
          </div>

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
