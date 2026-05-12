import { useEffect, useState } from 'react'
import { useGlobalProofTimer } from '../lib/proof-timer'

/** Tiny header pill that surfaces ZK proof generation happening anywhere in
 *  the dashboard. Shows a live ticking counter while proving + a sticky
 *  "last proof: X.Xs" badge for a few seconds after completion. */
export function HeaderProofIndicator() {
  const timer = useGlobalProofTimer()
  const [showLast, setShowLast] = useState<{ durationMs: number } | null>(null)

  useEffect(() => {
    if (!timer.lastProof || timer.proving) return
    setShowLast(timer.lastProof)
    const t = window.setTimeout(() => setShowLast(null), 8000)
    return () => window.clearTimeout(t)
  }, [timer.lastProof, timer.proving])

  if (timer.proving) {
    return (
      <span
        className="inline-flex items-center gap-2 rounded-full border border-violet-300 bg-violet-50 px-3 py-1 text-xs font-medium text-violet-900"
        title="A ZK proof is being generated locally in your browser via bb.js (Aztec's barretenberg WASM prover)."
      >
        <span className="relative inline-flex size-2 shrink-0">
          <span className="absolute inline-flex h-full w-full animate-ping rounded-full bg-violet-400 opacity-75" />
          <span className="relative inline-flex size-2 rounded-full bg-violet-600" />
        </span>
        <span>generating ZK proof</span>
        <span className="font-mono tabular-nums text-violet-950">
          {(timer.elapsedMs / 1000).toFixed(1)}s
        </span>
      </span>
    )
  }

  if (showLast) {
    return (
      <span
        className="inline-flex items-center gap-2 rounded-full border border-emerald-300 bg-emerald-50 px-3 py-1 text-xs font-medium text-emerald-900"
        title="Proof was generated client-side. The sequencer only sees the proof, not the inputs."
      >
        <span className="inline-flex size-2 shrink-0 rounded-full bg-emerald-600" />
        <span>proof generated</span>
        <span className="font-mono tabular-nums text-emerald-950">
          {(showLast.durationMs / 1000).toFixed(1)}s
        </span>
      </span>
    )
  }

  return null
}
