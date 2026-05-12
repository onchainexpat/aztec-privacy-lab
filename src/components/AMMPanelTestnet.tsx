import { useEffect, useRef, useState } from 'react'
import {
  getResolvedTestnetClient,
  subscribeTestnetClient,
  type TestnetClient,
} from '../lib/browser-testnet'
import type { SandboxState } from '../lib/sandbox-state'
import { NETWORKS } from '../lib/network'
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

interface Props {
  state: SandboxState
  /** Which variant the visitor clicked — affects which section is highlighted. */
  initialFocus?: 'swap' | 'lp'
  onClose: () => void
}

interface Balances {
  privETH: bigint
  pubETH: bigint
  privUSDC: bigint
  pubUSDC: bigint
  lp: bigint
}

interface Reserves {
  aza: bigint
  azb: bigint
}

const SWAP_IN = 1n
const ADD_ETH = 1n
const ADD_USDC = 2500n

export function AMMPanelTestnet({ state, initialFocus = 'swap', onClose }: Props) {
  const [client, setClient] = useState<TestnetClient | null>(getResolvedTestnetClient())
  const [error, setError] = useState<string | null>(null)
  const [result, setResult] = useState<string | null>(null)
  const [busy, setBusy] = useState(false)
  const [busyKind, setBusyKind] = useState<'swap' | 'add' | 'remove' | null>(null)
  const [balances, setBalances] = useState<Balances | null>(null)
  const [reserves, setReserves] = useState<Reserves | null>(null)
  const [quote, setQuote] = useState<bigint | null>(null)
  const [lpTotalSupply, setLpTotalSupply] = useState<bigint | null>(null)
  const [proofLog, setProofLog] = useState<ProofEvent[]>([])
  const logScrollRef = useRef<HTMLDivElement | null>(null)

  const cfg = NETWORKS.testnet
  const t0sym = state.token0.symbol
  const t1sym = state.token1.symbol
  const lpSym = state.lpToken?.symbol ?? 'LP'
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

  useEffect(() => subscribeTestnetClient(setClient), [])

  useEffect(() => {
    const el = logScrollRef.current
    if (el) el.scrollTop = el.scrollHeight
  }, [proofLog])

  useEffect(() => {
    if (!client) return
    void refreshAll(client)
    const id = window.setInterval(() => void refreshAll(client), 20_000)
    return () => window.clearInterval(id)
  }, [client])

  async function refreshAll(c: TestnetClient) {
    if (!c.amm || !c.lpToken) return
    try {
      const [pETH, uETH, pUSDC, uUSDC, lpBal, r0, r1, lpSupply] = await Promise.all([
        c.token0.methods.balance_of_private(c.address).simulate({ from: c.address }),
        c.token0.methods.balance_of_public(c.address).simulate({ from: c.address }),
        c.token1.methods.balance_of_private(c.address).simulate({ from: c.address }),
        c.token1.methods.balance_of_public(c.address).simulate({ from: c.address }),
        c.lpToken.methods.balance_of_private(c.address).simulate({ from: c.address }),
        c.token0.methods.balance_of_public(c.amm.address).simulate({ from: c.address }),
        c.token1.methods.balance_of_public(c.amm.address).simulate({ from: c.address }),
        c.lpToken.methods.total_supply().simulate({ from: c.address }),
      ])
      setBalances({
        privETH: pETH.result as bigint,
        pubETH: uETH.result as bigint,
        privUSDC: pUSDC.result as bigint,
        pubUSDC: uUSDC.result as bigint,
        lp: lpBal.result as bigint,
      })
      const aza = r0.result as bigint
      const azb = r1.result as bigint
      setReserves({ aza, azb })
      setLpTotalSupply(lpSupply.result as bigint)
      if (aza > 0n && azb > 0n) {
        const q = (await c.amm.methods
          .get_amount_out_for_exact_in(aza, azb, SWAP_IN)
          .simulate({ from: c.address })).result as bigint
        setQuote(q)
      }
    } catch {
      // transient
    }
  }

  async function handleSwap() {
    if (!client?.amm || !quote) return
    setError(null)
    setResult(null)
    setBusy(true)
    setBusyKind('swap')
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
        `Swapped ${SWAP_IN} ${t0sym} → ~${quote} ${t1sym}. Reserves are public; your address never appears in the AMM's public state.`,
      )
      await refreshAll(client)
    } catch (e) {
      setError(formatError(e))
    } finally {
      stopCapture()
      setBusy(false)
      setBusyKind(null)
    }
  }

  async function handleAddLiquidity() {
    if (!client?.amm) return
    setError(null)
    setResult(null)
    setBusy(true)
    setBusyKind('add')
    pushNote(`add_liquidity(${ADD_ETH} ${t0sym}, ${ADD_USDC} ${t1sym}) — building authwits + proving`)
    const stopCapture = captureProofLog(pushProofEvent)
    try {
      const { Fr } = await import('@aztec/aztec.js/fields')
      const nonce = Fr.random()
      const [aw0, aw1] = await Promise.all([
        client.wallet.createAuthWit(client.address, {
          caller: client.amm.address,
          call: await client.token0.methods
            .transfer_to_public_and_prepare_private_balance_increase(
              client.address,
              client.amm.address,
              ADD_ETH,
              nonce,
            )
            .getFunctionCall(),
        }),
        client.wallet.createAuthWit(client.address, {
          caller: client.amm.address,
          call: await client.token1.methods
            .transfer_to_public_and_prepare_private_balance_increase(
              client.address,
              client.amm.address,
              ADD_USDC,
              nonce,
            )
            .getFunctionCall(),
        }),
      ])
      await client.amm.methods
        .add_liquidity(ADD_ETH, ADD_USDC, ADD_ETH, ADD_USDC, nonce)
        .send({ from: client.address, fee: client.feeOpts, authWitnesses: [aw0, aw1] })
      setResult(
        `Added ${ADD_ETH} ${t0sym} + ${ADD_USDC} ${t1sym}. LP shares minted as a private note — only you know your position size.`,
      )
      await refreshAll(client)
    } catch (e) {
      setError(formatError(e))
    } finally {
      stopCapture()
      setBusy(false)
      setBusyKind(null)
    }
  }

  async function handleRemoveLiquidity() {
    if (!client?.amm || !client.lpToken) return
    if (!balances || balances.lp === 0n) {
      setError('No LP shares to burn.')
      return
    }
    setError(null)
    setResult(null)
    setBusy(true)
    setBusyKind('remove')
    const burnAmt = balances.lp
    pushNote(`remove_liquidity(${burnAmt} ${lpSym}) — burning all LP`)
    const stopCapture = captureProofLog(pushProofEvent)
    try {
      const { Fr } = await import('@aztec/aztec.js/fields')
      const nonce = Fr.random()
      const authwit = await client.wallet.createAuthWit(client.address, {
        caller: client.amm.address,
        call: await client.lpToken.methods
          .transfer_to_public(client.address, client.amm.address, burnAmt, nonce)
          .getFunctionCall(),
      })
      await client.amm.methods
        .remove_liquidity(burnAmt, 1n, 1n, nonce)
        .send({ from: client.address, fee: client.feeOpts, authWitnesses: [authwit] })
      setResult(`Burned ${fmt(burnAmt)} ${lpSym}. Underlying ${t0sym} + ${t1sym} returned as private notes.`)
      await refreshAll(client)
    } catch (e) {
      setError(formatError(e))
    } finally {
      stopCapture()
      setBusy(false)
      setBusyKind(null)
    }
  }

  return (
    <section className="mt-10 rounded-2xl border border-black/10 bg-white p-6">
      <div className="flex items-center justify-between">
        <h3 className="text-lg font-semibold">
          AMM — swap (variant a) + liquidity (variant f) on testnet
        </h3>
        <button onClick={onClose} className="text-sm text-black/50 underline-offset-4 hover:underline">
          Close
        </button>
      </div>

      <p className="mt-2 text-sm text-black/60">
        Bundled Uniswap V2-style AMM. Pool reserves are <strong>public</strong>; swap amounts
        and LP shares are <strong>private notes</strong>. Same contract, same pool — variant
        a is the swap path, variant f is the liquidity path.
      </p>

      {state.amm && state.lpToken && (
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
          <dt className="text-black/40">LP token</dt>
          <dd className="font-mono">
            <a
              href={`${cfg.explorerUrl}/contracts/${state.lpToken.address}`}
              target="_blank"
              rel="noreferrer"
              className="underline-offset-4 hover:underline"
            >
              {state.lpToken.address.slice(0, 16)}… ↗
            </a>
          </dd>
        </dl>
      )}

      {!client ? (
        <NotInitialized />
      ) : (
        <>
          {reserves && (
            <div className="mt-4 rounded-xl border border-emerald-200 bg-emerald-50/60 p-3 text-xs text-emerald-900">
              <p className="font-medium">Pool state (public)</p>
              <p className="mt-1 font-mono">
                {fmt(reserves.aza)} {t0sym} · {fmt(reserves.azb)} {t1sym}
              </p>
              <p className="mt-1 text-emerald-800/80">
                spot 1 {t0sym} ≈{' '}
                <span className="font-mono">{formatPrice(spotPrice(reserves.aza, reserves.azb))}</span>{' '}
                {t1sym}
                {lpTotalSupply !== null && (
                  <>
                    {' · '}LP supply <span className="font-mono">{fmt(lpTotalSupply)}</span>
                  </>
                )}
                {balances && lpTotalSupply !== null && lpTotalSupply > 0n && balances.lp > 0n && (
                  <>
                    {' · '}your share{' '}
                    <span className="font-mono">
                      {((Number(balances.lp) / Number(lpTotalSupply)) * 100).toFixed(4)}%
                    </span>
                  </>
                )}
              </p>
            </div>
          )}

          {balances && (
            <div className="mt-3 grid grid-cols-1 gap-3 rounded-xl border border-black/10 bg-zinc-50 p-3 text-sm md:grid-cols-3">
              <Stat label={`${t0sym} (private)`} amount={balances.privETH} />
              <Stat label={`${t1sym} (private)`} amount={balances.privUSDC} />
              <Stat label={`${lpSym} (private note)`} amount={balances.lp} />
            </div>
          )}

          <ProofTimer state={proofTimer} label={busyKind ?? undefined} />

          <SectionSwap
            t0sym={t0sym}
            t1sym={t1sym}
            quote={quote}
            reserves={reserves}
            enough={!!balances && balances.privETH >= SWAP_IN}
            onSwap={handleSwap}
            busy={busy}
            focused={initialFocus === 'swap'}
          />

          <SectionLP
            t0sym={t0sym}
            t1sym={t1sym}
            lpSym={lpSym}
            balances={balances}
            onAdd={handleAddLiquidity}
            onRemove={handleRemoveLiquidity}
            busy={busy}
            focused={initialFocus === 'lp'}
          />
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
                <span className={`shrink-0 ${ev.kind === 'note' ? 'text-amber-300' : 'text-sky-300'}`}>
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

function SectionSwap({
  t0sym,
  t1sym,
  quote,
  reserves,
  enough,
  onSwap,
  busy,
  focused,
}: {
  t0sym: string
  t1sym: string
  quote: bigint | null
  reserves: Reserves | null
  enough: boolean
  onSwap: () => void
  busy: boolean
  focused: boolean
}) {
  return (
    <div
      className={`mt-4 rounded-xl border p-4 ${focused ? 'border-violet-300 bg-violet-50/40' : 'border-black/10 bg-white'}`}
    >
      <div className="flex items-baseline justify-between">
        <h4 className="text-sm font-semibold">Variant a · private swap</h4>
        <p className="text-[11px] text-black/40">
          private balance → swap_exact_tokens_for_tokens → private note out
        </p>
      </div>
      {quote !== null && reserves && (
        <div className="mt-2 grid grid-cols-1 gap-1 rounded-lg border border-emerald-200 bg-white p-2 text-xs sm:grid-cols-3">
          <div>
            <p className="text-[10px] uppercase tracking-wide text-emerald-900/50">you send</p>
            <p className="font-mono">{fmt(SWAP_IN)} {t0sym}</p>
          </div>
          <div>
            <p className="text-[10px] uppercase tracking-wide text-emerald-900/50">you receive</p>
            <p className="font-mono">~{fmt(quote)} {t1sym}</p>
            <p className="text-[10px] text-emerald-700/70">
              rate {formatPrice(effectivePrice(SWAP_IN, quote))} {t1sym}/{t0sym}
            </p>
          </div>
          <div>
            <p className="text-[10px] uppercase tracking-wide text-emerald-900/50">price impact</p>
            <p className="font-mono">
              {formatPct(priceImpact(SWAP_IN, reserves.aza, reserves.azb))}
            </p>
            <p className="text-[10px] text-emerald-700/70">incl. 0.3% pool fee</p>
          </div>
        </div>
      )}
      <button
        onClick={onSwap}
        disabled={busy || !enough || !quote}
        className="mt-3 rounded-full bg-[var(--color-private)] px-4 py-2 text-sm font-medium text-white hover:opacity-90 disabled:opacity-50"
        title={!enough ? `Need ≥${SWAP_IN} private ${t0sym} — see wallet panel above` : ''}
      >
        Swap {SWAP_IN} {t0sym} → {t1sym} privately
      </button>
    </div>
  )
}

function SectionLP({
  t0sym,
  t1sym,
  lpSym,
  balances,
  onAdd,
  onRemove,
  busy,
  focused,
}: {
  t0sym: string
  t1sym: string
  lpSym: string
  balances: Balances | null
  onAdd: () => void
  onRemove: () => void
  busy: boolean
  focused: boolean
}) {
  const enoughForAdd =
    balances && balances.privETH >= ADD_ETH && balances.privUSDC >= ADD_USDC
  const hasLP = !!balances && balances.lp > 0n
  return (
    <div
      className={`mt-4 rounded-xl border p-4 ${focused ? 'border-violet-300 bg-violet-50/40' : 'border-black/10 bg-white'}`}
    >
      <div className="flex items-baseline justify-between">
        <h4 className="text-sm font-semibold">Variant f · private LP</h4>
        <p className="text-[11px] text-black/40">
          add_liquidity / remove_liquidity — LP share is a private note
        </p>
      </div>
      <div className="mt-3 flex flex-wrap items-center gap-3 text-xs">
        <button
          onClick={onAdd}
          disabled={busy || !enoughForAdd || !balances}
          className="rounded-full bg-[var(--color-private)] px-4 py-2 text-sm font-medium text-white hover:opacity-90 disabled:opacity-50"
          title={
            !balances
              ? 'Syncing…'
              : enoughForAdd
                ? ''
                : `Need ≥${ADD_ETH} private ${t0sym} and ≥${ADD_USDC} private ${t1sym} — see wallet panel above`
          }
        >
          {!balances
            ? 'Syncing…'
            : `Add ${ADD_ETH} ${t0sym} + ${ADD_USDC} ${t1sym}`}
        </button>
        <button
          onClick={onRemove}
          disabled={busy || !hasLP}
          className="rounded-full border border-[var(--color-private)] bg-[var(--color-private)]/5 px-4 py-2 text-sm font-medium text-[var(--color-private)] hover:bg-[var(--color-private)]/10 disabled:opacity-50"
          title={hasLP ? `Burn all ${balances!.lp} ${lpSym}` : 'No LP yet'}
        >
          {hasLP ? `Burn ${fmt(balances!.lp)} ${lpSym}` : `Remove ${lpSym}`}
        </button>
      </div>
    </div>
  )
}

function NotInitialized() {
  return (
    <div className="mt-4 rounded-xl border border-amber-200 bg-amber-50/60 p-4 text-sm text-amber-900">
      <p className="font-medium">Wallet not initialized yet</p>
      <p className="mt-1 text-amber-900/80">
        Scroll up to the <strong>Your testnet wallet</strong> panel and click{' '}
        <strong>Initialize wallet</strong>. Once your account is deployed, this panel will
        sync automatically — no separate init needed per demo.
      </p>
    </div>
  )
}

function Stat({ label, amount }: { label: string; amount: bigint }) {
  return (
    <div>
      <p className="text-xs uppercase tracking-wide text-black/40">{label}</p>
      <p className="mt-0.5 font-mono text-violet-700">
        <span className="inline-block size-1.5 rounded-full bg-violet-500" /> {fmt(amount)}
      </p>
    </div>
  )
}

function fmt(n: bigint): string {
  return Number(n).toLocaleString('en-US')
}

function formatError(e: unknown): string {
  if (e instanceof Error) return `${e.name}: ${e.message}`
  return String(e)
}
