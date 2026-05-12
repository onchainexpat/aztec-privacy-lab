// Intercept pino log lines emitted by @aztec/pxe + @aztec/bb.js and route
// them to a UI sink, so the dashboard can show what's actually happening
// during a "wait" — witness generation, IVC stages, tx submission, etc.
//
// The console patch itself lives in index.html as an inline <script>, NOT
// here. Reason: pino-browser snapshots `_console[level]` during logger setup,
// which Vite bundles together with the rest of the codegen'd contract files'
// transitive imports. By the time this TS module's body runs, pino's logger
// has already captured the original console methods. Patching from index.html
// runs before the bundle, guaranteeing pino sees our wrapper.
//
// This module exposes the dispatch hook (window.__proofConsoleDispatch) so
// the inline patch routes captured args to our typed event sink. Any events
// buffered before this module loaded get drained on init.

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

function matchAndEmit(_method: string, args: unknown[]): void {
  if (activeSink === null && globalListeners.size === 0) return

  // pino-browser with asObject:false calls
  //   console.info(bindings?, data?, msg, ...rest)
  // For child loggers, bindings is prepended (object with .module etc).
  // The actual human-readable line is the last string arg.
  let moduleName = ''
  let extraDuration: number | null = null
  for (const a of args) {
    if (!a || typeof a !== 'object') continue
    const obj = a as Record<string, unknown>
    if (typeof obj.module === 'string') moduleName = obj.module
    if (typeof obj.duration === 'number') extraDuration = obj.duration
  }

  let message = ''
  for (let i = args.length - 1; i >= 0; i--) {
    if (typeof args[i] === 'string') {
      message = args[i] as string
      break
    }
  }
  if (!message) return

  const haystack = moduleName + ' ' + message
  for (const { match, source } of INTERESTING_PATTERNS) {
    const m = haystack.match(match)
    if (!m) continue
    const displayMessage =
      extraDuration !== null && /Generated ClientIVC proof/i.test(message)
        ? `${message} (${(extraDuration / 1000).toFixed(2)} s, 4.7 KB proof)`
        : trimMessage(message)
    const ev: ProofEvent = {
      ts: Date.now(),
      kind: 'info',
      source: source(m[0]),
      message: displayMessage,
    }
    if (activeSink) activeSink(ev)
    for (const listener of globalListeners) listener(ev)
    return
  }
}

function trimMessage(text: string): string {
  return text.slice(0, 240)
}

interface ProofConsoleQueueEntry {
  method: string
  args: unknown[]
  ts: number
}

declare global {
  interface Window {
    __proofConsoleQueue?: ProofConsoleQueueEntry[]
    __proofConsoleDispatch?: ((method: string, args: unknown[]) => void) | null
  }
}

// Drain any events captured before this module loaded, then hand the
// inline-script patch a live dispatcher so future events skip the buffer.
if (typeof window !== 'undefined') {
  const drained = window.__proofConsoleQueue ?? []
  for (const entry of drained) {
    try {
      matchAndEmit(entry.method, entry.args)
    } catch {
      // ignore
    }
  }
  // Clear and replace the queue with a live dispatcher
  window.__proofConsoleQueue = []
  window.__proofConsoleDispatch = matchAndEmit
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
