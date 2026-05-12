import type { Visibility } from '../../data/variations'

interface Props {
  label: string
  value: Visibility
}

export function AxisPill({ label, value }: Props) {
  const tone =
    value === 'private'
      ? 'bg-violet-100 text-violet-800 ring-violet-200'
      : value === 'public'
      ? 'bg-sky-100 text-sky-800 ring-sky-200'
      : 'bg-zinc-100 text-zinc-600 ring-zinc-200'
  return (
    <span className={`inline-flex items-center gap-1 rounded-full px-2 py-0.5 text-xs ring-1 ${tone}`}>
      <span className="font-medium">{label}</span>
      <span className="text-[10px] uppercase tracking-wide opacity-70">{value}</span>
    </span>
  )
}
