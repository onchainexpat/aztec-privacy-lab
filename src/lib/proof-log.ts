// Intercept the pino log lines emitted by @aztec/pxe + @aztec/bb.js during
// proof generation and route them to a UI sink, so the dashboard can show
// what's actually happening during a "wait" — witness generation, IVC stages,
// tx submission, etc.
//
// Strategy: monkey-patch console.info / .log / .debug while a capture is
// active. The aztec packages emit through a pino logger whose default
// transport writes to console; matching console call args (`level`, `name`,
// formatted message) lets us extract just the interesting lines without
// shipping a custom pino transport.

export type ProofEvent = {
  ts: number
  kind: 'info' | 'note'
  source: string
  message: string
}

export type ProofEventSink = (event: ProofEvent) => void

// pino default JSON output looks like: [hh:mm:ss.SSS] LEVEL: name (info) message {...}
// In the browser, it usually arrives as plain console.info() calls of formatted
// strings — we filter on a few interesting substrings.
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
let originals: { info: typeof console.info; log: typeof console.log; debug: typeof console.debug } | null = null

function intercept(args: unknown[], kind: ProofEvent['kind'] = 'info') {
  const sink = activeSink
  if (!sink) return
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
    sink({ ts: Date.now(), kind, source: source(m[0]), message: trimMessage(text) })
    return
  }
}

function trimMessage(text: string): string {
  // pino formats like "[20:57:17.587] INFO: embedded-wallet:pxe:service ...".
  // Strip the timestamp + level prefix for readability — we already have ts.
  return text
    .replace(/^\[\d{2}:\d{2}:\d{2}\.\d{3}\]\s+(INFO|DEBUG|TRACE|WARN|ERROR):\s+/, '')
    .replace(/\s+\{.*\}$/, '') // drop the JSON tail that pino appends
    .slice(0, 240)
}

/** Begin routing matching console output through the sink. Returns a stop fn. */
export function captureProofLog(sink: ProofEventSink): () => void {
  if (originals) {
    // Already capturing — replace the sink only.
    activeSink = sink
    return () => {
      activeSink = null
    }
  }
  originals = {
    info: console.info.bind(console),
    log: console.log.bind(console),
    debug: console.debug.bind(console),
  }
  activeSink = sink
  console.info = ((...args: unknown[]) => {
    intercept(args, 'info')
    originals!.info(...args)
  }) as typeof console.info
  console.log = ((...args: unknown[]) => {
    intercept(args, 'info')
    originals!.log(...args)
  }) as typeof console.log
  console.debug = ((...args: unknown[]) => {
    intercept(args, 'info')
    originals!.debug(...args)
  }) as typeof console.debug
  return () => {
    if (originals) {
      console.info = originals.info
      console.log = originals.log
      console.debug = originals.debug
      originals = null
    }
    activeSink = null
  }
}

/** Convenience: emit a "note" event from app code, alongside captured events. */
export function noteProofEvent(sink: ProofEventSink | undefined, source: string, message: string) {
  sink?.({ ts: Date.now(), kind: 'note', source, message })
}
