import { useEffect, useRef, useState } from 'react'
import { initTestnetClient, type TestnetClient } from '../lib/browser-testnet'
import type { SandboxState } from '../lib/sandbox-state'
import { NETWORKS } from '../lib/network'
import { captureProofLog, type ProofEvent } from '../lib/proof-log'
import { useProofTimer } from '../lib/proof-timer'
import { ProofTimer } from './ui/ProofTimer'
import { spotPrice, formatPrice } from '../lib/amm-math'
import type { ConnectedAccount } from '../lib/wallet'

interface Props {
  state: SandboxState
  azguardAccount: ConnectedAccount | null
  onClose: () => void
}

interface Balances {
  privETH: bigint
  privUSDC: bigint
  lp: bigint
}

interface Reserves {
  aza: bigint
  azb: bigint
}

// Match the pool's seeded price ratio: 1 azETH = 2500 azUSDC.
const ADD_ETH = 1n
const ADD_USDC = 2500n

export function LPPanelTestnet({ state, azguardAccount, onClose }: Props) {
  const [progress, setProgress] = useState<string | null>(null)
  const [client, setClient] = useState<TestnetClient | null>(null)
  const [error, setError] = useState<string | null>(null)
  const [result, setResult] = useState<string | null>(null)
  const [busy, setBusy] = useState(false)
  const [balances, setBalances] = useState<Balances | null>(null)
  const [reserves, setReserves] = useState<Reserves | null>(null)
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

  useEffect(() => {
    const el = logScrollRef.current
    if (el) el.scrollTop = el.scrollHeight
  }, [proofLog])

  useEffect(() => {
    if (!client) return
    void refreshAll(client)
  }, [client])

  async function refreshAll(c: TestnetClient) {
    if (!c.amm || !c.lpToken) return
    try {
      const [pETH, pUSDC, lpBal, r0, r1, totalPub, totalPriv] = await Promise.all([
        c.token0.methods.balance_of_private(c.address).simulate({ from: c.address }),
        c.token1.methods.balance_of_private(c.address).simulate({ from: c.address }),
        c.lpToken.methods.balance_of_private(c.address).simulate({ from: c.address }),
        c.token0.methods.balance_of_public(c.amm.address).simulate({ from: c.address }),
        c.token1.methods.balance_of_public(c.amm.address).simulate({ from: c.address }),
        c.lpToken.methods.total_supply().simulate({ from: c.address }),
        // total_supply already covers both private + public minted; the
        // bundled Token tracks them together.
        Promise.resolve({ result: 0n }),
      ])
      setBalances({
        privETH: pETH.result as bigint,
        privUSDC: pUSDC.result as bigint,
        lp: lpBal.result as bigint,
      })
      setReserves({ aza: r0.result as bigint, azb: r1.result as bigint })
      setLpTotalSupply(totalPub.result as bigint)
      void totalPriv
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
      if (!c.amm || !c.lpToken) throw new Error('AMM or LP token missing in testnet-state.json')
      setClient(c)
      if (c.freshAccount) {
        setResult(`Account deployed — saved to localStorage.`)
      }
    } catch (e) {
      setError(formatError(e))
    } finally {
      stopCapture()
      setBusy(false)
    }
  }

  async function handleAddLiquidity() {
    if (!client?.amm) return
    setError(null)
    setBusy(true)
    setResult(null)
    pushNote(`add_liquidity(${ADD_ETH} ${t0sym}, ${ADD_USDC} ${t1sym}) — building authwits + proving private call`)
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
      // amount_min set to the max amounts — the pool is already balanced at
      // 1:2500, so providing the exact ratio works without slippage tolerance.
      await client.amm.methods
        .add_liquidity(ADD_ETH, ADD_USDC, ADD_ETH, ADD_USDC, nonce)
        .send({ from: client.address, fee: client.feeOpts, authWitnesses: [aw0, aw1] })
      setResult(
        `Added liquidity: ${ADD_ETH} ${t0sym} + ${ADD_USDC} ${t1sym}. ` +
          `LP shares minted as a private note — only you know the size of your position. ` +
          `Pool's public reserves bumped; observers see depth grow but can't link to you.`,
      )
      await refreshAll(client)
    } catch (e) {
      setError(formatError(e))
    } finally {
      stopCapture()
      setBusy(false)
    }
  }

  async function handleRemoveLiquidity() {
    if (!client?.amm || !client.lpToken) return
    if (!balances || balances.lp === 0n) {
      setError('No LP shares to burn. Add liquidity first.')
      return
    }
    setError(null)
    setBusy(true)
    setResult(null)
    const burnAmt = balances.lp
    pushNote(`remove_liquidity(${burnAmt} ${lpSym}) — burning all LP, real proof ~60 s`)
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
      setResult(
        `Burned ${fmt(burnAmt)} ${lpSym}. Underlying ${t0sym} + ${t1sym} returned to your ` +
          `private balances. Observers see reserves shrink; cannot tell whose position closed.`,
      )
      await refreshAll(client)
    } catch (e) {
      setError(formatError(e))
    } finally {
      stopCapture()
      setBusy(false)
    }
  }

  const enoughForAdd =
    balances && balances.privETH >= ADD_ETH && balances.privUSDC >= ADD_USDC
  const hasLP = balances && balances.lp > 0n

  return (
    <section className="mt-10 rounded-2xl border border-black/10 bg-white p-6">
      <div className="flex items-center justify-between">
        <h3 className="text-lg font-semibold">
          AMM liquidity — variant f (private LP) on testnet
        </h3>
        <button onClick={onClose} className="text-sm text-black/50 underline-offset-4 hover:underline">
          Close
        </button>
      </div>

      <p className="mt-2 text-sm text-black/60">
        Add or remove liquidity on the {t0sym}/{t1sym} pool. Pool reserves are{' '}
        <strong>public</strong>, but your LP share is a <strong>private note</strong> — only
        you know how much of the pool you own. Real ClientIVC proofs in your browser; fees
        paid by SponsoredFPC.
      </p>

      <AccountModeBanner azguardAccount={azguardAccount} />

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
            <div className="mt-3 grid grid-cols-1 gap-3 rounded-xl border border-black/10 bg-zinc-50 p-3 text-sm md:grid-cols-3">
              <Stat label={`${t0sym} (private)`} amount={balances.privETH} />
              <Stat label={`${t1sym} (private)`} amount={balances.privUSDC} />
              <Stat
                label={`${lpSym} shares (private note)`}
                amount={balances.lp}
                accent="violet"
              />
            </div>
          )}

          {reserves && (
            <div className="mt-3 rounded-xl border border-emerald-200 bg-emerald-50/60 p-3 text-xs text-emerald-900">
              <p className="font-medium">Pool state (public)</p>
              <p className="mt-1 font-mono">
                reserves: {fmt(reserves.aza)} {t0sym} · {fmt(reserves.azb)} {t1sym}
              </p>
              <p className="mt-1 text-emerald-800/80">
                spot price: 1 {t0sym} ≈{' '}
                <span className="font-mono">{formatPrice(spotPrice(reserves.aza, reserves.azb))}</span>{' '}
                {t1sym}
                {lpTotalSupply !== null && (
                  <>
                    {' · '}LP total supply: <span className="font-mono">{fmt(lpTotalSupply)}</span>
                  </>
                )}
              </p>
              {balances && lpTotalSupply !== null && lpTotalSupply > 0n && balances.lp > 0n && (
                <p className="mt-1 text-emerald-800/80">
                  your share:{' '}
                  <span className="font-mono">
                    {((Number(balances.lp) / Number(lpTotalSupply)) * 100).toFixed(4)}%
                  </span>{' '}
                  of the pool
                </p>
              )}
            </div>
          )}

          <ProofTimer state={proofTimer} label={proofTimer.proving ? 'liquidity op' : 'last LP proof'} />

          <div className="mt-4 flex flex-wrap items-center gap-3">
            <button
              onClick={handleAddLiquidity}
              disabled={busy || !enoughForAdd || !balances || !reserves}
              className="rounded-full bg-[var(--color-private)] px-4 py-2 text-sm font-medium text-white hover:opacity-90 disabled:opacity-50"
              title={
                !balances || !reserves
                  ? 'Waiting for PXE to sync…'
                  : !enoughForAdd
                    ? `Need ${ADD_ETH} private ${t0sym} + ${ADD_USDC} private ${t1sym} — use the wallet panel up top to faucet/shield`
                    : ''
              }
            >
              {!balances || !reserves
                ? 'Syncing balances…'
                : `Add ${ADD_ETH} ${t0sym} + ${ADD_USDC} ${t1sym} as private LP`}
            </button>
            <button
              onClick={handleRemoveLiquidity}
              disabled={busy || !hasLP}
              className="rounded-full border border-[var(--color-private)] bg-[var(--color-private)]/5 px-4 py-2 text-sm font-medium text-[var(--color-private)] hover:bg-[var(--color-private)]/10 disabled:opacity-50"
              title={hasLP ? `Burn all ${balances?.lp} LP, get ${t0sym}+${t1sym} back` : 'No LP to burn yet'}
            >
              {hasLP ? `Burn ${fmt(balances!.lp)} ${lpSym}` : `Remove all ${lpSym}`}
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
          Uses the per-tab Schnorr account from the wallet panel above. If you've initialized
          there, this panel reuses it instantly.
        </p>
      </div>
    )
  }
  return (
    <div className="mt-3 rounded-xl border border-sky-200 bg-sky-50/60 p-3 text-xs text-sky-900">
      <p className="font-medium">Azguard connected · {shortAddr(azguardAccount.address)}</p>
      <p className="mt-1 text-sky-900/80">
        Per-tab account still used for tx submission. Azguard routing pending.
      </p>
    </div>
  )
}

function Stat({
  label,
  amount,
  accent = 'default',
}: {
  label: string
  amount: bigint
  accent?: 'default' | 'violet'
}) {
  const dotClass = accent === 'violet' ? 'bg-violet-500' : 'bg-violet-500'
  const numClass = accent === 'violet' ? 'text-violet-700' : 'text-violet-700'
  return (
    <div>
      <p className="text-xs uppercase tracking-wide text-black/40">{label}</p>
      <p className={`mt-0.5 flex items-center gap-2 font-mono ${numClass}`}>
        <span className={`size-1.5 rounded-full ${dotClass}`} />
        {fmt(amount)}
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
