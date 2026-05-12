import { useEffect, useState } from 'react'
import { NETWORKS, type NetworkId } from '../lib/network'
import { getBlockNumber } from '../lib/aztec'
import { loadSandboxState, type SandboxState } from '../lib/sandbox-state'

interface Props {
  network: NetworkId
}

interface Counts {
  liveSections: number
  customContracts: number
  deployedContracts: number
}

function deriveCounts(state: SandboxState | null): Counts {
  if (!state) return { liveSections: 0, customContracts: 0, deployedContracts: 0 }
  let deployed = 0
  if (state.token0) deployed += 1
  if (state.token1) deployed += 1
  if (state.lpToken) deployed += 1
  if (state.amm) deployed += 1
  if (state.privateSwapWrapper) deployed += 1
  if (state.crowdfunding) deployed += 1
  if (state.publicCrowdfunding) deployed += 1
  if (state.perDonorReceipts) deployed += 1
  if (state.voting) deployed += 1
  if (state.priceFeed) deployed += 1
  if (state.lending) deployed += 1
  if (state.publicCollateralPrivateDebt) deployed += 1
  if (state.crossChain?.bridge0) deployed += 1
  if (state.crossChain?.l2BridgeB) deployed += 1
  if (state.crossChain?.l2Uniswap) deployed += 1
  return {
    // AMM, Launchpad, Lending, Voting, Cross-chain. (Five sections "live")
    liveSections: 5,
    customContracts: [
      state.privateSwapWrapper,
      state.publicCrowdfunding,
      state.perDonorReceipts,
      state.publicCollateralPrivateDebt,
    ].filter(Boolean).length,
    deployedContracts: deployed,
  }
}

export function StatsStrip({ network }: Props) {
  const [state, setState] = useState<SandboxState | null>(null)
  const [block, setBlock] = useState<number | null>(null)
  const [stale, setStale] = useState(false)
  const cfg = NETWORKS[network]
  const counts = deriveCounts(state)

  useEffect(() => {
    let cancelled = false
    loadSandboxState().then((s) => {
      if (!cancelled) setState(s)
    })
    return () => {
      cancelled = true
    }
  }, [])

  useEffect(() => {
    let cancelled = false
    setBlock(null)
    setStale(false)
    let last = -1
    let stallCount = 0
    const tick = async () => {
      try {
        const b = await getBlockNumber(cfg)
        if (cancelled) return
        setBlock(b)
        if (b === last) {
          stallCount += 1
          if (stallCount >= 3) setStale(true)
        } else {
          stallCount = 0
          setStale(false)
          last = b
        }
      } catch {
        if (!cancelled) setBlock(null)
      }
    }
    void tick()
    const id = setInterval(tick, 5_000)
    return () => {
      cancelled = true
      clearInterval(id)
    }
  }, [cfg])

  return (
    <div className="grid grid-cols-2 gap-2 rounded-2xl border border-black/10 bg-white p-3 text-sm md:grid-cols-5">
      <Tile label="sections live" value={`${counts.liveSections} / 6`} hint="AMM · Launchpad · Lending · Voting · Cross-chain" />
      <Tile
        label="custom Noir"
        value={counts.customContracts.toString()}
        hint="PrivateSwapWrapper · PublicTotalCrowdfunding · PerDonorReceipts · PublicCollateralPrivateDebt"
      />
      <Tile
        label="contracts deployed"
        value={counts.deployedContracts.toString()}
        hint="Includes Token, AMM, Lending, Crowdfunding, Voting, Bridges, Uniswap stack"
      />
      <Tile
        label={`L2 block (${cfg.label.split(' ')[0].toLowerCase()})`}
        value={block === null ? '—' : block.toLocaleString('en-US')}
        hint={stale ? 'Proposer idle — try clicking a "Try variant" button to poke it' : 'Updated every 5 s'}
        tone={stale ? 'amber' : 'default'}
      />
      <Tile
        label="L1 portal escrow"
        value={state?.crossChain?.l1Portal ? `${cfg.id === 'sandbox' ? 'tracked' : '—'}` : '—'}
        hint={
          state?.crossChain?.l1Portal
            ? 'TestERC20 held by the input portal — visible during bridges'
            : 'Run npm run sandbox:l1-portal to deploy the portal stack'
        }
      />
    </div>
  )
}

function Tile({
  label,
  value,
  hint,
  tone = 'default',
}: {
  label: string
  value: string
  hint: string
  tone?: 'default' | 'amber'
}) {
  const accent = tone === 'amber' ? 'text-amber-700' : 'text-black/80'
  return (
    <div className="rounded-lg px-2 py-1.5">
      <p className="text-xs uppercase tracking-wide text-black/40">{label}</p>
      <p className={`font-mono text-base ${accent}`}>{value}</p>
      <p className="mt-0.5 text-[11px] text-black/40 leading-snug">{hint}</p>
    </div>
  )
}
