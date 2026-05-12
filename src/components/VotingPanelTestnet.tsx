import { useEffect, useRef, useState } from 'react'
import { initTestnetClient, type TestnetClient } from '../lib/browser-testnet'
import type { SandboxState } from '../lib/sandbox-state'
import { NETWORKS } from '../lib/network'
import { captureProofLog, type ProofEvent } from '../lib/proof-log'
import type { ConnectedAccount } from '../lib/wallet'

interface Props {
  state: SandboxState
  azguardAccount: ConnectedAccount | null
  onClose: () => void
}

export function VotingPanelTestnet({ state, azguardAccount, onClose }: Props) {
  const [progress, setProgress] = useState<string | null>(null)
  const [client, setClient] = useState<TestnetClient | null>(null)
  const [error, setError] = useState<string | null>(null)
  const [result, setResult] = useState<string | null>(null)
  const [busy, setBusy] = useState(false)
  const [yesCount, setYesCount] = useState<bigint | null>(null)
  const [noCount, setNoCount] = useState<bigint | null>(null)
  const [proofLog, setProofLog] = useState<ProofEvent[]>([])
  const logScrollRef = useRef<HTMLDivElement | null>(null)

  const cfg = NETWORKS.testnet
  const voting = state.voting
  const electionIdStr = voting?.electionId ?? '1'

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

  useEffect(() => {
    if (!client) return
    void refreshTallies(client)
  }, [client])

  async function refreshTallies(c: TestnetClient) {
    if (!c.voting) return
    try {
      const electionId = { id: BigInt(electionIdStr) }
      const [yesRes, noRes] = await Promise.all([
        c.voting.methods.get_tally(electionId, 1n).simulate({ from: c.address }),
        c.voting.methods.get_tally(electionId, 0n).simulate({ from: c.address }),
      ])
      setYesCount(yesRes.result as bigint)
      setNoCount(noRes.result as bigint)
    } catch {
      // transient
    }
  }

  async function handleInit() {
    setError(null)
    setBusy(true)
    setProofLog([])
    const stopCapture = captureProofLog(pushProofEvent)
    try {
      const c = await initTestnetClient(state, (msg) => {
        setProgress(msg)
        pushNote(msg)
      })
      if (!c.voting) throw new Error('PrivateVoting not in testnet-state.json')
      setClient(c)
      if (c.freshAccount) {
        setResult(
          `Account deployed at ${shortAddr(c.address.toString())}. Saved to localStorage for next visit.`,
        )
      }
    } catch (e) {
      setError(formatError(e))
    } finally {
      stopCapture()
      setBusy(false)
    }
  }

  async function cast(choice: 'YES' | 'NO') {
    if (!client?.voting) return
    setBusy(true)
    setError(null)
    setResult(null)
    pushNote(`cast_vote(${choice}) — proving private call…`)
    const stopCapture = captureProofLog(pushProofEvent)
    try {
      const electionId = { id: BigInt(electionIdStr) }
      const choiceNum = choice === 'YES' ? 1n : 0n
      await client.voting.methods
        .cast_vote(electionId, choiceNum)
        .send({ from: client.address, fee: client.feeOpts })
      setResult(
        `Vote cast (${choice}). The contract emitted a per-(election, voter) nullifier — ` +
          `a second vote from the same account on this election will revert at the protocol ` +
          `level (duplicate siloed nullifier). The public tally bumped by 1 but no observer ` +
          `can tell which option you picked or that it was your address.`,
      )
      await refreshTallies(client)
    } catch (e) {
      setError(formatError(e))
    } finally {
      stopCapture()
      setBusy(false)
    }
  }

  return (
    <section className="mt-10 rounded-2xl border border-black/10 bg-white p-6">
      <div className="flex items-center justify-between">
        <h3 className="text-lg font-semibold">Anonymous voting on testnet</h3>
        <button onClick={onClose} className="text-sm text-black/50 underline-offset-4 hover:underline">
          Close
        </button>
      </div>

      <p className="mt-2 text-sm text-black/60">
        Bundled <code className="font-mono text-xs">PrivateVoting</code> contract on Aztec
        Alpha v4 testnet. Each address gets at most one vote per election — enforced by a
        nullifier keyed on (election_id, voter), emitted from a private function.
        Observers see the tally tick up; they cannot link a vote to a wallet.
      </p>

      <AccountModeBanner azguardAccount={azguardAccount} />

      {voting && (
        <dl className="mt-3 grid grid-cols-1 gap-x-6 gap-y-1 text-xs md:grid-cols-2">
          <dt className="text-black/40">Contract address</dt>
          <dd className="font-mono">
            <a
              href={`${cfg.explorerUrl}/contracts/${voting.address}`}
              target="_blank"
              rel="noreferrer"
              className="underline-offset-4 hover:underline"
            >
              {voting.address.slice(0, 16)}… ↗
            </a>
          </dd>
          <dt className="text-black/40">Election ID</dt>
          <dd className="font-mono">{electionIdStr}</dd>
        </dl>
      )}

      {!client ? (
        <div className="mt-5">
          <button
            onClick={handleInit}
            disabled={busy}
            className="rounded-full bg-[var(--color-ink)] px-4 py-2 text-sm font-medium text-[var(--color-paper)] hover:opacity-90 disabled:opacity-50"
          >
            {busy ? 'Initializing…' : 'Initialize browser PXE + account on testnet'}
          </button>
          {progress && busy && <p className="mt-2 text-xs text-black/50">{progress}</p>}
          <p className="mt-3 max-w-prose text-xs text-black/50">
            Same per-tab account flow as the lending demo. First click is the slow one
            (~1-2 min for the account-deploy IVC proof). Subsequent clicks just sync.
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

          <div className="mt-4 grid grid-cols-2 gap-3">
            <Tally label="YES" count={yesCount} accent="emerald" />
            <Tally label="NO" count={noCount} accent="rose" />
          </div>

          <div className="mt-4 flex flex-wrap items-center gap-3">
            <button
              onClick={() => cast('YES')}
              disabled={busy}
              className="rounded-full bg-emerald-600 px-4 py-2 text-sm font-medium text-white hover:opacity-90 disabled:opacity-50"
            >
              Vote YES (private)
            </button>
            <button
              onClick={() => cast('NO')}
              disabled={busy}
              className="rounded-full bg-rose-600 px-4 py-2 text-sm font-medium text-white hover:opacity-90 disabled:opacity-50"
            >
              Vote NO (private)
            </button>
            {busy && progress && <span className="text-xs text-black/50">{progress}</span>}
          </div>

          <p className="mt-3 text-xs text-black/50">
            Try voting twice — the second attempt fails with{' '}
            <code className="font-mono">duplicate siloed nullifier</code> at the protocol level.
            Each visitor's per-tab account gets exactly one vote on this election.
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

function AccountModeBanner({ azguardAccount }: { azguardAccount: ConnectedAccount | null }) {
  if (!azguardAccount) {
    return (
      <div className="mt-3 rounded-xl border border-zinc-200 bg-zinc-50 p-3 text-xs text-zinc-700">
        <p className="font-medium text-zinc-900">Demo mode — no wallet connected</p>
        <p className="mt-1">
          This panel uses a per-tab Schnorr account. Same one as the ld2 lending demo — if
          you've initialized it there, you can reuse it here. Connect Azguard from the
          header for your real wallet (informational for now; full routing in progress).
        </p>
      </div>
    )
  }
  return (
    <div className="mt-3 rounded-xl border border-sky-200 bg-sky-50/60 p-3 text-xs text-sky-900">
      <p className="font-medium">Azguard connected · {shortAddr(azguardAccount.address)}</p>
      <p className="mt-1 text-sky-900/80">
        Per-tab account still used for tx submission. Azguard routing is the next piece.
      </p>
    </div>
  )
}

function Tally({
  label,
  count,
  accent,
}: {
  label: string
  count: bigint | null
  accent: 'emerald' | 'rose'
}) {
  const cls =
    accent === 'emerald'
      ? 'border-emerald-200 bg-emerald-50 text-emerald-900'
      : 'border-rose-200 bg-rose-50 text-rose-900'
  return (
    <div className={`rounded-xl border p-3 ${cls}`}>
      <p className="text-xs uppercase tracking-wide opacity-60">{label}</p>
      <p className="mt-1 font-mono text-2xl">{count === null ? '—' : count.toString()}</p>
      <p className="mt-1 text-[11px] opacity-70">
        public tally — observers see the count, not who voted
      </p>
    </div>
  )
}

function shortAddr(a: string): string {
  return `${a.slice(0, 10)}…${a.slice(-6)}`
}

function formatError(e: unknown): string {
  if (e instanceof Error) return `${e.name}: ${e.message}`
  return String(e)
}
