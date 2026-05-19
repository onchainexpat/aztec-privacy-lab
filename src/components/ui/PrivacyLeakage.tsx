interface Props {
  /** What becomes publicly observable when this action lands. Empty = nothing observable beyond gas. */
  publicLeaks?: string[]
  /** What stays encrypted in the caller's PXE or otherwise hidden. */
  staysPrivate?: string[]
  /** Optional short caveat (e.g., trust assumption about an operator). */
  caveat?: string
  className?: string
}

/**
 * Pre-flight privacy analysis: shows what an action will leak vs keep
 * private BEFORE the user signs. Maps to Aztec's "native privacy wallet
 * architecture" feature - the badge gives users a chance to understand the
 * privacy delta of every action.
 */
export function PrivacyLeakage({ publicLeaks = [], staysPrivate = [], caveat, className }: Props) {
  const leaksNothing = publicLeaks.length === 0
  return (
    <div className={`text-[11px] ${className ?? ''}`}>
      <div className="flex flex-wrap items-start gap-1.5">
        <span
          className={`inline-flex items-center gap-1 rounded-full px-2 py-0.5 ring-1 ${
            leaksNothing
              ? 'bg-emerald-50 text-emerald-800 ring-emerald-200'
              : 'bg-sky-50 text-sky-800 ring-sky-200'
          }`}
        >
          <span className="font-semibold uppercase tracking-wide text-[9px]">Public</span>
          <span>
            {leaksNothing ? 'nothing observable' : publicLeaks.join(' · ')}
          </span>
        </span>
        {staysPrivate.length > 0 && (
          <span className="inline-flex items-center gap-1 rounded-full bg-violet-50 px-2 py-0.5 text-violet-800 ring-1 ring-violet-200">
            <span className="font-semibold uppercase tracking-wide text-[9px]">Private</span>
            <span>{staysPrivate.join(' · ')}</span>
          </span>
        )}
      </div>
      {caveat && (
        <p className="mt-1 text-[10px] text-amber-900/80">
          <span className="font-medium">caveat:</span> {caveat}
        </p>
      )}
    </div>
  )
}
