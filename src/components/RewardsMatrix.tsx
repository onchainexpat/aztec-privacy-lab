import { REWARDS_VARIATIONS } from '../data/rewards'
import { MatrixHeader } from './ui/MatrixHeader'
import { VerdictBadge } from './ui/VerdictBadge'
import { AxisPill } from './ui/AxisPill'

interface Props {
  onTry?: () => void
}

// Matrix for the Merkl-style private rewards primitive. r1-r3 are the deployed
// Rewards contract (one contract: claim_public, claim_private, + a period),
// the way the AMM covers a/f with one pool. r4/r5 are explainer-only.
export function RewardsMatrix({ onTry }: Props) {
  return (
    <section className="mt-16">
      <MatrixHeader
        title="Private rewards distribution (Merkl-style) — privacy matrix"
        subtitle="An app funds a pool and publishes one Merkle root over (recipient, amount) entitlements; users claim by proving inclusion privately. New ZK surface area vs the rest of the board: an in-circuit Merkle inclusion proof + a private-recipient payout. r1-r3 ship today on one contract; r4-r5 are explainers."
      />
      {onTry && (
        <div className="mb-4">
          <button
            onClick={onTry}
            className="rounded-full bg-[var(--color-ink)] px-3 py-1.5 text-sm font-medium text-[var(--color-paper)] hover:opacity-90"
          >
            Try the rewards demo (r1–r3) →
          </button>
        </div>
      )}
      <div className="grid grid-cols-1 gap-4 md:grid-cols-3">
        {REWARDS_VARIATIONS.map((v) => (
          <div key={v.id} className="flex flex-col rounded-2xl border border-black/10 bg-white p-5">
            <div className="mb-2 flex items-start justify-between gap-3">
              <span className="font-mono text-xs text-black/40">variant {v.id}</span>
              <VerdictBadge verdict={v.verdict} />
            </div>
            <h3 className="text-base font-semibold leading-snug">{v.title}</h3>
            <p className="mt-1 text-sm text-black/60">{v.one_liner}</p>

            <div className="mt-3 flex flex-wrap gap-1.5">
              {v.axes.map((a) => (
                <AxisPill key={a.label} label={a.label} value={a.value} />
              ))}
            </div>

            <details className="mt-3 text-sm">
              <summary className="cursor-pointer text-black/60 hover:underline">
                what observers see
              </summary>
              <p className="mt-2 text-black/80">{v.what_observer_sees}</p>
              {v.new_technique && (
                <p className="mt-2 text-black/80">
                  <span className="font-medium">New technique:</span> {v.new_technique}
                </p>
              )}
              {v.reason && (
                <p className="mt-2 text-black/80">
                  <span className="font-medium">
                    {v.verdict === 'research' ? 'Why research-grade:' : 'Why not yet:'}
                  </span>{' '}
                  {v.reason}
                </p>
              )}
            </details>

            <div className="mt-4 flex-1" />
            <span
              className={`self-start rounded-full border px-3 py-1 text-xs ${
                v.built
                  ? 'border-emerald-200 bg-emerald-50 text-emerald-700'
                  : 'border-black/15 bg-zinc-50 text-black/50'
              }`}
            >
              {v.built ? 'Shipped · try above' : 'Explainer only'}
            </span>
          </div>
        ))}
      </div>
    </section>
  )
}
