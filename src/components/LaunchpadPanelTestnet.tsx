import { useEffect, useRef, useState } from 'react'
import {
  getResolvedTestnetClient,
  subscribeTestnetClient,
  type TestnetClient,
} from '../lib/browser-testnet'
import type { SandboxState } from '../lib/sandbox-state'
import { NETWORKS } from '../lib/network'
import { captureProofLog, type ProofEvent } from '../lib/proof-log'
import { useProofTimer } from '../lib/proof-timer'
import { ProofTimer } from './ui/ProofTimer'

interface Props {
  state: SandboxState
  onClose: () => void
}

const DONATE_AMOUNT = 5_000n

export function LaunchpadPanelTestnet({ state, onClose }: Props) {
  const [client, setClient] = useState<TestnetClient | null>(getResolvedTestnetClient())
  const [error, setError] = useState<string | null>(null)
  const [result, setResult] = useState<string | null>(null)
  const [busy, setBusy] = useState(false)
  const [tokenBalance, setTokenBalance] = useState<bigint | null>(null)
  const [sessionContributed, setSessionContributed] = useState<bigint>(0n)
  const [proofLog, setProofLog] = useState<ProofEvent[]>([])
  const logScrollRef = useRef<HTMLDivElement | null>(null)

  const cfg = NETWORKS.testnet
  const crowdfunding = state.crowdfunding
  const proofTimer = useProofTimer(proofLog)

  function pushProofEvent(ev: ProofEvent) {
    setProofLog((prev) => {
      const next = prev.concat(ev)
      return next.length > 100 ? next.slice(next.length - 100) : next
    })
  }
  function pushNote(message: string) {
    pushProofEvent({ ts: Date.now(), kind: 'note', source: 'dashboard', message })
  }

  useEffect(() => {
    const el = logScrollRef.current
    if (el) el.scrollTop = el.scrollHeight
  }, [proofLog])

  useEffect(() => subscribeTestnetClient(setClient), [])

  useEffect(() => {
    if (!client) return
    void refreshBalance(client)
  }, [client])

  async function refreshBalance(c: TestnetClient) {
    try {
      const { result: bal } = await c.token0.methods
        .balance_of_private(c.address)
        .simulate({ from: c.address })
      setTokenBalance(bal as bigint)
    } catch {
      // transient
    }
  }

  async function donate() {
    if (!client?.crowdfunding) return
    setBusy(true)
    setError(null)
    setResult(null)
    pushNote(`donate(${DONATE_AMOUNT}) — proving private call…`)
    const stopCapture = captureProofLog(pushProofEvent)
    try {
      // Bundled Crowdfunding contract takes only the amount; the EmbeddedWallet
      // resolves nested authwits for the inner transfer automatically.
      await client.crowdfunding.methods
        .donate(DONATE_AMOUNT)
        .send({ from: client.address, fee: client.feeOpts })
      setSessionContributed((n) => n + DONATE_AMOUNT)
      setResult(
        `Donated ${fmt(DONATE_AMOUNT)} ${state.token0.symbol}. The contract received a private ` +
          `note from your account — the donor address and amount stay encrypted; only the ` +
          `operator can decrypt and sum the notes at withdrawal time. Observers see a Crowdfunding ` +
          `tx, nothing else.`,
      )
      await refreshBalance(client)
    } catch (e) {
      setError(formatError(e))
    } finally {
      stopCapture()
      setBusy(false)
    }
  }

  const deadlineDate = crowdfunding ? new Date(Number(crowdfunding.deadline) * 1000) : null

  return (
    <section className="mt-10 rounded-2xl border border-black/10 bg-white p-6">
      <div className="flex items-center justify-between">
        <h3 className="text-lg font-semibold">Launchpad — fully private raise (variant lp1) on testnet</h3>
        <button onClick={onClose} className="text-sm text-black/50 underline-offset-4 hover:underline">
          Close
        </button>
      </div>

      <p className="mt-2 text-sm text-black/60">
        Bundled <code className="font-mono text-xs">Crowdfunding</code> contract on Aztec Alpha v4
        testnet. Donations move private notes from the donor to the operator — donor identity,
        amount, and running total all stay encrypted. Only the operator can decrypt and sum the
        notes at withdrawal.
      </p>

      {crowdfunding && (
        <dl className="mt-3 grid grid-cols-1 gap-x-6 gap-y-1 text-xs md:grid-cols-2">
          <dt className="text-black/40">Contract address</dt>
          <dd className="font-mono">
            <a
              href={`${cfg.explorerUrl}/contracts/${crowdfunding.address}`}
              target="_blank"
              rel="noreferrer"
              className="underline-offset-4 hover:underline"
            >
              {crowdfunding.address.slice(0, 16)}… ↗
            </a>
          </dd>
          <dt className="text-black/40">Donation token</dt>
          <dd className="font-mono">{crowdfunding.donationToken}</dd>
          <dt className="text-black/40">Operator</dt>
          <dd className="font-mono">{shortAddr(crowdfunding.operator)}</dd>
          {deadlineDate && (
            <>
              <dt className="text-black/40">Deadline</dt>
              <dd className="font-mono">{deadlineDate.toLocaleString()}</dd>
            </>
          )}
        </dl>
      )}

      {!client ? (
        <div className="mt-4 rounded-xl border border-amber-200 bg-amber-50/60 p-4 text-sm text-amber-900">
          <p className="font-medium">Wallet not initialized yet</p>
          <p className="mt-1 text-amber-900/80">
            Scroll up to <strong>Your testnet wallet</strong> and click{' '}
            <strong>Initialize wallet</strong>. This panel will sync automatically once your
            per-tab account is deployed.
          </p>
        </div>
      ) : !crowdfunding ? (
        <div className="mt-4 rounded-xl border border-amber-200 bg-amber-50/60 p-4 text-sm text-amber-900">
          <p className="font-medium">Crowdfunding contract not deployed on testnet yet</p>
          <p className="mt-1 text-amber-900/80">
            Run <code className="font-mono text-xs">npm run testnet:deploy-launchpad</code> to
            deploy it.
          </p>
        </div>
      ) : (
        <>
          <div className="mt-5 rounded-xl border border-sky-200 bg-sky-50/50 p-4 text-sm">
            <div className="flex flex-wrap items-center gap-x-6 gap-y-2">
              <div>
                <p className="text-xs uppercase tracking-wide text-sky-900/60">
                  your testnet account
                </p>
                <p className="mt-0.5 font-mono text-sky-950">{shortAddr(client.address.toString())}</p>
              </div>
              {cfg.explorerUrl && (
                <a
                  href={`${cfg.explorerUrl}/contracts/${client.address.toString()}`}
                  target="_blank"
                  rel="noreferrer"
                  className="text-xs text-sky-700 underline-offset-4 hover:underline"
                >
                  Aztecscan ↗
                </a>
              )}
            </div>
          </div>

          <div className="mt-4 grid grid-cols-1 gap-3 md:grid-cols-2">
            <Field
              label={`your private ${state.token0.symbol}`}
              tone="private"
              value={tokenBalance === null ? '—' : `${fmt(tokenBalance)} ${state.token0.symbol}`}
            />
            <Field
              label="contributed this session"
              tone="private"
              value={`${fmt(sessionContributed)} ${state.token0.symbol}`}
            />
          </div>

          <ProofTimer state={proofTimer} label={proofTimer.proving ? 'donate' : 'last donate'} />

          <div className="mt-4 flex flex-wrap items-center gap-3">
            <button
              onClick={donate}
              disabled={busy || tokenBalance === null || tokenBalance < DONATE_AMOUNT}
              className="rounded-full bg-violet-600 px-4 py-2 text-sm font-medium text-white hover:opacity-90 disabled:opacity-50"
            >
              Donate {fmt(DONATE_AMOUNT)} {state.token0.symbol} (private)
            </button>
            {tokenBalance !== null && tokenBalance < DONATE_AMOUNT && (
              <span className="text-xs text-amber-700">
                Need {fmt(DONATE_AMOUNT)} {state.token0.symbol} — request more via the faucet.
              </span>
            )}
            {tokenBalance === null && (
              <span className="text-xs text-black/50">Syncing balance…</span>
            )}
          </div>

          <p className="mt-3 text-xs text-black/50">
            What an observer sees: a tx against the Crowdfunding address. They don't see the
            donor, the donation amount, or the running total. Only the operator's keys can decrypt
            the notes the contract holds.
          </p>
        </>
      )}

      {proofLog.length > 0 && (
        <details className="mt-4" open>
          <summary className="cursor-pointer text-xs text-black/60 hover:underline">
            proof log ({proofLog.length} events)
          </summary>
          <div
            ref={logScrollRef}
            className="mt-2 max-h-56 overflow-auto rounded-lg border border-black/10 bg-zinc-950 p-3 font-mono text-[11px] leading-relaxed text-zinc-100"
          >
            {proofLog.map((ev, i) => (
              <div key={i} className="flex gap-3">
                <span className="shrink-0 text-zinc-500">
                  {new Date(ev.ts).toLocaleTimeString('en-US', { hour12: false })}
                </span>
                <span
                  className={`shrink-0 ${ev.kind === 'note' ? 'text-amber-300' : 'text-sky-300'}`}
                >
                  {ev.source}
                </span>
                <span className="text-zinc-100">{ev.message}</span>
              </div>
            ))}
          </div>
        </details>
      )}

      {result && (
        <p className="mt-3 rounded-lg border border-emerald-200 bg-emerald-50 p-2 text-xs text-emerald-900">
          {result}
        </p>
      )}
      {error && (
        <pre className="mt-3 max-h-48 overflow-auto rounded-lg border border-rose-200 bg-rose-50 p-3 text-xs text-rose-900">
{error}
        </pre>
      )}
    </section>
  )
}

function Field({
  label,
  tone,
  value,
}: {
  label: string
  tone: 'public' | 'private'
  value: string
}) {
  const dot = tone === 'private' ? 'bg-violet-500' : 'bg-sky-500'
  return (
    <div className="rounded-xl border border-black/10 bg-zinc-50 p-3">
      <p className="flex items-center gap-1.5 text-xs uppercase tracking-wide text-black/40">
        <span className={`size-1.5 rounded-full ${dot}`} />
        {label}
      </p>
      <p className="mt-0.5 font-mono">{value}</p>
    </div>
  )
}

function shortAddr(a: string): string {
  return `${a.slice(0, 10)}…${a.slice(-6)}`
}

function fmt(n: bigint): string {
  return Number(n).toLocaleString('en-US')
}

function formatError(e: unknown): string {
  if (e instanceof Error) return `${e.name}: ${e.message}`
  return String(e)
}
