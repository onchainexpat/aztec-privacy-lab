// Intercept pino log lines emitted by @aztec/pxe + @aztec/bb.js and route
// them to a UI sink, so the dashboard can show what's actually happening
// during a "wait" — witness generation, IVC stages, tx submission, etc.
//
// Important: pino-browser snapshots `console.info/log/debug/warn/error` at
// module-load time. If we patch console AFTER pino-browser has loaded, pino
// still holds a reference to the ORIGINAL methods and our patch is invisible.
// The fix is to install the console patch at app startup — before any
// dynamic import of @aztec/wallets/embedded (which transitively loads pino).
// `main.tsx` imports this file as a side effect so the patch installs first.

export type ProofEvent = {
  ts: number
  kind: 'info' | 'note'
  source: string
  message: string
}

export type ProofEventSink = (event: ProofEvent) => void

const INTERESTING_PATTERNS: { match: RegExp; source: (s: string) => string }[] = [
  { match: /pxe:.*proof|ClientIVC|witness generation|Generating proof|Generating ClientIVC/i, source: () => 'prover' },
  { match: /Sent transaction\s+(0x[0-9a-f]+)/i, source: () => 'wallet' },
  { match: /Added contract\s+(\S+)\s+at\s+(0x[0-9a-f]+)/i, source: () => 'pxe' },
  { match: /Simulating transaction|Simulation completed/i, source: () => 'simulate' },
  { match: /Started PXE connected/i, source: () => 'pxe' },
  { match: /Registered account/i, source: () => 'wallet' },
  { match: /Account stored in database/i, source: () => 'wallet:db' },
  { match: /Creating .*data store|Starting data store/i, source: () => 'kv-store' },
]

let activeSink: ProofEventSink | null = null
const globalListeners = new Set<ProofEventSink>()

export function subscribeProofEvents(listener: ProofEventSink): () => void {
  globalListeners.add(listener)
  return () => {
    globalListeners.delete(listener)
  }
}

function intercept(args: unknown[], kind: ProofEvent['kind'] = 'info'): void {
  if (activeSink === null && globalListeners.size === 0) return
  const text = args
    .map((a) => {
      if (typeof a === 'string') return a
      try {
        return JSON.stringify(a)
      } catch {
        return String(a)
      }
    })
    .join(' ')
  for (const { match, source } of INTERESTING_PATTERNS) {
    const m = text.match(match)
    if (!m) continue
    const ev: ProofEvent = { ts: Date.now(), kind, source: source(m[0]), message: trimMessage(text) }
    if (activeSink) activeSink(ev)
    for (const listener of globalListeners) listener(ev)
    return
  }
}

function trimMessage(text: string): string {
  return text
    .replace(/^\[\d{2}:\d{2}:\d{2}\.\d{3}\]\s+(INFO|DEBUG|TRACE|WARN|ERROR):\s+/, '')
    .replace(/\s+\{[^{}]*\}\s*$/, '') // drop pino's JSON tail if present
    .slice(0, 240)
}

// Install console patches ONCE at module load. Critical: this file must be
// imported by main.tsx BEFORE any @aztec/* module that transitively loads
// pino-browser. Otherwise pino's snapshot of _console.* points at the
// originals and we never see anything.
const consoleMethods = ['info', 'log', 'debug', 'warn', 'error', 'trace'] as const
type ConsoleMethod = (typeof consoleMethods)[number]

declare global {
  interface Window {
    __proofLogPatched?: true
  }
}

if (typeof window !== 'undefined' && !window.__proofLogPatched) {
  for (const m of consoleMethods) {
    const original = console[m] as (...a: unknown[]) => void
    const patched = ((...args: unknown[]) => {
      try {
        intercept(args)
      } catch {
        // never let a bug in our intercept break logging
      }
      original.apply(console, args)
    }) as Console[ConsoleMethod]
    Object.defineProperty(console, m, {
      value: patched,
      writable: true,
      configurable: true,
    })
  }
  window.__proofLogPatched = true
}

/** Begin routing matching console output through `sink`. Returns stop fn. */
export function captureProofLog(sink: ProofEventSink): () => void {
  activeSink = sink
  return () => {
    if (activeSink === sink) activeSink = null
  }
}

/** Convenience: emit a "note" event from app code. */
export function noteProofEvent(sink: ProofEventSink | undefined, source: string, message: string) {
  sink?.({ ts: Date.now(), kind: 'note', source, message })
}

/** Manually emit an event to global subscribers — for "dashboard" notes that
 *  panels want surfaced in the header indicator too, not just their own log. */
export function emitGlobalProofEvent(event: ProofEvent) {
  for (const listener of globalListeners) listener(event)
}
