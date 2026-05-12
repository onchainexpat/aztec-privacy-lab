import { useEffect, useRef, useState } from 'react'
import {
  initTestnetClient,
  resetTestnetAccount,
  subscribeTestnetClient,
  getResolvedTestnetClient,
  type TestnetClient,
} from '../lib/browser-testnet'
import type { SandboxState } from '../lib/sandbox-state'
import { NETWORKS } from '../lib/network'
import { faucetMint, isFaucetConfigured } from '../lib/faucet'
import { captureProofLog, type ProofEvent } from '../lib/proof-log'
import { useProofTimer } from '../lib/proof-timer'
import { ProofTimer } from './ui/ProofTimer'
import { formatUSD } from '../lib/prices'

interface Props {
  state: SandboxState
}

interface Balances {
  privETH: bigint
  pubETH: bigint
  privUSDC: bigint
  pubUSDC: bigint
}

const FAUCET_AMOUNT = 10_000n

export function WalletPanel({ state }: Props) {
  const [client, setClient] = useState<TestnetClient | null>(getResolvedTestnetClient())
  const [busy, setBusy] = useState(false)
  const [progress, setProgress] = useState<string | null>(null)
  const [result, setResult] = useState<string | null>(null)
  const [error, setError] = useState<string | null>(null)
  const [balances, setBalances] = useState<Balances | null>(null)
  const [proofLog, setProofLog] = useState<ProofEvent[]>([])
  const proofTimer = useProofTimer(proofLog)
  const pollRef = useRef<number | null>(null)

  const cfg = NETWORKS.testnet
  const t0sym = state.token0.symbol
  const t1sym = state.token1.symbol
  const faucetReady = isFaucetConfigured()

  function pushProofEvent(ev: ProofEvent) {
    setProofLog((prev) => {
      const next = prev.concat(ev)
      return next.length > 60 ? next.slice(next.length - 60) : next
    })
  }
  function pushNote(message: string) {
    pushProofEvent({ ts: Date.now(), kind: 'note', source: 'wallet', message })
  }

  useEffect(() => subscribeTestnetClient(setClient), [])

  useEffect(() => {
    if (!client) {
      setBalances(null)
      return
    }
    void refreshBalances(client)
    pollRef.current = window.setInterval(() => void refreshBalances(client), 15_000)
    return () => {
      if (pollRef.current !== null) window.clearInterval(pollRef.current)
    }
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
        privETH: pA.result as bigint,
        pubETH: uA.result as bigint,
        privUSDC: pB.result as bigint,
        pubUSDC: uB.result as bigint,
      })
    } catch {
      // transient
    }
  }

  async function handleInit() {
    setError(null)
    setBusy(true)
    const stopCapture = captureProofLog(pushProofEvent)
    try {
      const c = await initTestnetClient(state, (msg) => {
        setProgress(msg)
        pushNote(msg)
      })
      if (c.freshAccount) {
        setResult(`Account deployed — saved to localStorage for next visit.`)
      }
    } catch (e) {
      setError(formatError(e))
    } finally {
      stopCapture()
      setBusy(false)
    }
  }

  async function handleReset() {
    resetTestnetAccount()
    setBalances(null)
    setResult('Local account credentials cleared. Click Initialize to generate a new one.')
  }

  async function handleFaucet(token: 'AZA' | 'AZB', mode: 'public' | 'private') {
    if (!client) return
    setError(null)
    setBusy(true)
    setResult(null)
    const sym = token === 'AZA' ? t0sym : t1sym
    pushNote(`requesting ${FAUCET_AMOUNT} ${sym} (${mode}) from faucet`)
    try {
      const resp = await faucetMint(client.address.toString(), token, { private: mode === 'private' })
      pushNote(`faucet tx submitted: ${shortHex(resp.txHash)}`)
      setResult(`Mint submitted: ${resp.amount} ${sym} (${mode}). Block inclusion in ~36 s.`)
    } catch (e) {
      setError(formatError(e))
    } finally {
      setBusy(false)
    }
  }

  async function handleShield(token: 'token0' | 'token1') {
    if (!client || !balances) return
    setError(null)
    setBusy(true)
    setResult(null)
    const contract = token === 'token0' ? client.token0 : client.token1
    const sym = token === 'token0' ? t0sym : t1sym
    const amount = token === 'token0' ? balances.pubETH : balances.pubUSDC
    if (amount === 0n) {
      setError(`No public ${sym} to shield.`)
      setBusy(false)
      return
    }
    pushNote(`transfer_to_private — shielding ${amount} ${sym}`)
    const stopCapture = captureProofLog(pushProofEvent)
    try {
      await contract.methods
        .transfer_to_private(client.address, amount)
        .send({ from: client.address, fee: client.feeOpts })
      setResult(`Shielded ${fmt(amount)} ${sym} — public balance dropped to 0; private note minted.`)
      await refreshBalances(client)
    } catch (e) {
      setError(formatError(e))
    } finally {
      stopCapture()
      setBusy(false)
    }
  }

  async function handleUnshield(token: 'token0' | 'token1') {
    if (!client || !balances) return
    setError(null)
    setBusy(true)
    setResult(null)
    const contract = token === 'token0' ? client.token0 : client.token1
    const sym = token === 'token0' ? t0sym : t1sym
    const amount = token === 'token0' ? balances.privETH : balances.privUSDC
    if (amount === 0n) {
      setError(`No private ${sym} to unshield.`)
      setBusy(false)
      return
    }
    pushNote(`transfer_to_public — unshielding ${amount} ${sym}`)
    const stopCapture = captureProofLog(pushProofEvent)
    try {
      const { Fr } = await import('@aztec/aztec.js/fields')
      const nonce = Fr.random()
      // self → self transfer; msg_sender == from, so no public authwit needed.
      await contract.methods
        .transfer_to_public(client.address, client.address, amount, nonce)
        .send({ from: client.address, fee: client.feeOpts })
      setResult(`Unshielded ${fmt(amount)} ${sym} — private note burned; public balance bumped.`)
      await refreshBalances(client)
    } catch (e) {
      setError(formatError(e))
    } finally {
      stopCapture()
      setBusy(false)
    }
  }

  if (!client) {
    return (
      <section className="mt-6 rounded-2xl border border-black/10 bg-white p-5">
        <div className="flex items-start justify-between gap-4">
          <div>
            <h2 className="text-lg font-semibold">Your testnet wallet</h2>
            <p className="mt-1 max-w-prose text-sm text-black/60">
              Each visitor gets a per-tab Schnorr account on Aztec testnet (saved to
              localStorage). Fees on every tx paid by the canonical SponsoredFPC paymaster —
              no fee-juice needed. Initialize once here and the demos below reuse it.
            </p>
          </div>
          <button
            onClick={handleInit}
            disabled={busy}
            className="shrink-0 rounded-full bg-[var(--color-ink)] px-4 py-2 text-sm font-medium text-[var(--color-paper)] hover:opacity-90 disabled:opacity-50"
          >
            {busy ? 'Initializing…' : 'Initialize wallet'}
          </button>
        </div>
        {progress && busy && <p className="mt-2 text-xs text-black/50">{progress}</p>}
        {error && (
          <pre className="mt-3 max-h-32 overflow-auto rounded-lg border border-rose-200 bg-rose-50 p-3 text-xs text-rose-900">
{error}
          </pre>
        )}
      </section>
    )
  }

  return (
    <section className="mt-6 rounded-2xl border border-black/10 bg-white p-5">
      <div className="flex flex-wrap items-start justify-between gap-3">
        <div>
          <h2 className="text-lg font-semibold">Your testnet wallet</h2>
          <div className="mt-1 flex flex-wrap items-center gap-3 text-xs text-black/60">
            <span className="font-mono">{shortAddr(client.address.toString())}</span>
            {cfg.explorerUrl && (
              <a
                href={`${cfg.explorerUrl}/contracts/${client.address.toString()}`}
                target="_blank"
                rel="noreferrer"
                className="underline-offset-4 hover:underline"
              >
                Aztecscan ↗
              </a>
            )}
          </div>
        </div>
        <button
          onClick={handleReset}
          disabled={busy}
          className="shrink-0 text-xs text-black/40 underline-offset-4 hover:text-black/70 hover:underline"
        >
          reset local account
        </button>
      </div>

      {balances && (
        <div className="mt-4 grid grid-cols-1 gap-3 md:grid-cols-2">
          <TokenRow
            sym={t0sym}
            priv={balances.privETH}
            pub={balances.pubETH}
            onShield={() => handleShield('token0')}
            onUnshield={() => handleUnshield('token0')}
            onFaucet={(mode) => handleFaucet('AZA', mode)}
            busy={busy}
            faucetReady={faucetReady}
          />
          <TokenRow
            sym={t1sym}
            priv={balances.privUSDC}
            pub={balances.pubUSDC}
            onShield={() => handleShield('token1')}
            onUnshield={() => handleUnshield('token1')}
            onFaucet={(mode) => handleFaucet('AZB', mode)}
            busy={busy}
            faucetReady={faucetReady}
          />
        </div>
      )}

      <ProofTimer state={proofTimer} label={proofTimer.proving ? 'shield/unshield' : 'last private call'} />

      {result && (
        <p className="mt-3 rounded-lg border border-emerald-200 bg-emerald-50 p-2 text-xs text-emerald-900">
          {result}
        </p>
      )}
      {error && (
        <pre className="mt-3 max-h-32 overflow-auto rounded-lg border border-rose-200 bg-rose-50 p-3 text-xs text-rose-900">
{error}
        </pre>
      )}

      <p className="mt-3 text-[11px] text-black/40">
        Prices in USD are demo-only: azETH pegged to $2,500 and azUSDC to $1. The on-chain
        balances are integer units in the bundled Token contract — the conversion is purely
        cosmetic.
      </p>
    </section>
  )
}

