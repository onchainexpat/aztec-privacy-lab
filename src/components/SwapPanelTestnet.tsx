import { useEffect, useRef, useState } from 'react'
import { initTestnetClient, type TestnetClient } from '../lib/browser-testnet'
import type { SandboxState } from '../lib/sandbox-state'
import { NETWORKS } from '../lib/network'
import { faucetMint, isFaucetConfigured } from '../lib/faucet'
import { captureProofLog, type ProofEvent } from '../lib/proof-log'
import { useProofTimer } from '../lib/proof-timer'
import { ProofTimer } from './ui/ProofTimer'
import {
  spotPrice,
  effectivePrice,
  priceImpact,
  formatPrice,
  formatPct,
} from '../lib/amm-math'
import type { ConnectedAccount } from '../lib/wallet'

interface Props {
  state: SandboxState
  azguardAccount: ConnectedAccount | null
  onClose: () => void
}

interface Balances {
  privateAZA: bigint
  publicAZA: bigint
  privateAZB: bigint
  publicAZB: bigint
}

// Smaller swap amount so meaningful price impact shows up against the
// ~200 azETH / 500 k azUSDC medium pool. 1 azETH ≈ $2,500 — realistic retail
// trade size; ~0.5 % price impact at $1 M pool depth.
const SWAP_IN = 1n

