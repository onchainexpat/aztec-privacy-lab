import { useEffect, useMemo, useState } from 'react'
import { initBrowserSandbox, type BrowserSandbox } from '../lib/browser-sandbox'
import type { SandboxState } from '../lib/sandbox-state'
import { buildRewardsTree, type RewardProof } from '../lib/rewards-merkle'
import { PrivacyLeakage } from './ui/PrivacyLeakage'

interface Props {
  state: SandboxState
  onClose: () => void
}

export function RewardsPanel({ state, onClose }: Props) {
  const [sandbox, setSandbox] = useState<BrowserSandbox | null>(null)
  const [progress, setProgress] = useState<string | null>(null)
  const [error, setError] = useState<string | null>(null)
  const [busy, setBusy] = useState(false)

  const [pubAza, setPubAza] = useState<bigint | null>(null)
  const [privAza, setPrivAza] = useState<bigint | null>(null)
  const [totalClaimed, setTotalClaimed] = useState<number>(0)
  const [poolBal, setPoolBal] = useState<bigint>(0n)
  const [claimedLeaf, setClaimedLeaf] = useState<boolean>(false)

  const cfg = state.rewards
  const period = cfg ? BigInt(cfg.period) : 0n

  // Rebuild the tree client-side from the published leaves and find THIS
  // account's proof (entry matching the connected address).
  const myProof: RewardProof | null = useMemo(() => {
    if (!cfg || !sandbox) return null
    const me = sandbox.admin.toString()
    const idx = cfg.entries.findIndex((e) => e.address === me)
    if (idx < 0) return null
    const { proofs } = buildRewardsTree(cfg.entries, period)
    return proofs[idx]
  }, [cfg, sandbox, period])

  async function refresh(sb: BrowserSandbox, proof: RewardProof | null) {
    if (!sb.rewards) return
    const { Fr } = await import('@aztec/aztec.js/fields')
    const [tc, pub, priv, pool] = await Promise.all([
      sb.rewards.methods.get_total_claimed().simulate({ from: sb.admin }),
      sb.token0.methods.balance_of_public(sb.admin).simulate({ from: sb.admin }),
      sb.token0.methods.balance_of_private(sb.admin).simulate({ from: sb.admin }),
      sb.token0.methods.balance_of_public(sb.rewards.address).simulate({ from: sb.admin }),
    ])
    setTotalClaimed(Number(tc.result))
    setPubAza(pub.result as bigint)
    setPrivAza(priv.result as bigint)
    setPoolBal(pool.result as bigint)
    if (proof) {
      const c = await sb.rewards.methods
        .is_claimed(Fr.fromString(proof.leaf))
        .simulate({ from: sb.admin })
      setClaimedLeaf(Boolean(c.result))
    }
  }

  async function handleInit() {
    setError(null)
    setBusy(true)
    try {
      const sb = await initBrowserSandbox(state, setProgress)
      if (!sb.rewards) throw new Error('Rewards not deployed - re-run sandbox:setup')
      setSandbox(sb)
    } catch (e) {
      setError(formatError(e))
    } finally {
      setBusy(false)
    }
  }

  async function claim(mode: 'public' | 'private') {
    if (!sandbox?.rewards || !myProof) return
    setBusy(true)
    setError(null)
    try {
      const { Fr } = await import('@aztec/aztec.js/fields')
      const path = myProof.siblingPath.map((s) => Fr.fromString(s))
      const args = [
        BigInt(myProof.amount),
        period,
        new Fr(BigInt(myProof.leafIndex)),
        path,
        sandbox.admin,
      ] as const
      if (mode === 'public') {
        await sandbox.rewards.methods.claim_public(...args).send({ from: sandbox.admin })
      } else {
        await sandbox.rewards.methods.claim_private(...args).send({ from: sandbox.admin })
      }
      await refresh(sandbox, myProof)
    } catch (e) {
      setError(formatError(e))
    } finally {
      setBusy(false)
    }
  }

  useEffect(() => {
    if (sandbox) void refresh(sandbox, myProof)
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [sandbox, myProof])

  return (
    <section className="mt-10 rounded-2xl border border-black/10 bg-white p-6">
      <div className="flex items-center justify-between">
        <h3 className="text-lg font-semibold">Private rewards (Merkl-style)</h3>
        <button onClick={onClose} className="text-sm text-black/50 underline-offset-4 hover:underline">
          Close
        </button>
      </div>
      <p className="mt-2 text-sm text-black/60">
        An app funds a pool and publishes a single Merkle root over (recipient, amount) entitlements.
        You claim by proving inclusion privately — the contract recomputes your leaf from your
        hidden address + claimed amount + period and checks it hashes up to the published root. One
        root commits to the whole campaign; your eligible identity never leaves the private kernel.
      </p>
      <p className="mt-2 rounded border border-emerald-200 bg-emerald-50 p-2 text-xs text-emerald-900">
        <strong>Two payout modes:</strong> <em>public</em> pays to a visible recipient (amount +
        recipient public); <em>private-recipient</em> pays into a partial note so the recipient is
        hidden (amount still public — see the honest boundary below). Both hide which eligible
        member is claiming.
      </p>
      <p className="mt-2 rounded border border-amber-200 bg-amber-50 p-2 text-xs text-amber-900">
        <strong>Honest boundary:</strong> the pool is custodied in public balance, so every release
        moves a visible <em>amount</em> out of public state. Hiding the payout amount would need
        contract-owned private notes / supply-hiding (research-grade, variant r4).
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
          <div className="mt-4 grid grid-cols-2 gap-3 md:grid-cols-4">
            <Stat label="pool balance" value={`${Number(poolBal).toLocaleString()} AZA`} />
            <Stat label="claims paid" value={String(totalClaimed)} />
            <Stat label="campaign period" value={String(period)} />
            <Stat label="your leaves" value={myProof ? '1 eligible' : 'none'} />
          </div>
          <div className="mt-3 grid grid-cols-2 gap-3">
            <Stat label="your public AZA" value={pubAza === null ? '-' : Number(pubAza).toLocaleString()} />
            <Stat label="your private AZA" value={privAza === null ? '-' : Number(privAza).toLocaleString()} />
          </div>

          <div className="mt-5 rounded-xl border border-black/10 p-4">
            {myProof ? (
              <>
                <p className="text-sm font-medium">
                  You are eligible for {Number(myProof.amount).toLocaleString()} AZA (leaf #
                  {myProof.leafIndex}, period {String(period)})
                  <span
                    className={`ml-2 rounded-full px-2 py-0.5 text-[10px] ${
                      claimedLeaf ? 'bg-zinc-200 text-zinc-700' : 'bg-emerald-100 text-emerald-900'
                    }`}
                  >
                    {claimedLeaf ? 'claimed' : 'claimable'}
                  </span>
                </p>
                <p className="mt-1 text-xs text-black/50">
                  Proof rebuilt in your browser from the published leaves ({cfg!.entries.length}-leaf
                  tree). The other leaves are the anonymity set.
                </p>
                <div className="mt-3 flex flex-wrap gap-3">
                  <button
                    onClick={() => claim('public')}
                    disabled={busy || claimedLeaf}
                    className="rounded-full bg-violet-600 px-4 py-2 text-sm font-medium text-white hover:opacity-90 disabled:opacity-40"
                  >
                    {busy ? 'Working…' : 'Claim → public payout'}
                  </button>
                  <button
                    onClick={() => claim('private')}
                    disabled={busy || claimedLeaf}
                    className="rounded-full border border-violet-600 bg-violet-50 px-4 py-2 text-sm font-medium text-violet-700 hover:bg-violet-100 disabled:opacity-40"
                  >
                    {busy ? 'Working…' : 'Claim → private-recipient payout'}
                  </button>
                </div>
              </>
            ) : (
              <p className="text-sm text-black/60">
                The connected account isn&apos;t in this campaign&apos;s tree, so there&apos;s
                nothing to claim. (In the sandbox the demo account is entry 0.)
              </p>
            )}
            <PrivacyLeakage
              className="mt-3"
              publicLeaks={['payout amount', 'claims-paid counter +1', 'consumed leaf']}
              staysPrivate={[
                'which eligible member claimed (private kernel)',
                'recipient address (private-recipient mode)',
              ]}
            />
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

function Stat({ label, value }: { label: string; value: string }) {
  return (
    <div className="rounded-xl border border-black/10 bg-zinc-50 p-3 text-xs">
      <p className="text-[10px] uppercase tracking-wide text-black/40">{label}</p>
      <p className="mt-1 font-mono text-sm">{value}</p>
    </div>
  )
}

function formatError(e: unknown): string {
  if (e instanceof Error) return `${e.name}: ${e.message}`
  return String(e)
}
