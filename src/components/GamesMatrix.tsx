import { GAME_VARIATIONS, type GameVariation } from '../data/games'
import { MatrixHeader } from './ui/MatrixHeader'
import { VerdictBadge } from './ui/VerdictBadge'
import { AxisPill } from './ui/AxisPill'

interface Props {
  onTry?: (id: GameVariation['id']) => void
}

export function GamesMatrix({ onTry }: Props) {
  return (
    <section>
      <MatrixHeader
        title="Games — privacy matrix"
        subtitle="Pay-to-play games where a Noir contract holds hidden state. Two ship today (g1, g2) with explicit honesty about the on-chain RNG limit; the trustless PvP variant (g3) is research-grade."
      />
      <div className="grid grid-cols-1 gap-4 md:grid-cols-3">
        {GAME_VARIATIONS.map((v) => {
          const interactive = v.verdict === 'hard'
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
                {v.trust_caveat && (
                  <p className="mt-2 rounded border border-amber-200 bg-amber-50 p-2 text-amber-900">
                    <span className="font-medium">Trust caveat:</span> {v.trust_caveat}
                  </p>
                )}
                {v.reason && (
                  <p className="mt-2 text-black/80">
                    <span className="font-medium">Why research-grade:</span> {v.reason}
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
                  Needs PvP matchmaker UI; tracked as future work.
                </span>
              )}
            </div>
          )
        })}
      </div>
    </section>
  )
}
