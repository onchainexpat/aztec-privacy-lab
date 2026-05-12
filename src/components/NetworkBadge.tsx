import { useState } from 'react'
import { NETWORKS, type NetworkId } from '../lib/network'

interface Props {
  current: NetworkId
  onChange: (id: NetworkId) => void
}

export function NetworkBadge({ current, onChange }: Props) {
  const [open, setOpen] = useState(false)
  const cfg = NETWORKS[current]

  return (
    <div className="relative">
      <button
        onClick={() => setOpen((o) => !o)}
        className="flex items-center gap-2 rounded-full border border-black/10 bg-white px-3 py-1.5 text-sm font-medium hover:bg-black/5"
      >
        <span className="inline-block size-2 rounded-full bg-emerald-500" />
        {cfg.label}
        <span className="text-xs text-black/40">▾</span>
      </button>
      {open && (
        <div className="absolute right-0 z-10 mt-1 w-56 rounded-lg border border-black/10 bg-white shadow-lg">
          {Object.values(NETWORKS).map((n) => (
            <button
              key={n.id}
              disabled={!n.enabled}
              onClick={() => {
                if (!n.enabled) return
                onChange(n.id)
                setOpen(false)
              }}
              className="flex w-full items-center justify-between px-3 py-2 text-left text-sm hover:bg-black/5 disabled:cursor-not-allowed disabled:opacity-40"
            >
              <span>{n.label}</span>
              {!n.enabled && (
                <span className="rounded bg-black/5 px-1.5 py-0.5 text-[10px] uppercase tracking-wide text-black/50">
                  phase 5
                </span>
              )}
            </button>
          ))}
        </div>
      )}
    </div>
  )
}
