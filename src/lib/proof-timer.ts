// Derives a client-side "ZK proof generation" timing state from the stream of
// ProofEvents captured during PXE / SDK calls. The aztec PXE emits a pino log
// line `Generating ClientIVC proof...` when proving starts and
// `Generated ClientIVC proof` when it finishes — we watch for those.
//
// While proving, a 100ms interval ticks `elapsedMs` so the UI can render a
// live counter. After proving, `lastProof.durationMs` exposes the final
// wall-clock — that's what visitors see as "Proof generated in X.Xs".

import { useEffect, useMemo, useRef, useState } from 'react'
import { subscribeProofEvents, type ProofEvent } from './proof-log'

export interface ProofTimerState {
  /** True while a ClientIVC proof is being generated right now. */
  proving: boolean
  /** Real-time milliseconds since proof start (updated every 100 ms). */
  elapsedMs: number
  /** Most recent completed proof, sticks around until the next one starts. */
  lastProof: { durationMs: number } | null
}

function isProofStart(ev: ProofEvent): boolean {
  return ev.source === 'prover' && /Generating ClientIVC proof|Generating proof/i.test(ev.message)
}
function isProofEnd(ev: ProofEvent): boolean {
  return ev.source === 'prover' && /Generated ClientIVC proof/i.test(ev.message)
}

/** Per-panel proof timer — driven by a local events array the panel maintains. */
export function useProofTimer(events: ProofEvent[]): ProofTimerState {
  const { startedAt, endedAt } = useMemo(() => {
    let start: number | null = null
    let end: number | null = null
    for (const ev of events) {
      if (isProofStart(ev)) {
        start = ev.ts
        end = null
      } else if (isProofEnd(ev) && start !== null) {
        end = ev.ts
      }
    }
    return { startedAt: start, endedAt: end }
  }, [events])

  const [now, setNow] = useState(() => Date.now())

  useEffect(() => {
    if (startedAt === null || endedAt !== null) return
    const id = window.setInterval(() => setNow(Date.now()), 100)
    return () => window.clearInterval(id)
  }, [startedAt, endedAt])

  if (startedAt === null) {
    return { proving: false, elapsedMs: 0, lastProof: null }
  }
  if (endedAt === null) {
    return { proving: true, elapsedMs: Math.max(0, now - startedAt), lastProof: null }
  }
  return {
    proving: false,
    elapsedMs: 0,
    lastProof: { durationMs: endedAt - startedAt },
  }
}

/** Global proof timer — subscribes to the dashboard-wide event emitter so the
 *  header can show a proof indicator regardless of which panel is open. */
export function useGlobalProofTimer(): ProofTimerState {
  const [proving, setProving] = useState(false)
  const [elapsedMs, setElapsedMs] = useState(0)
  const [lastProof, setLastProof] = useState<{ durationMs: number } | null>(null)
  const startRef = useRef<number | null>(null)

  useEffect(() => {
    const unsub = subscribeProofEvents((ev) => {
      if (isProofStart(ev)) {
        startRef.current = ev.ts
        setProving(true)
        setElapsedMs(0)
      } else if (isProofEnd(ev) && startRef.current !== null) {
        const duration = ev.ts - startRef.current
        startRef.current = null
        setProving(false)
        setLastProof({ durationMs: duration })
      }
    })
    return unsub
  }, [])

  useEffect(() => {
    if (!proving) return
    const id = window.setInterval(() => {
      if (startRef.current !== null) {
        setElapsedMs(Date.now() - startRef.current)
      }
    }, 100)
    return () => window.clearInterval(id)
  }, [proving])

  return { proving, elapsedMs, lastProof }
}
