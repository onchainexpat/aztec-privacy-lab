import { useEffect, useRef, useState } from 'react'
import { initTestnetClient, resetTestnetAccount, type TestnetClient } from '../lib/browser-testnet'
import type { SandboxState } from '../lib/sandbox-state'
import { NETWORKS } from '../lib/network'

interface Props {
  state: SandboxState
  onClose: () => void
}

interface Balances {
  privateAZA: bigint
  publicAZA: bigint
  privateAZB: bigint
  publicAZB: bigint
}

export function LendingPanelTestnet({ state, onClose }: Props) {
  const [progress, setProgress] = useState<string | null>(null)
  const [client, setClient] = useState<TestnetClient | null>(null)
  const [error, setError] = useState<string | null>(null)
  const [result, setResult] = useState<string | null>(null)
  const [busy, setBusy] = useState(false)
  const [balances, setBalances] = useState<Balances | null>(null)
  const [position, setPosition] = useState<{ collateral: bigint; debt: bigint } | null>(null)
  const commitmentRef = useRef<bigint | null>(null)

  const cfg = NETWORKS.testnet
  const ld2 = state.publicCollateralPrivateDebt

  useEffect(() => {
    if (!client) return
    void refreshBalances(client)
  }, [client])

  async function refreshBalances(c: TestnetClient) {
    try {
      const [pA, uA, pB, uB] = await Promise.all([
        c.token0.methods.balance_of_private(c.address).simulate({ from: c.address }),
        c.token0.methods.balance_of_public(c.address).simulate({ from: c.address }),
        c.token1.methods.balance_of_private(c.address).simulate({ from: c.address }),
        c.token1.methods.balance_of_public(c.address).simulate({ from: c.address }),
      ])
      setBalances({
        privateAZA: pA.result as bigint,
        publicAZA: uA.result as bigint,
        privateAZB: pB.result as bigint,
        publicAZB: uB.result as bigint,
      })
    } catch {
      // balance reads can transiently fail while PXE catches up
      setBalances(null)
    }
  }

  async function handleInit() {
    setError(null)
    setBusy(true)
    try {
      const c = await initTestnetClient(state, setProgress)
      setClient(c)
      if (c.freshAccount) {
        setResult(
          `Your testnet account deployed at ${shortAddr(c.address.toString())} — fees paid by the canonical SponsoredFPC paymaster. Saved to localStorage so it persists across reloads.`,
        )
      }
    } catch (e) {
      setError(formatError(e))
    } finally {
      setBusy(false)
    }
  }

  async function handleResetAccount() {
    resetTestnetAccount()
    setClient(null)
    setBalances(null)
    setPosition(null)
    commitmentRef.current = null
    setResult('Local account credentials cleared. Click "Initialize" to generate a new one.')
  }

  return (
    <section className="mt-10 rounded-2xl border border-black/10 bg-white p-6">
      <div className="flex items-center justify-between">
        <h3 className="text-lg font-semibold">
          Lending — public collateral · private debt (variant ld2) on testnet
        </h3>
        <button onClick={onClose} className="text-sm text-black/50 underline-offset-4 hover:underline">
          Close
        </button>
      </div>

      <p className="mt-2 text-sm text-black/60">
        Custom <code className="font-mono text-xs">PublicCollateralPrivateDebt</code> contract
        deployed on Aztec Alpha v4 testnet. Each visitor gets their own per-tab Schnorr
        account (persisted in localStorage). Fees paid by the canonical SponsoredFPC paymaster
        — you don't need a faucet to deploy the account itself.
      </p>

      {ld2 && (
        <dl className="mt-3 grid grid-cols-1 gap-x-6 gap-y-1 text-xs md:grid-cols-2">
          <dt className="text-black/40">Contract address</dt>
          <dd className="font-mono">
            <a
              href={`${cfg.explorerUrl}/contracts/${ld2.address}`}
              target="_blank"
              rel="noreferrer"
              className="underline-offset-4 hover:underline"
            >
              {ld2.address.slice(0, 16)}… ↗
            </a>
          </dd>
          <dt className="text-black/40">Collateral / debt asset</dt>
          <dd className="font-mono">{ld2.collateralAsset} / {ld2.debtAsset}</dd>
          <dt className="text-black/40">Max LTV</dt>
          <dd className="font-mono">{ld2.ltvNumerator}/{ld2.ltvDenominator}</dd>
        </dl>
      )}

      {!client ? (
        <div className="mt-5">
          <button
            onClick={handleInit}
            disabled={busy}
            className="rounded-full bg-[var(--color-ink)] px-4 py-2 text-sm font-medium text-[var(--color-paper)] hover:opacity-90 disabled:opacity-50"
          >
            {busy ? 'Initializing…' : 'Initialize browser PXE + account on testnet'}
          </button>
          {progress && busy && <p className="mt-2 text-xs text-black/50">{progress}</p>}
          <p className="mt-3 max-w-prose text-xs text-black/50">
            First click is slow (~1-2 minutes): loads ~10 MB of WASM, syncs the PXE against
            the canonical testnet RPC, generates a fresh Schnorr account, and proves the
            account-deploy circuit before sending the tx. The account contract bytes live in
            <code className="font-mono"> localStorage</code> after that, so subsequent visits
            skip the deploy and just sync.
          </p>
        </div>
      ) : (
        <>
          <div className="mt-5 rounded-xl border border-sky-200 bg-sky-50/50 p-4 text-sm">
            <div className="flex flex-wrap items-center gap-x-6 gap-y-2">
              <div>
                <p className="text-xs uppercase tracking-wide text-sky-900/60">
                  your testnet account
                </p>
                <p className="mt-0.5 font-mono text-sky-950">
                  {shortAddr(client.address.toString())}
                </p>
              </div>
              {cfg.explorerUrl && (
                <a
                  href={`${cfg.explorerUrl}/contracts/${client.address.toString()}`}
                  target="_blank"
                  rel="noreferrer"
                  className="text-xs text-sky-700 underline-offset-4 hover:underline"
                >
                  Aztecscan ↗
                </a>
              )}
              <button
                onClick={handleResetAccount}
                className="ml-auto text-xs text-black/40 underline-offset-4 hover:text-black/70 hover:underline"
              >
                reset local account
              </button>
            </div>
          </div>

          {balances && (
            <div className="mt-3 grid grid-cols-1 gap-3 rounded-xl border border-black/10 bg-zinc-50 p-3 text-sm md:grid-cols-2">
              <Stat label={`AZA balance`} privAmt={balances.privateAZA} pubAmt={balances.publicAZA} />
              <Stat label={`AZB balance`} privAmt={balances.privateAZB} pubAmt={balances.publicAZB} />
            </div>
          )}

          <div className="mt-4 rounded-xl border border-amber-200 bg-amber-50/60 p-3 text-xs text-amber-900">
            <p className="font-medium">Interactive deposit / borrow — coming next</p>
            <p className="mt-1 text-amber-900/80">
              To exercise <code className="font-mono">deposit_public</code> +{' '}
              <code className="font-mono">borrow_private</code> against ld2 you need some AZA
              in your public balance. The faucet endpoint that mints AZA to per-tab accounts
              is the next piece of work (Vercel function size + 10 s timeout make it
              non-trivial; likely lives on a separate VPS or the home archive node).
              In the meantime: your testnet account is real and deployed, you can browse the
              ld2 contract state on Aztecscan, or clone the repo and run a local sandbox to
              exercise the full flow against your own deploy.
            </p>
            {position && (
              <p className="mt-2">
                <span className="font-medium">Position (public):</span>{' '}
                {fmt(position.collateral)} AZA collateral · {fmt(position.debt)} AZB debt
              </p>
            )}
          </div>
        </>
      )}

      {result && (
        <p className="mt-3 rounded-lg border border-emerald-200 bg-emerald-50 p-2 text-xs text-emerald-900">
          {result}
        </p>
      )}
      {error && (
        <pre className="mt-3 max-h-48 overflow-auto rounded-lg border border-rose-200 bg-rose-50 p-3 text-xs text-rose-900">
{error}
        </pre>
      )}
    </section>
  )
}

function Stat({ label, privAmt, pubAmt }: { label: string; privAmt: bigint; pubAmt: bigint }) {
  return (
    <div>
      <p className="text-xs uppercase tracking-wide text-black/40">{label}</p>
      <p className="mt-0.5 flex items-center gap-2 font-mono">
        <span className="inline-flex items-center gap-1 text-violet-700">
          <span className="size-1.5 rounded-full bg-violet-500" />
          {fmt(privAmt)} priv
        </span>
        <span className="inline-flex items-center gap-1 text-sky-700">
          <span className="size-1.5 rounded-full bg-sky-500" />
          {fmt(pubAmt)} pub
        </span>
      </p>
    </div>
  )
}

function fmt(n: bigint): string {
  return Number(n).toLocaleString('en-US')
}

function shortAddr(a: string): string {
  return `${a.slice(0, 10)}…${a.slice(-6)}`
}

function formatError(e: unknown): string {
  if (e instanceof Error) return `${e.name}: ${e.message}`
  return String(e)
}
