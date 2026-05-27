import { useEffect, useState } from 'react'
import { initBrowserSandbox, type BrowserSandbox } from '../lib/browser-sandbox'
import type { SandboxState } from '../lib/sandbox-state'
import { buildEligibleTree } from '../lib/voting-merkle'
import { PrivacyLeakage } from './ui/PrivacyLeakage'

interface Props {
  state: SandboxState
  onClose: () => void
}

// poseidon2([secret, "VOTE"]) — must match NULLIFIER_DOMAIN in the contract.
const NULLIFIER_DOMAIN = 0x564f5445n

export function AnonymousVotingPanel({ state, onClose }: Props) {
  const [sandbox, setSandbox] = useState<BrowserSandbox | null>(null)
  const [progress, setProgress] = useState<string | null>(null)
  const [error, setError] = useState<string | null>(null)
  const [busy, setBusy] = useState(false)
  const [tallies, setTallies] = useState<number[]>([])
  const [total, setTotal] = useState<number>(0)
  const [voted, setVoted] = useState<boolean>(false)

  const cfg = state.anonymousVoting
  const candidates = cfg?.candidates ?? []
  // Demo: vote as the holder of the first eligible credential (index 0).
  const voterIdx = 0

  async function refresh(sb: BrowserSandbox) {
    if (!sb.anonymousVoting || !cfg) return
    const { Fr } = await import('@aztec/aztec.js/fields')
    const { poseidon2Hash } = await import('@aztec/foundation/crypto/sync')
    const counts = await Promise.all(
      candidates.map(async (_, i) =>
        Number((await sb.anonymousVoting!.methods.get_tally(BigInt(i)).simulate({ from: sb.admin })).result),
      ),
    )
    setTallies(counts)
    const tv = await sb.anonymousVoting.methods.get_total_votes().simulate({ from: sb.admin })
    setTotal(Number(tv.result))
    // Has the demo voter's credential already voted? (nullifier = poseidon2([secret, DOMAIN]))
    const secret = cfg.eligibleSecrets[voterIdx]
    const nullifier = poseidon2Hash([Fr.fromString(secret), new Fr(NULLIFIER_DOMAIN)])
    const v = await sb.anonymousVoting.methods.is_voted(nullifier.toBigInt()).simulate({ from: sb.admin })
    setVoted(Boolean(v.result))
  }

  async function handleInit() {
    setError(null)
    setBusy(true)
    try {
      const sb = await initBrowserSandbox(state, setProgress)
      if (!sb.anonymousVoting) throw new Error('AnonymousVoting not deployed - re-run sandbox:setup')
      setSandbox(sb)
      await refresh(sb)
    } catch (e) {
      setError(formatError(e))
    } finally {
      setBusy(false)
    }
  }

  async function vote(candidate: number) {
    if (!sandbox?.anonymousVoting || !cfg) return
    setBusy(true)
    setError(null)
    try {
      const { Fr } = await import('@aztec/aztec.js/fields')
      // Prove eligibility: rebuild the eligible tree, take this voter's proof.
      const { proofs } = buildEligibleTree(cfg.eligibleSecrets)
      const p = proofs[voterIdx]
      const path = p.siblingPath.map((s) => Fr.fromString(s))
      await sandbox.anonymousVoting.methods
        .vote(Fr.fromString(p.secret), new Fr(BigInt(p.leafIndex)), path, BigInt(candidate))
        .send({ from: sandbox.admin })
      await refresh(sandbox)
    } catch (e) {
      setError(formatError(e))
    } finally {
      setBusy(false)
    }
  }

  useEffect(() => {
    if (sandbox) void refresh(sandbox)
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [sandbox])

  return (
    <section className="mt-10 rounded-2xl border border-black/10 bg-white p-6">
      <div className="flex items-center justify-between">
        <h3 className="text-lg font-semibold">Anonymous voting — eligibility-gated</h3>
        <button onClick={onClose} className="text-sm text-black/50 underline-offset-4 hover:underline">
          Close
        </button>
      </div>
      <p className="mt-2 text-sm text-black/60">
        Only holders of an eligibility credential can vote — the same credential commitments issued
        by the identity-attestation primitive. You prove your credential is in the eligible set with
        an <strong>in-circuit Merkle inclusion proof</strong> (without revealing which member you
        are), and a per-credential nullifier stops you voting twice. The vote runs privately; only
        the public tally ticks up.
      </p>
      <p className="mt-2 rounded border border-emerald-200 bg-emerald-50 p-2 text-xs text-emerald-900">
        <strong>Privacy:</strong> sybil-resistant (one vote per credential) AND anonymous within the
        whole eligible set — observers learn "an eligible voter chose X," not who, and not which
        credential.
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
          <p className="mt-4 text-sm font-medium">
            Proposal — total votes cast: <span className="font-mono">{total}</span>
            {voted && <span className="ml-2 text-xs text-emerald-700">· your credential has voted</span>}
          </p>
          <div className="mt-3 space-y-2">
            {candidates.map((name, i) => (
              <div
                key={i}
                className="flex items-center justify-between gap-3 rounded-xl border border-black/10 bg-zinc-50 p-3"
              >
                <div>
                  <p className="text-sm font-medium">{name}</p>
                  <p className="font-mono text-xs text-black/50">{tallies[i] ?? 0} votes</p>
                </div>
                <button
                  onClick={() => vote(i)}
                  disabled={busy || voted}
                  className="rounded-full bg-violet-600 px-4 py-1.5 text-sm font-medium text-white hover:opacity-90 disabled:opacity-40"
                >
                  {busy ? 'Proving…' : `Vote`}
                </button>
              </div>
            ))}
          </div>
          <PrivacyLeakage
            className="mt-4"
            publicLeaks={['tally increment for chosen option', 'opaque vote nullifier']}
            staysPrivate={[
              'voter identity (private kernel)',
              'which eligible credential voted (Merkle proof hides the leaf)',
            ]}
          />
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
