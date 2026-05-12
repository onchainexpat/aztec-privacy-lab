import type { ProofTimerState } from '../../lib/proof-timer'

interface Props {
  state: ProofTimerState
  /** Optional short label shown after the counter, e.g. "borrow_private". */
  label?: string
}

/** Eye-catching timer that surfaces what's actually slow during a click —
 *  the ClientIVC proof being generated locally in the browser via bb.js. */
export function ProofTimer({ state, label }: Props) {
  if (!state.proving && !state.lastProof) return null

  if (state.proving) {
    return (
      <div className="mt-4 flex items-center gap-3 rounded-xl border border-violet-300 bg-violet-50 px-4 py-3">
        <span className="relative inline-flex size-3 shrink-0">
          <span className="absolute inline-flex h-full w-full animate-ping rounded-full bg-violet-400 opacity-75" />
          <span className="relative inline-flex size-3 rounded-full bg-violet-600" />
        </span>
        <div className="flex flex-1 items-baseline gap-2">
          <span className="text-sm font-medium text-violet-900">
            Generating ZK proof in your browser
          </span>
          {label && <span className="text-xs text-violet-700/80">· {label}</span>}
        </div>
        <span className="font-mono text-base text-violet-950 tabular-nums">
          {(state.elapsedMs / 1000).toFixed(1)}s
        </span>
      </div>
    )
  }

  const ms = state.lastProof!.durationMs
  return (
    <div className="mt-4 flex items-center gap-3 rounded-xl border border-emerald-300 bg-emerald-50 px-4 py-3">
      <span className="inline-flex size-3 shrink-0 items-center justify-center rounded-full bg-emerald-600 text-[10px] text-white">
        ✓
      </span>
      <div className="flex flex-1 items-baseline gap-2">
        <span className="text-sm font-medium text-emerald-900">
          Proof generated client-side
        </span>
        {label && <span className="text-xs text-emerald-700/80">· {label}</span>}
      </div>
      <span className="font-mono text-base text-emerald-950 tabular-nums">
        {(ms / 1000).toFixed(1)}s
      </span>
    </div>
  )
}
