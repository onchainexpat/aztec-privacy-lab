import { useState } from 'react'

interface Props {
  value: string
  /** How many characters to keep on each side when truncating. Default 4. */
  truncate?: number
  /** Tone affects hover styling. */
  tone?: 'default' | 'emerald' | 'sky'
  /** Show the value at full length without truncation. */
  full?: boolean
}

export function Copyable({ value, truncate = 4, tone = 'default', full = false }: Props) {
  const [copied, setCopied] = useState(false)

  const display = full || value.length <= 10 + truncate
    ? value
    : `${value.slice(0, 6)}…${value.slice(-truncate)}`

  const toneClasses =
    tone === 'emerald'
      ? 'text-emerald-900 hover:bg-emerald-100/60'
      : tone === 'sky'
        ? 'text-sky-900 hover:bg-sky-100/60'
        : 'text-black/80 hover:bg-black/5'

  async function copy() {
    try {
      await navigator.clipboard?.writeText(value)
      setCopied(true)
      setTimeout(() => setCopied(false), 1100)
    } catch {
      // ignore — older browsers / insecure contexts
    }
  }

  return (
    <button
      type="button"
      onClick={copy}
      title={`${value} — click to copy`}
      className={`group inline-flex items-center gap-1.5 rounded px-1 py-0.5 font-mono text-xs transition ${toneClasses}`}
    >
      <span>{display}</span>
      <span
        aria-hidden
        className={`text-[10px] transition-opacity ${
          copied ? 'opacity-100 text-emerald-600' : 'opacity-0 group-hover:opacity-60'
        }`}
      >
        {copied ? '✓ copied' : '⧉'}
      </span>
    </button>
  )
}