function TokenRow({
  sym,
  priv,
  pub,
  onShield,
  onUnshield,
  onFaucet,
  busy,
  faucetReady,
}: {
  sym: string
  priv: bigint
  pub: bigint
  onShield: () => void
  onUnshield: () => void
  onFaucet: (mode: 'public' | 'private') => void
  busy: boolean
  faucetReady: boolean
}) {
  return (
    <div className="rounded-xl border border-black/10 bg-zinc-50 p-3">
      <div className="flex items-baseline justify-between gap-2">
        <p className="text-xs uppercase tracking-wide text-black/40">{sym}</p>
        <p className="text-[11px] text-black/40">
          total ≈ {formatUSD(priv + pub, sym)}
        </p>
      </div>
      <div className="mt-1 grid grid-cols-2 gap-2 text-sm">
        <div>
          <p className="flex items-center gap-1 font-mono text-violet-700">
            <span className="size-1.5 rounded-full bg-violet-500" />
            {fmt(priv)} priv
          </p>
          <p className="text-[11px] text-black/40">{formatUSD(priv, sym)}</p>
        </div>
        <div>
          <p className="flex items-center gap-1 font-mono text-sky-700">
            <span className="size-1.5 rounded-full bg-sky-500" />
            {fmt(pub)} pub
          </p>
          <p className="text-[11px] text-black/40">{formatUSD(pub, sym)}</p>
        </div>
      </div>
      <div className="mt-3 flex flex-wrap gap-1.5 text-[11px]">
        <button
          onClick={() => onFaucet('public')}
          disabled={busy || !faucetReady}
          className="rounded-full bg-[var(--color-public)] px-2 py-1 font-medium text-white hover:opacity-90 disabled:opacity-50"
          title={faucetReady ? 'Faucet → public balance' : 'Faucet not configured'}
        >
          +10k pub
        </button>
        <button
          onClick={() => onFaucet('private')}
          disabled={busy || !faucetReady}
          className="rounded-full bg-[var(--color-private)] px-2 py-1 font-medium text-white hover:opacity-90 disabled:opacity-50"
          title={faucetReady ? 'Faucet → private note' : 'Faucet not configured'}
        >
          +10k priv
        </button>
        <button
          onClick={onShield}
          disabled={busy || pub === 0n}
          className="rounded-full border border-violet-300 bg-violet-50 px-2 py-1 font-medium text-violet-800 hover:bg-violet-100 disabled:opacity-50"
          title={pub > 0n ? 'transfer_to_private — pub → priv' : `No public ${sym}`}
        >
          shield {fmt(pub)} →
        </button>
        <button
          onClick={onUnshield}
          disabled={busy || priv === 0n}
          className="rounded-full border border-sky-300 bg-sky-50 px-2 py-1 font-medium text-sky-800 hover:bg-sky-100 disabled:opacity-50"
          title={priv > 0n ? 'transfer_to_public — priv → pub' : `No private ${sym}`}
        >
          ← unshield {fmt(priv)}
        </button>
      </div>
    </div>
  )
}

function fmt(n: bigint): string {
  return Number(n).toLocaleString('en-US')
}

function shortAddr(a: string): string {
  return `${a.slice(0, 10)}…${a.slice(-6)}`
}

function shortHex(s: string): string {
  if (s.length <= 14) return s
  return `${s.slice(0, 10)}…${s.slice(-4)}`
}

function formatError(e: unknown): string {
  if (e instanceof Error) return `${e.name}: ${e.message}`
  return String(e)
}
