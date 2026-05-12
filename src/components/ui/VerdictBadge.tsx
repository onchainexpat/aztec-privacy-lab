import type { Verdict } from '../../data/variations'

const TONES: Record<Verdict, string> = {
  buildable: 'border-emerald-200 bg-emerald-50 text-emerald-700',
  hard: 'border-amber-200 bg-amber-50 text-amber-700',
  research: 'border-violet-200 bg-violet-50 text-violet-700',
  blocked: 'border-rose-200 bg-rose-50 text-rose-700',
}

const LABELS: Record<Verdict, string> = {
  buildable: 'Buildable today',
  hard: 'Hard but possible',
  research: 'Research-grade',
  blocked: 'Not yet possible',
}

export function VerdictBadge({ verdict }: { verdict: Verdict }) {
  return (
    <span
      className={`shrink-0 rounded-full border px-2 py-0.5 text-[11px] font-medium ${TONES[verdict]}`}
    >
      {LABELS[verdict]}
    </span>
  )
}
