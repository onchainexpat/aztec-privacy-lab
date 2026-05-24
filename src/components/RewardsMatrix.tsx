import { REWARDS_VARIATIONS } from '../data/rewards'
import { MatrixHeader } from './ui/MatrixHeader'
import { VerdictBadge } from './ui/VerdictBadge'
import { AxisPill } from './ui/AxisPill'

// Scoping matrix for the Merkl-style private rewards primitive. None of these
// are built yet — the cards document the design + feasibility so we can pick
// which to build. r1 is the strong primary (introduces in-circuit Merkle
// proofs + private-note payout, neither demonstrated elsewhere on the board).
export function RewardsMatrix() {
  return (
    <section className="mt-16">
      <MatrixHeader
        title="Private rewards distribution (Merkl-style) — privacy matrix"
        subtitle="An app funds a pool and publishes a Merkle root of (recipient, amount) computed off-chain from on-chain activity; users claim by proving inclusion privately and are paid into a private note. New ZK surface area vs the rest of the board: an in-circuit Merkle inclusion proof and a private-note payout. Scoped, not yet built."
      />
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
            <span className="self-start rounded-full border border-black/15 bg-zinc-50 px-3 py-1 text-xs text-black/50">
              {v.verdict === 'buildable' ? 'Buildable · not yet built' : 'Explainer only'}
            </span>
          </div>
        ))}
      </div>
    </section>
  )
}
