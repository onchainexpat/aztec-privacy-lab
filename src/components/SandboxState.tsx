import type { SandboxState } from '../lib/sandbox-state'
import { NETWORKS, type NetworkId } from '../lib/network'
import { Copyable } from './ui/Copyable'

interface Props {
  state: SandboxState | null
  network: NetworkId
}

export function SandboxStatePanel({ state, network }: Props) {
  const cfg = NETWORKS[network]
  const isTestnet = network === 'testnet'

  if (!state) {
    if (isTestnet) {
      // testnet-state.json wasn't found — unusual, since it's committed in the
      // repo. Probably means a fetch failure or the file got removed.
      return (
        <div className="rounded-2xl border border-dashed border-amber-200 bg-amber-50/40 p-5 text-sm">
          <h3 className="text-sm font-semibold text-amber-900">
            Couldn't load testnet-state.json
          </h3>
          <p className="mt-1 text-amber-900/80">
            Expected at <code className="font-mono text-xs">/testnet-state.json</code>. Check
            your Vercel build or run the dev server fresh — the dashboard ships with the file
            so this should never appear under normal circumstances.
          </p>
        </div>
      )
    }
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

  const tone = isTestnet ? 'sky' : 'emerald'
  const borderClass = tone === 'sky' ? 'border-sky-200 bg-sky-50/40' : 'border-emerald-200 bg-emerald-50/40'
  const headingClass = tone === 'sky' ? 'text-sky-900' : 'text-emerald-900'
  const badgeClass =
    tone === 'sky'
      ? 'bg-sky-600/10 text-sky-800'
      : 'bg-emerald-600/10 text-emerald-800'
  const hasReserves = !!state.reserves

  return (
    <div className={`rounded-2xl border p-5 ${borderClass}`}>
      <div className="mb-3 flex items-center justify-between">
        <div>
          <h3 className={`text-sm font-semibold ${headingClass}`}>
            {isTestnet ? 'Aztec testnet deploy' : `Sandbox AMM ${hasReserves ? '— pool seeded' : '— deployed'}`}
          </h3>
          <p className={`text-xs ${tone === 'sky' ? 'text-sky-800/70' : 'text-emerald-800/70'}`}>
            {formatAgo(new Date(state.deployedAt))} · {cfg.label}
          </p>
        </div>
        <span className={`rounded-full px-2 py-0.5 text-[11px] font-medium ${badgeClass}`}>
          {isTestnet ? 'live' : 'variant a • live'}
        </span>
      </div>

      <dl className="grid grid-cols-1 gap-x-6 gap-y-1 text-xs md:grid-cols-2">
        <Row label="Admin" value={state.deployer} explorer={cfg.explorerUrl} tone={tone} />
        <Row label={`${state.token0.symbol}`} value={state.token0.address} explorer={cfg.explorerUrl} tone={tone} />
        <Row label={`${state.token1.symbol}`} value={state.token1.address} explorer={cfg.explorerUrl} tone={tone} />
        <Row label={`${state.lpToken.symbol}`} value={state.lpToken.address} explorer={cfg.explorerUrl} tone={tone} />
        <Row label="AMM" value={state.amm.address} explorer={cfg.explorerUrl} tone={tone} />
        {state.publicCollateralPrivateDebt && (
          <Row
            label="ld2"
            value={state.publicCollateralPrivateDebt.address}
            explorer={cfg.explorerUrl}
            tone={tone}
          />
        )}
        {state.voting && (
          <Row label="Voting" value={state.voting.address} explorer={cfg.explorerUrl} tone={tone} />
        )}
      </dl>

      {hasReserves && state.reserves && !isTestnet && (
        <div className="mt-3 rounded-xl border border-emerald-200/70 bg-white/60 p-3">
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
          </div>
        </div>
      )}

      {isTestnet && (
        <p className="mt-3 text-[11px] text-sky-900/70">
          Fees on testnet are paid by the canonical SponsoredFPC paymaster ({' '}
          {state.sponsoredFpc ? <code className="font-mono">{state.sponsoredFpc.slice(0, 10)}…</code> : '—'}{' '}
          ). Block time ~36s. View any address on Aztecscan via the ↗ links.
        </p>
      )}
    </div>
  )
}

function Row({
  label,
  value,
  explorer,
  tone,
}: {
  label: string
  value: string
  explorer: string | null
  tone: 'sky' | 'emerald'
}) {
  const labelClass = tone === 'sky' ? 'text-sky-900/60' : 'text-emerald-900/60'
  return (
    <div className="flex items-center gap-2 text-xs">
      <span className={`w-20 shrink-0 ${labelClass}`}>{label}</span>
      <Copyable value={value} truncate={6} tone={tone} />
      {explorer && (
        <a
          href={`${explorer}/contracts/${value}`}
          target="_blank"
          rel="noreferrer"
          className={`text-xs underline-offset-4 hover:underline ${tone === 'sky' ? 'text-sky-700' : 'text-emerald-700'}`}
          title="View on Aztecscan"
        >
          ↗
        </a>
      )}
    </div>
  )
}

function fmt(s: string): string {
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
