import { LENDING_VARIATIONS, type LendingVariation } from '../data/lending'
import { MatrixHeader } from './ui/MatrixHeader'
import { VerdictBadge } from './ui/VerdictBadge'
import { AxisPill } from './ui/AxisPill'

interface Props {
  onTry?: (id: LendingVariation['id']) => void
}

export function LendingMatrix({ onTry }: Props) {
  return (
    <section>
      <MatrixHeader
        title="Lending — privacy matrix"
        subtitle="Aztec's bundled Lending contract keys positions by a borrower-chosen secret instead of an address (ld1 + ld3). The custom PublicCollateralPrivateDebt contract bridges the public/private slot gap to enable ld2 — public collateral, private debt — keyed by a commitment. ld4 (anonymous liquidations) remains open research."
      />
      <div className="grid grid-cols-1 gap-4 md:grid-cols-2 lg:grid-cols-4">
        {LENDING_VARIATIONS.map((v) => {
          const interactive =
            v.verdict === 'buildable' && (v.id === 'ld1' || v.id === 'ld2' || v.id === 'ld3')
          return (
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
                {v.reason && (
                  <p className="mt-2 text-black/80">
                    <span className="font-medium">Why not yet:</span> {v.reason}
                  </p>
                )}
              </details>

              <div className="mt-4 flex-1" />
              {interactive ? (
                <button
                  onClick={() => onTry?.(v.id)}
                  className="self-start rounded-full bg-[var(--color-ink)] px-3 py-1.5 text-sm font-medium text-[var(--color-paper)] hover:opacity-90"
                >
                  Try variant {v.id} →
                </button>
              ) : (
                <span className="text-xs text-black/40">
                  {v.verdict === 'buildable' ? 'wired soon' : 'no live demo'}
                </span>
              )}
            </div>
          )
        })}
      </div>
    </section>
  )
}