export function SwapPanelTestnet({ state, azguardAccount, onClose }: Props) {
  const [progress, setProgress] = useState<string | null>(null)
  const [client, setClient] = useState<TestnetClient | null>(null)
  const [error, setError] = useState<string | null>(null)
  const [result, setResult] = useState<string | null>(null)
  const [busy, setBusy] = useState(false)
  const [balances, setBalances] = useState<Balances | null>(null)
  const [reserves, setReserves] = useState<{ aza: bigint; azb: bigint } | null>(null)
  const [quote, setQuote] = useState<bigint | null>(null)
  const [pendingMint, setPendingMint] = useState<string | null>(null)
  const [proofLog, setProofLog] = useState<ProofEvent[]>([])
  const logScrollRef = useRef<HTMLDivElement | null>(null)

  const cfg = NETWORKS.testnet
  const t0sym = state.token0.symbol
  const t1sym = state.token1.symbol
  const faucetReady = isFaucetConfigured()
  const proofTimer = useProofTimer(proofLog)

  function pushProofEvent(ev: ProofEvent) {
    setProofLog((prev) => {
      const next = prev.concat(ev)
      return next.length > 100 ? next.slice(next.length - 100) : next
    })
  }
  function pushNote(message: string) {
    pushProofEvent({ ts: Date.now(), kind: 'note', source: 'dashboard', message })
  }

  useEffect(() => {
    const el = logScrollRef.current
    if (el) el.scrollTop = el.scrollHeight
  }, [proofLog])

  useEffect(() => {
    if (!client) return
    void refreshAll(client)
  }, [client])

  useEffect(() => {
    if (!client || !pendingMint) return
    const id = window.setInterval(() => {
      void refreshAll(client)
    }, 15_000)
    return () => window.clearInterval(id)
  }, [client, pendingMint])

  async function refreshAll(c: TestnetClient) {
    if (!c.amm) return
    try {
      const [pA, uA, pB, uB, r0, r1] = await Promise.all([
        c.token0.methods.balance_of_private(c.address).simulate({ from: c.address }),
        c.token0.methods.balance_of_public(c.address).simulate({ from: c.address }),
        c.token1.methods.balance_of_private(c.address).simulate({ from: c.address }),
        c.token1.methods.balance_of_public(c.address).simulate({ from: c.address }),
        c.token0.methods.balance_of_public(c.amm.address).simulate({ from: c.address }),
        c.token1.methods.balance_of_public(c.amm.address).simulate({ from: c.address }),
      ])
      const next: Balances = {
        privateAZA: pA.result as bigint,
        publicAZA: uA.result as bigint,
        privateAZB: pB.result as bigint,
        publicAZB: uB.result as bigint,
      }
      setBalances(next)
      const aza = r0.result as bigint
      const azb = r1.result as bigint
      setReserves({ aza, azb })
      if (aza > 0n && azb > 0n) {
        const q = (await c.amm.methods
          .get_amount_out_for_exact_in(aza, azb, SWAP_IN)
          .simulate({ from: c.address })).result as bigint
        setQuote(q)
      } else {
        setQuote(null)
      }
      if (pendingMint && next.privateAZA > 0n) setPendingMint(null)
    } catch {
      // transient
    }
  }

  async function handleInit() {
    setError(null)
    setBusy(true)
    setProofLog([])
    const stopCapture = captureProofLog(pushProofEvent)
    try {
      const c = await initTestnetClient(state, (msg) => {
        setProgress(msg)
        pushNote(msg)
      })
      if (!c.amm) throw new Error('AMM not in testnet-state.json')
      setClient(c)
      if (c.freshAccount) {
        setResult(`Account deployed at ${shortAddr(c.address.toString())}.`)
      }
    } catch (e) {
      setError(formatError(e))
    } finally {
      stopCapture()
      setBusy(false)
    }
  }

  async function handleShield() {
    if (!client || !balances) return
    setError(null)
    setBusy(true)
    setResult(null)
    const amount = balances.publicAZA // shield all available public azETH
    pushNote(`transfer_to_private — shielding ${amount} ${t0sym} pub → priv (real proof ~40 s)`)
    const stopCapture = captureProofLog(pushProofEvent)
    try {
      // transfer_to_private(to, amount) — msg_sender is implicit; pulls from
      // caller's own public balance and mints a fresh private note to `to`.
      // No PublicAuthwit needed because msg_sender == the public-balance owner.
      await client.token0.methods
        .transfer_to_private(client.address, amount)
        .send({ from: client.address, fee: client.feeOpts })
      setResult(
        `Shielded ${fmt(amount)} ${t0sym} — your public balance dropped to 0 and an equivalent ` +
          `private note was minted to your address. The same observer that watched the original ` +
          `faucet mint can no longer track this balance through subsequent swaps.`,
      )
      await refreshAll(client)
    } catch (e) {
      setError(formatError(e))
    } finally {
      stopCapture()
      setBusy(false)
    }
  }

  async function handleFaucet() {
    if (!client) return
    setError(null)
    setBusy(true)
    setResult(null)
    pushNote('requesting 10k azETH (private) from faucet — ~40 s for the proof')
    try {
      const resp = await faucetMint(client.address.toString(), 'AZA', { private: true })
      setPendingMint(resp.txHash)
      pushNote(`faucet tx submitted: ${shortHex(resp.txHash)}`)
      setResult(
        `Faucet mint submitted (private note): ${resp.amount} ${t0sym} → your account. tx ${shortHex(resp.txHash)}.`,
      )
    } catch (e) {
      setError(formatError(e))
    } finally {
      setBusy(false)
    }
  }

  async function handleSwap() {
    if (!client?.amm || !quote) return
    setError(null)
    setBusy(true)
    setResult(null)
    pushNote(`swap_exact_tokens_for_tokens — proving private call (${SWAP_IN} ${t0sym} → ~${quote} ${t1sym})`)
    const stopCapture = captureProofLog(pushProofEvent)
    try {
      const { Fr } = await import('@aztec/aztec.js/fields')
      const nonce = Fr.random()
      const authwit = await client.wallet.createAuthWit(client.address, {
        caller: client.amm.address,
        call: await client.token0.methods
          .transfer_to_public(client.address, client.amm.address, SWAP_IN, nonce)
          .getFunctionCall(),
      })
      await client.amm.methods
        .swap_exact_tokens_for_tokens(
          client.token0.address,
          client.token1.address,
          SWAP_IN,
          quote,
          nonce,
        )
        .send({ from: client.address, fee: client.feeOpts, authWitnesses: [authwit] })
      setResult(
        `Swapped ${SWAP_IN} ${t0sym} → ~${quote} ${t1sym}. ` +
          `Reserves stay public so anyone can price-check; your address never appears in the AMM's public state — the swap call comes from your private note.`,
      )
      await refreshAll(client)
    } catch (e) {
      setError(formatError(e))
    } finally {
      stopCapture()
      setBusy(false)
    }
  }

  const enoughPrivate = balances && balances.privateAZA >= SWAP_IN
  const haveReserves = reserves && reserves.aza > 0n && reserves.azb > 0n

  return (
    <section className="mt-10 rounded-2xl border border-black/10 bg-white p-6">
      <div className="flex items-center justify-between">
        <h3 className="text-lg font-semibold">AMM swap — variant a (testnet)</h3>
        <button onClick={onClose} className="text-sm text-black/50 underline-offset-4 hover:underline">
          Close
        </button>
      </div>

      <p className="mt-2 text-sm text-black/60">
        Bundled <code className="font-mono text-xs">AMM</code> contract — Uniswap V2 math.
        Reserves are <strong>public</strong> (anyone can compute the price), amounts in/out
        are <strong>private</strong> (your address never appears in the swap's public state).
        Each swap pulls from your private note and mints a new private note for the output.
      </p>

      <AccountModeBanner azguardAccount={azguardAccount} />

      {state.amm && (
        <dl className="mt-3 grid grid-cols-1 gap-x-6 gap-y-1 text-xs md:grid-cols-2">
          <dt className="text-black/40">AMM contract</dt>
          <dd className="font-mono">
            <a
              href={`${cfg.explorerUrl}/contracts/${state.amm.address}`}
              target="_blank"
              rel="noreferrer"
              className="underline-offset-4 hover:underline"
            >
              {state.amm.address.slice(0, 16)}… ↗
            </a>
          </dd>
          <dt className="text-black/40">pair</dt>
          <dd className="font-mono">{t0sym} / {t1sym}</dd>
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
        </div>
      ) : (
        <>
          <div className="mt-5 rounded-xl border border-sky-200 bg-sky-50/50 p-4 text-sm">
            <div className="flex flex-wrap items-center gap-x-6 gap-y-2">
              <div>
                <p className="text-xs uppercase tracking-wide text-sky-900/60">your account</p>
                <p className="mt-0.5 font-mono text-sky-950">{shortAddr(client.address.toString())}</p>
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
            </div>
          </div>

          {balances && (
            <div className="mt-3 grid grid-cols-1 gap-3 rounded-xl border border-black/10 bg-zinc-50 p-3 text-sm md:grid-cols-2">
              <Stat label={`${t0sym} balance`} privAmt={balances.privateAZA} pubAmt={balances.publicAZA} />
              <Stat label={`${t1sym} balance`} privAmt={balances.privateAZB} pubAmt={balances.publicAZB} />
            </div>
          )}

          <div className="mt-3 rounded-xl border border-emerald-200 bg-emerald-50/60 p-3 text-xs text-emerald-900">
            <p className="font-medium">Pool state (public)</p>
            {reserves ? (
              <>
                <p className="mt-1 font-mono">
                  reserves: {fmt(reserves.aza)} {t0sym} · {fmt(reserves.azb)} {t1sym}
                </p>
                <p className="mt-1 text-emerald-800/80">
                  AMM spot price: 1 {t0sym} ≈{' '}
                  <span className="font-mono">{formatPrice(spotPrice(reserves.aza, reserves.azb))}</span>{' '}
                  {t1sym}
                </p>
                {quote !== null && (
                  <div className="mt-2 grid grid-cols-1 gap-1 rounded-lg border border-emerald-200 bg-white/60 p-2 sm:grid-cols-3">
                    <div>
                      <p className="text-[10px] uppercase tracking-wide text-emerald-900/50">
                        you send
                      </p>
                      <p className="font-mono">{fmt(SWAP_IN)} {t0sym}</p>
                    </div>
                    <div>
                      <p className="text-[10px] uppercase tracking-wide text-emerald-900/50">
                        you receive
                      </p>
                      <p className="font-mono">~{fmt(quote)} {t1sym}</p>
                      <p className="text-[10px] text-emerald-700/70">
                        effective rate{' '}
                        {formatPrice(effectivePrice(SWAP_IN, quote))} {t1sym}/{t0sym}
                      </p>
                    </div>
                    <div>
                      <p className="text-[10px] uppercase tracking-wide text-emerald-900/50">
                        price impact
                      </p>
                      <p className="font-mono">
                        {formatPct(priceImpact(SWAP_IN, reserves.aza, reserves.azb))}
                      </p>
                      <p className="text-[10px] text-emerald-700/70">0.3% pool fee included</p>
                    </div>
                  </div>
                )}
              </>
            ) : (
              <p className="mt-1 font-mono">loading…</p>
            )}
            {!haveReserves && reserves !== null && (
              <p className="mt-1 text-amber-900">
                Pool is empty — waiting on admin to seed initial liquidity. The swap demo
                won't run until reserves are non-zero. (If the page just loaded, give it a few
                blocks — the seed tx may still be mining.)
              </p>
            )}
          </div>

          <ProofTimer state={proofTimer} label={proofTimer.proving ? 'swap' : 'last swap proof'} />

          <div className="mt-4 flex flex-wrap items-center gap-3">
            <button
              onClick={handleFaucet}
              disabled={busy || !faucetReady || !!pendingMint || !balances || !reserves}
              className="rounded-full bg-[var(--color-private)] px-4 py-2 text-sm font-medium text-white hover:opacity-90 disabled:opacity-50"
              title={
                !faucetReady
                  ? 'Faucet URL not configured — set VITE_FAUCET_URL'
                  : !balances || !reserves
                    ? 'Waiting for PXE to sync balances + pool reserves…'
                    : ''
              }
            >
              {pendingMint
                ? 'Faucet mint pending…'
                : !balances || !reserves
                  ? 'Syncing balances…'
                  : faucetReady
                    ? `Request 10k ${t0sym} (private) from faucet`
                    : 'Faucet not configured'}
            </button>
            <button
              onClick={handleShield}
              disabled={busy || !balances || balances.publicAZA === 0n}
              className="rounded-full border border-[var(--color-private)] bg-white px-4 py-2 text-sm font-medium text-[var(--color-private)] hover:bg-[var(--color-private)]/5 disabled:opacity-50"
              title={
                !balances
                  ? 'Waiting for PXE to sync balances…'
                  : balances.publicAZA > 0n
                    ? `Convert your ${fmt(balances.publicAZA)} public ${t0sym} into a private note via Token.transfer_to_private`
                    : `No public ${t0sym} to shield — request one from the faucet first`
              }
            >
              {!balances
                ? 'Syncing…'
                : balances.publicAZA > 0n
                  ? `Shield ${fmt(balances.publicAZA)} ${t0sym} (pub → priv)`
                  : `Shield ${t0sym} (pub → priv)`}
            </button>
            <button
              onClick={handleSwap}
              disabled={busy || !enoughPrivate || !haveReserves || !quote}
              className="rounded-full border border-[var(--color-private)] bg-[var(--color-private)]/5 px-4 py-2 text-sm font-medium text-[var(--color-private)] hover:bg-[var(--color-private)]/10 disabled:opacity-50"
              title={
                !enoughPrivate
                  ? `Need at least ${SWAP_IN} private ${t0sym} — use the faucet first`
                  : !haveReserves
                    ? 'Pool empty — wait for liquidity'
                    : ''
              }
            >
              Swap {SWAP_IN} {t0sym} → {t1sym} privately
            </button>
            {busy && progress && <span className="text-xs text-black/50">{progress}</span>}
          </div>
        </>
      )}

      {proofLog.length > 0 && (
        <details className="mt-4" open>
          <summary className="cursor-pointer text-xs text-black/60 hover:underline">
            proof log ({proofLog.length} events)
          </summary>
          <div
            ref={logScrollRef}
            className="mt-2 max-h-56 overflow-auto rounded-lg border border-black/10 bg-zinc-950 p-3 font-mono text-[11px] leading-relaxed text-zinc-100"
          >
            {proofLog.map((ev, i) => (
              <div key={i} className="flex gap-3">
                <span className="shrink-0 text-zinc-500">
                  {new Date(ev.ts).toLocaleTimeString('en-US', { hour12: false })}
                </span>
                <span
                  className={`shrink-0 ${ev.kind === 'note' ? 'text-amber-300' : 'text-sky-300'}`}
                >
                  {ev.source}
                </span>
                <span className="text-zinc-100">{ev.message}</span>
              </div>
            ))}
          </div>
        </details>
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

function AccountModeBanner({ azguardAccount }: { azguardAccount: ConnectedAccount | null }) {
  if (!azguardAccount) {
    return (
      <div className="mt-3 rounded-xl border border-zinc-200 bg-zinc-50 p-3 text-xs text-zinc-700">
        <p className="font-medium text-zinc-900">Demo mode — no wallet connected</p>
        <p className="mt-1">
          Uses the same per-tab Schnorr account as the ld2 / voting panels. Connect Azguard
          in the header if you want your real wallet (informational only today; Azguard
          routing is in progress).
        </p>
      </div>
    )
  }
  return (
    <div className="mt-3 rounded-xl border border-sky-200 bg-sky-50/60 p-3 text-xs text-sky-900">
      <p className="font-medium">Azguard connected · {shortAddr(azguardAccount.address)}</p>
      <p className="mt-1 text-sky-900/80">
        Demo still uses the per-tab account for tx submission. Azguard routing pending.
      </p>
    </div>
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

function shortHex(s: string): string {
  if (s.length <= 14) return s
  return `${s.slice(0, 10)}…${s.slice(-4)}`
}

function formatError(e: unknown): string {
  if (e instanceof Error) return `${e.name}: ${e.message}`
  return String(e)
}
