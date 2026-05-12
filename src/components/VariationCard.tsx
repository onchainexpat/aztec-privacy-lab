import { useState } from 'react'
import type { Variation } from '../data/variations'
import { VerdictBadge } from './ui/VerdictBadge'
import { AxisPill } from './ui/AxisPill'

interface Props {
  variation: Variation
  onTry?: (id: Variation['id']) => void
}

export function VariationCard({ variation, onTry }: Props) {
  const [open, setOpen] = useState(false)
  const interactive = variation.verdict === 'buildable' || variation.verdict === 'hard'

  return (
    <div className="flex flex-col rounded-2xl border border-black/10 bg-white p-5">
      <div className="mb-2 flex items-start justify-between gap-3">
        <span className="font-mono text-xs text-black/40">variant {variation.id}</span>
        <VerdictBadge verdict={variation.verdict} />
      </div>
      <h3 className="text-base font-semibold leading-snug">{variation.title}</h3>
      <p className="mt-1 text-sm text-black/60">{variation.one_liner}</p>

      <div className="mt-3 flex flex-wrap gap-1.5">
        {variation.axes.map((a) => (
          <AxisPill key={a.label} label={a.label} value={a.value} />
        ))}
      </div>

      <button
        onClick={() => setOpen((o) => !o)}
        className="mt-4 self-start text-sm text-black/60 underline-offset-4 hover:underline"
      >
        {open ? '− Hide details' : '+ What’s leaked / why?'}
      </button>

      {open && (
        <div className="mt-3 space-y-3 text-sm">
          <div>
            <p className="text-xs uppercase tracking-wide text-black/40">L1 observer sees</p>
            <p className="text-black/80">{variation.what_l1_sees}</p>
          </div>
          <div>
            <p className="text-xs uppercase tracking-wide text-black/40">L2 observer sees</p>
            <p className="text-black/80">{variation.what_observer_sees_on_l2}</p>
          </div>
          {variation.reason && (
            <div>
              <p className="text-xs uppercase tracking-wide text-black/40">Why not (yet)</p>
              <p className="text-black/80">{variation.reason}</p>
            </div>
          )}
        </div>
      )}

      <div className="mt-4 flex-1" />
      <div className="flex items-center justify-between">
        {interactive ? (
          <button
            onClick={() => onTry?.(variation.id)}
            className="rounded-full bg-[var(--color-ink)] px-3 py-1.5 text-sm font-medium text-[var(--color-paper)] hover:opacity-90"
          >
            Try variant {variation.id} →
          </button>
        ) : (
          <span className="text-xs text-black/40">No live demo for this variant.</span>
        )}
        {variation.source && (
          <a
            href={variation.source.href}
            target="_blank"
            rel="noreferrer"
            className="text-xs text-black/40 underline-offset-4 hover:text-black/70 hover:underline"
          >
            {variation.source.label} ↗
          </a>
        )}
      </div>
    </div>
  )
}
