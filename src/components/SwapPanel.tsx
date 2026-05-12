import { useState } from 'react'
import { initBrowserSandbox, type BrowserSandbox } from '../lib/browser-sandbox'
import type { SandboxState } from '../lib/sandbox-state'

interface Props {
  variant: 'a' | 'c' | 'f'
  state: SandboxState
  onClose: () => void
}

interface Live {
  r0: bigint
  r1: bigint
  b0: bigint
  b1: bigint
  lp: bigint
}

export function SwapPanel({ variant, state, onClose }: Props) {
  const [progress, setProgress] = useState<string | null>(null)
  const [sandbox, setSandbox] = useState<BrowserSandbox | null>(null)
  const [error, setError] = useState<string | null>(null)
  const [actionResult, setActionResult] = useState<string | null>(null)
  const [live, setLive] = useState<Live | null>(null)
  const [busy, setBusy] = useState(false)

  async function refreshLive(sb: BrowserSandbox) {
    const [r0Res, r1Res, b0Res, b1Res, lpRes] = await Promise.all([
      sb.token0.methods.balance_of_public(sb.amm.address).simulate({ from: sb.admin }),
      sb.token1.methods.balance_of_public(sb.amm.address).simulate({ from: sb.admin }),
      sb.token0.methods.balance_of_private(sb.admin).simulate({ from: sb.admin }),
      sb.token1.methods.balance_of_private(sb.admin).simulate({ from: sb.admin }),
      sb.lpToken.methods.balance_of_private(sb.admin).simulate({ from: sb.admin }),
    ])
    setLive({
      r0: r0Res.result as bigint,
      r1: r1Res.result as bigint,
      b0: b0Res.result as bigint,
      b1: b1Res.result as bigint,
      lp: lpRes.result as bigint,
    })
  }

  async function handleInit() {
    setError(null)
    setBusy(true)
    try {
      const sb = await initBrowserSandbox(state, setProgress)
      setSandbox(sb)
      await refreshLive(sb)
    } catch (e) {
      setError(formatError(e))
    } finally {
      setBusy(false)
    }
  }

  async function handleSwap() {
    if (!sandbox) return
    setBusy(true)
    setError(null)
    setActionResult(null)
    try {
      const { Fr } = await import('@aztec/aztec.js/fields')
      const SWAP_IN = 1_000n
      const { admin, token0, token1, amm, wallet } = sandbox
      const nonce = Fr.random()
      const authwit = await wallet.createAuthWit(admin, {
        caller: amm.address,
        call: await token0.methods
          .transfer_to_public(admin, amm.address, SWAP_IN, nonce)
          .getFunctionCall(),
      })
      await amm.methods
        .swap_exact_tokens_for_tokens(token0.address, token1.address, SWAP_IN, 1n, nonce)
        .send({ from: admin, authWitnesses: [authwit] })
      setActionResult(`swap mined: ${SWAP_IN} ${state.token0.symbol} → ${state.token1.symbol}`)
      await refreshLive(sandbox)
    } catch (e) {
      setError(formatError(e))
    } finally {
      setBusy(false)
    }
  }

  async function handleAddLiquidity() {
    if (!sandbox) return
    setBusy(true)
    setError(null)
    setActionResult(null)
    try {
      const { Fr } = await import('@aztec/aztec.js/fields')
      const A0 = 10_000n
      const A1 = 20_000n // matches the seeded 1:2 price
      const { admin, token0, token1, amm, wallet } = sandbox
      const nonce = Fr.random()
      const [aw0, aw1] = await Promise.all([
        wallet.createAuthWit(admin, {
          caller: amm.address,
          call: await token0.methods
            .transfer_to_public_and_prepare_private_balance_increase(admin, amm.address, A0, nonce)
            .getFunctionCall(),
        }),
        wallet.createAuthWit(admin, {
          caller: amm.address,
          call: await token1.methods
            .transfer_to_public_and_prepare_private_balance_increase(admin, amm.address, A1, nonce)
            .getFunctionCall(),
        }),
      ])
      await amm.methods
        .add_liquidity(A0, A1, A0 / 2n, A1 / 2n, nonce)
        .send({ from: admin, authWitnesses: [aw0, aw1] })
      setActionResult(`added liquidity: ${A0} ${state.token0.symbol} + ${A1} ${state.token1.symbol}`)
      await refreshLive(sandbox)
    } catch (e) {
      setError(formatError(e))
    } finally {
      setBusy(false)
    }
  }

  async function handleCommit() {
    if (!sandbox?.wrapper) {
      setError('PrivateSwapWrapper not deployed — re-run npm run sandbox:setup.')
      return
    }
    setBusy(true)
    setError(null)
    setActionResult(null)
    try {
      const { Fr } = await import('@aztec/aztec.js/fields')
      const SECRET_AMOUNT = 1_337n
      const randomness = Fr.random()
      const { admin, wrapper } = sandbox

      const { result: openHash } = await wrapper.methods
        .open_commitment(SECRET_AMOUNT, randomness)
        .simulate({ from: admin })

      await wrapper.methods
        .commit_amount(SECRET_AMOUNT, randomness)
        .send({ from: admin })

      setActionResult(
        `committed to private amount ${SECRET_AMOUNT}; commitment hash ${String(openHash).slice(0, 18)}…`,
      )
    } catch (e) {
      setError(formatError(e))
    } finally {
      setBusy(false)
    }
  }

  async function handleRemoveLiquidity() {
    if (!sandbox) return
    if (!live || live.lp === 0n) {
      setError('No LP shares to burn. Add liquidity first.')
      return
    }
    setBusy(true)
    setError(null)
    setActionResult(null)
    try {
      const { Fr } = await import('@aztec/aztec.js/fields')
      const burnAmt = live.lp / 4n > 0n ? live.lp / 4n : live.lp
      const { admin, lpToken, amm, wallet } = sandbox
      const nonce = Fr.random()
      const authwit = await wallet.createAuthWit(admin, {
        caller: amm.address,
        call: await lpToken.methods
          .transfer_to_public(admin, amm.address, burnAmt, nonce)
          .getFunctionCall(),
      })
      await amm.methods
        .remove_liquidity(burnAmt, 1n, 1n, nonce)
        .send({ from: admin, authWitnesses: [authwit] })
      setActionResult(`removed liquidity: burned ${burnAmt} LP`)
      await refreshLive(sandbox)
    } catch (e) {
      setError(formatError(e))
    } finally {
      setBusy(false)
    }
  }

  const headline =
    variant === 'a'
      ? 'Variant a — private swap'
      : variant === 'f'
      ? 'Variant f — private liquidity provision'
      : 'Variant c — commitment-hidden swap'

  const blurb =
    variant === 'a'
      ? 'Anyone can see the swap amount in the public reserves delta; nobody can tell which account moved the funds.'
      : variant === 'f'
      ? 'Public pool depth, but your LP shares live as private notes — no one can attribute deposits to your address.'
      : 'A custom Noir contract (PrivateSwapWrapper) Pedersen-commits to the swap amount. The commitment piece works today; binding the commitment to a curve-respect proof is the research-grade follow-up.'

  return (
    <section className="mt-10 rounded-2xl border border-black/10 bg-white p-6">
      <div className="flex items-center justify-between">
        <h3 className="text-lg font-semibold">{headline}</h3>
        <button onClick={onClose} className="text-sm text-black/50 underline-offset-4 hover:underline">
          Close
        </button>
      </div>

      <p className="mt-2 text-sm text-black/60">
        {blurb} The first click loads ~10 MB of WASM and stands up an in-browser PXE — your account
        secret never leaves the tab. AMM at{' '}
        <code className="font-mono text-xs">{state.amm.address.slice(0, 12)}…</code>.
      </p>

      {variant === 'c' && (
        <p className="mt-3 rounded-lg border border-violet-200 bg-violet-50 p-3 text-xs text-violet-900">
          PrivateSwapWrapper compiles via aztec-nargo and ships a private
          <code className="mx-1 rounded bg-violet-100 px-1">commit_amount(amount, randomness)</code>
          plus a utility <code className="mx-1 rounded bg-violet-100 px-1">open_commitment</code>.
          The next step (research) is constraining the commitment to a swap that respects the
          AMM curve in zero-knowledge.
        </p>
      )}

      {!sandbox ? (
        <div className="mt-4">
          <button
            onClick={handleInit}
            disabled={busy}
            className="rounded-full bg-[var(--color-ink)] px-4 py-2 text-sm font-medium text-[var(--color-paper)] hover:opacity-90 disabled:opacity-50"
          >
            {busy ? 'Initializing…' : 'Initialize browser PXE'}
          </button>
          {progress && busy && <p className="mt-2 text-xs text-black/50">{progress}</p>}
        </div>
      ) : (
        <>
          <div className="mt-4 flex flex-wrap items-center gap-3">
            {variant === 'a' && (
              <button
                onClick={handleSwap}
                disabled={busy}
                className="rounded-full bg-[var(--color-private)] px-4 py-2 text-sm font-medium text-white hover:opacity-90 disabled:opacity-50"
              >
                {busy ? 'Submitting…' : `Swap 1,000 ${state.token0.symbol} → ${state.token1.symbol}`}
              </button>
            )}
            {variant === 'f' && (
              <>
                <button
                  onClick={handleAddLiquidity}
                  disabled={busy}
                  className="rounded-full bg-[var(--color-private)] px-4 py-2 text-sm font-medium text-white hover:opacity-90 disabled:opacity-50"
                >
                  {busy ? 'Submitting…' : 'Add 10k AZA + 20k AZB'}
                </button>
                <button
                  onClick={handleRemoveLiquidity}
                  disabled={busy}
                  className="rounded-full border border-[var(--color-private)] px-4 py-2 text-sm font-medium text-[var(--color-private)] hover:bg-[var(--color-private)]/5 disabled:opacity-50"
                >
                  Burn 25% of LP
                </button>
              </>
            )}
            {variant === 'c' && (
              <button
                onClick={handleCommit}
                disabled={busy}
                className="rounded-full bg-[var(--color-private)] px-4 py-2 text-sm font-medium text-white hover:opacity-90 disabled:opacity-50"
              >
                {busy ? 'Committing…' : 'Commit to a private amount (1337)'}
              </button>
            )}
            <span className="text-xs text-emerald-700">
              PXE ready · admin {sandbox.admin.toString().slice(0, 8)}…
            </span>
          </div>

          {live && (
            <div className="mt-4 grid grid-cols-1 gap-4 rounded-xl border border-black/10 bg-zinc-50 p-3 text-sm md:grid-cols-3">
              <Field
                label="live pool reserves"
                tone="public"
                lines={[
                  `${fmt(live.r0)} ${state.token0.symbol}`,
                  `${fmt(live.r1)} ${state.token1.symbol}`,
                ]}
              />
              <Field
                label="your private token balance"
                tone="private"
                lines={[
                  `${fmt(live.b0)} ${state.token0.symbol}`,
                  `${fmt(live.b1)} ${state.token1.symbol}`,
                ]}
              />
              <Field
                label="your private LP shares"
                tone="private"
                lines={[`${fmt(live.lp)} ${state.lpToken.symbol}`]}
              />
            </div>
          )}
        </>
      )}

      {actionResult && (
        <p className="mt-3 rounded-lg border border-emerald-200 bg-emerald-50 p-2 text-xs text-emerald-900">
          {actionResult}
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

function Field({
  label,
  tone,
  lines,
}: {
  label: string
  tone: 'public' | 'private'
  lines: string[]
}) {
  const dot = tone === 'private' ? 'bg-violet-500' : 'bg-sky-500'
  return (
    <div>
      <p className="flex items-center gap-1.5 text-xs uppercase tracking-wide text-black/40">
        <span className={`size-1.5 rounded-full ${dot}`} />
        {label}
      </p>
      <div className="mt-0.5 space-y-0.5 font-mono">
        {lines.map((l) => (
          <p key={l}>{l}</p>
        ))}
      </div>
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
