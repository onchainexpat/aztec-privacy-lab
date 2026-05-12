import { useState } from 'react'
import { initBrowserSandbox, type BrowserSandbox } from '../lib/browser-sandbox'
import type { SandboxState } from '../lib/sandbox-state'

interface Props {
  state: SandboxState
  onClose: () => void
}

export function VotingPanel({ state, onClose }: Props) {
  const [progress, setProgress] = useState<string | null>(null)
  const [sandbox, setSandbox] = useState<BrowserSandbox | null>(null)
  const [error, setError] = useState<string | null>(null)
  const [result, setResult] = useState<string | null>(null)
  const [yesCount, setYesCount] = useState<bigint | null>(null)
  const [noCount, setNoCount] = useState<bigint | null>(null)
  const [busy, setBusy] = useState(false)

  const electionIdStr = state.voting?.electionId ?? '1'

  async function refresh(sb: BrowserSandbox) {
    if (!sb.voting) return
    const electionId = { id: BigInt(electionIdStr) }
    const [yesRes, noRes] = await Promise.all([
      sb.voting.methods.get_tally(electionId, 1n).simulate({ from: sb.admin }),
      sb.voting.methods.get_tally(electionId, 0n).simulate({ from: sb.admin }),
    ])
    setYesCount(yesRes.result as bigint)
    setNoCount(noRes.result as bigint)
  }

  async function handleInit() {
    setError(null)
    setBusy(true)
    try {
      const sb = await initBrowserSandbox(state, setProgress)
      if (!sb.voting) throw new Error('PrivateVoting not deployed — re-run sandbox:setup')
      setSandbox(sb)
      await refresh(sb)
    } catch (e) {
      setError(formatError(e))
    } finally {
      setBusy(false)
    }
  }

  async function cast(choice: 0n | 1n) {
    if (!sandbox?.voting) return
    setBusy(true)
    setError(null)
    setResult(null)
    try {
      const electionId = { id: BigInt(electionIdStr) }
      await sandbox.voting.methods
        .cast_vote(electionId, choice)
        .send({ from: sandbox.admin })
      setResult(`vote cast (${choice === 1n ? 'YES' : 'NO'}). The contract used a single-use claim keyed by your address — a second vote will revert.`)
      await refresh(sandbox)
    } catch (e) {
      setError(formatError(e))
    } finally {
      setBusy(false)
    }
  }

  return (
    <section className="mt-10 rounded-2xl border border-black/10 bg-white p-6">
      <div className="flex items-center justify-between">
        <h3 className="text-lg font-semibold">Anonymous voting — bundled PrivateVoting</h3>
        <button onClick={onClose} className="text-sm text-black/50 underline-offset-4 hover:underline">
          Close
        </button>
      </div>

      <p className="mt-2 text-sm text-black/60">
        The bundled <code className="font-mono text-xs">PrivateVoting</code> contract enforces
        one vote per address using a per-(election, voter) <code className="font-mono text-xs">SingleUseClaim</code>{' '}
        — under the hood that's a Noir nullifier emitted from a private function. Observers see
        the tally tick up by one; they cannot tell which address voted for which candidate
        without the voter's secret. Try voting twice — the second attempt reverts.
      </p>

      {state.voting && (
        <dl className="mt-3 grid grid-cols-1 gap-x-6 gap-y-1 text-xs md:grid-cols-2">
          <dt className="text-black/40">PrivateVoting</dt>
          <dd className="font-mono">{state.voting.address.slice(0, 18)}…</dd>
          <dt className="text-black/40">Election id</dt>
          <dd className="font-mono">{state.voting.electionId}</dd>
        </dl>
      )}

      {!sandbox ? (
        <div className="mt-4">
          <button
            onClick={handleInit}
            disabled={busy}
            className="rounded-full bg-[var(--color-ink)] px-4 py-2 text-sm font-medium text-[var(--color-paper)] hover:opacity-90 disabled:opacity-50"
          >
            {busy ? 'Initializing…' : 'Initialize browser PXE'}
          </button>
          {progress && busy && <p className="mt-2 text-xs text-black/50">{progress}</p>}
        </div>
      ) : (
        <>
          <div className="mt-4 flex items-center gap-3">
            <button
              onClick={() => cast(1n)}
              disabled={busy}
              className="rounded-full bg-emerald-600 px-4 py-2 text-sm font-medium text-white hover:opacity-90 disabled:opacity-50"
            >
              Vote YES (candidate 1)
            </button>
            <button
              onClick={() => cast(0n)}
              disabled={busy}
              className="rounded-full bg-rose-600 px-4 py-2 text-sm font-medium text-white hover:opacity-90 disabled:opacity-50"
            >
              Vote NO (candidate 0)
            </button>
            <span className="text-xs text-emerald-700">
              PXE ready · admin {sandbox.admin.toString().slice(0, 8)}…
            </span>
          </div>

          <div className="mt-4 grid grid-cols-2 gap-4 rounded-xl border border-black/10 bg-zinc-50 p-3 text-sm">
            <div>
              <p className="flex items-center gap-1.5 text-xs uppercase tracking-wide text-black/40">
                <span className="size-1.5 rounded-full bg-sky-500" />
                public yes tally
              </p>
              <p className="mt-0.5 font-mono">{yesCount === null ? '—' : yesCount.toString()}</p>
            </div>
            <div>
              <p className="flex items-center gap-1.5 text-xs uppercase tracking-wide text-black/40">
                <span className="size-1.5 rounded-full bg-sky-500" />
                public no tally
              </p>
              <p className="mt-0.5 font-mono">{noCount === null ? '—' : noCount.toString()}</p>
            </div>
          </div>
        </>
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

function formatError(e: unknown): string {
  if (e instanceof Error) return `${e.name}: ${e.message}`
  return String(e)
}
