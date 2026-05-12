import { LAUNCHPAD_VARIATIONS, type LaunchpadVariation } from '../data/launchpad'
import { MatrixHeader } from './ui/MatrixHeader'
import { VerdictBadge } from './ui/VerdictBadge'
import { AxisPill } from './ui/AxisPill'

interface Props {
  onTry?: (id: LaunchpadVariation['id']) => void
}

export function LaunchpadMatrix({ onTry }: Props) {
  return (
    <section>
      <MatrixHeader
        title="Launchpad — privacy matrix"
        subtitle="Three takes on a fundraise: hide donors, amounts, totals — or mix and match. All three ship today; lp2 and lp3 are custom Noir contracts authored in this repo."
      />
      <div className="grid grid-cols-1 gap-4 md:grid-cols-3">
        {LAUNCHPAD_VARIATIONS.map((v) => {
          const interactive = v.verdict === 'buildable'
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
                <span className="text-xs text-black/40">Needs custom Noir; tracked as phase 4.5.</span>
              )}
            </div>
          )
        })}
      </div>
    </section>
  )
}
