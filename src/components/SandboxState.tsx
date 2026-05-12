import { useEffect, useState } from 'react'
import { loadSandboxState, type SandboxState } from '../lib/sandbox-state'
import { Copyable } from './ui/Copyable'

export function SandboxStatePanel() {
  const [state, setState] = useState<SandboxState | null>(null)
  const [loaded, setLoaded] = useState(false)

  useEffect(() => {
    loadSandboxState().then((s) => {
      setState(s)
      setLoaded(true)
    })
  }, [])

  if (!loaded) return null

  if (!state) {
    return (
      <div className="rounded-2xl border border-dashed border-black/15 bg-white p-5">
        <h3 className="text-sm font-semibold">No sandbox deployment yet</h3>
        <p className="mt-1 text-sm text-black/60">
          Bring up the local Aztec network and run the bootstrap scripts:
        </p>
        <pre className="mt-3 overflow-auto rounded-lg bg-zinc-900 p-3 text-xs text-zinc-100">
{`aztec start --local-network --port 8090   # in another shell
npm run sandbox:setup                       # deploys Token + AMM, mints balances
npm run sandbox:seed                        # adds liquidity, runs a sample swap`}
        </pre>
      </div>
    )
  }

  const hasReserves = !!state.reserves
  const lastSwap = state.lastSwap

  return (
    <div className="rounded-2xl border border-emerald-200 bg-emerald-50/40 p-5">
      <div className="mb-3 flex items-center justify-between">
        <div>
          <h3 className="text-sm font-semibold text-emerald-900">
            Sandbox AMM {hasReserves ? '— pool seeded' : '— deployed'}
          </h3>
          <p className="text-xs text-emerald-800/70">{formatAgo(new Date(state.deployedAt))}</p>
        </div>
        <span className="rounded-full bg-emerald-600/10 px-2 py-0.5 text-[11px] font-medium text-emerald-800">
          variant a • live
        </span>
      </div>

      <dl className="mb-3 grid grid-cols-1 gap-x-6 gap-y-1 text-sm md:grid-cols-2">
        <Row label="AMM" value={state.amm.address} />
        <Row label="Admin" value={state.deployer} />
        <Row label={`Token0 (${state.token0.symbol})`} value={state.token0.address} />
        <Row label={`Token1 (${state.token1.symbol})`} value={state.token1.address} />
        <Row label="LP token" value={state.lpToken.address} />
      </dl>

      {hasReserves && state.reserves && (
        <div className="rounded-xl border border-emerald-200/70 bg-white/60 p-3">
          <div className="flex items-end justify-between">
            <div>
              <p className="text-xs uppercase tracking-wide text-emerald-900/50">
                pool reserves (public)
              </p>
              <p className="mt-0.5 font-mono text-sm text-emerald-950">
                {fmt(state.reserves.AZA)} {state.token0.symbol}
                <span className="mx-2 text-emerald-900/30">/</span>
                {fmt(state.reserves.AZB)} {state.token1.symbol}
              </p>
            </div>
            {state.adminBalances && (
              <div className="text-right">
                <p className="text-xs uppercase tracking-wide text-emerald-900/50">
                  admin private balance
                </p>
                <p className="mt-0.5 font-mono text-sm text-emerald-950">
                  {fmt(state.adminBalances.AZA)} {state.token0.symbol}
                  <span className="mx-2 text-emerald-900/30">·</span>
                  {fmt(state.adminBalances.AZB)} {state.token1.symbol}
                </p>
              </div>
            )}
          </div>

          {lastSwap && (
            <div className="mt-3 flex items-center gap-3 border-t border-emerald-200/60 pt-3 text-sm">
              <span className="rounded-full bg-violet-100 px-2 py-0.5 text-[11px] font-medium text-violet-800">
                last swap
              </span>
              <span className="font-mono text-emerald-950">
                {fmt(lastSwap.in.amount)} {lastSwap.in.symbol} → {fmt(lastSwap.out.amount)}{' '}
                {lastSwap.out.symbol}
              </span>
              <span className="text-xs text-emerald-900/50">
                {formatAgo(new Date(lastSwap.at))}
              </span>
            </div>
          )}
        </div>
      )}
    </div>
  )
}

function Row({ label, value }: { label: string; value: string }) {
  return (
    <div className="flex items-center gap-2 text-xs">
      <span className="w-32 shrink-0 text-emerald-900/60">{label}</span>
      <Copyable value={value} truncate={6} tone="emerald" />
    </div>
  )
}

function fmt(s: string): string {
  // Numbers in the state file are decimal strings of raw token units (we
  // mint with 18 decimals but use small absolute amounts, so just group).
  if (!/^\d+$/.test(s)) return s
  return Number(s).toLocaleString('en-US')
}

function formatAgo(d: Date): string {
  const ms = Date.now() - d.getTime()
  const s = Math.round(ms / 1000)
  if (s < 60) return `${s}s ago`
  const m = Math.round(s / 60)
  if (m < 60) return `${m}m ago`
  const h = Math.round(m / 60)
  if (h < 48) return `${h}h ago`
  return d.toLocaleString()
}
