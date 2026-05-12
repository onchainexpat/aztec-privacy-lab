import { useEffect, useState } from 'react'
import { getBlockNumber, getNodeInfo } from '../lib/aztec'
import { NETWORKS, type NetworkId } from '../lib/network'

interface Props {
  network: NetworkId
}

interface Status {
  block: number
  chainId: number | bigint
  version: string | number
}

export function NodeStatus({ network }: Props) {
  const [status, setStatus] = useState<Status | null>(null)
  const [error, setError] = useState<string | null>(null)
  const cfg = NETWORKS[network]

  useEffect(() => {
    let cancelled = false
    setStatus(null)
    setError(null)
    ;(async () => {
      try {
        const [info, block] = await Promise.all([getNodeInfo(cfg), getBlockNumber(cfg)])
        if (cancelled) return
        setStatus({
          block,
          chainId: info.l1ChainId ?? 0,
          version: info.nodeVersion ?? 'unknown',
        })
      } catch (e) {
        if (cancelled) return
        setError(e instanceof Error ? e.message : String(e))
      }
    })()
    return () => {
      cancelled = true
    }
  }, [network, cfg])

  if (error) {
    return (
      <div className="rounded-lg border border-[var(--color-warn)]/30 bg-[var(--color-warn)]/10 p-3 font-mono text-xs">
        <p className="mb-1 font-sans font-semibold text-[var(--color-warn)]">
          Cannot reach {cfg.label}
        </p>
        <p className="text-black/60">{cfg.nodeUrl}</p>
        <p className="mt-1 text-black/60">{error}</p>
        {network === 'sandbox' && (
          <p className="mt-2 font-sans text-black/70">
            Start the sandbox: <code className="rounded bg-black/5 px-1">aztec start --sandbox</code>
          </p>
        )}
      </div>
    )
  }

  if (!status) {
    return (
      <div className="rounded-lg border border-black/10 bg-white p-3 font-mono text-xs text-black/40">
        Probing {cfg.nodeUrl}…
      </div>
    )
  }

  return (
    <div className="rounded-lg border border-black/10 bg-white p-3 font-mono text-xs">
      <div className="flex flex-wrap gap-x-6 gap-y-1">
        <span><span className="text-black/40">node </span>{status.version}</span>
        <span><span className="text-black/40">l1-chain </span>{String(status.chainId)}</span>
        <span><span className="text-black/40">block </span>{status.block}</span>
      </div>
    </div>
  )
}
