import { useRef, useState } from 'react'
import { initBrowserSandbox, type BrowserSandbox } from '../lib/browser-sandbox'
import type { SandboxState } from '../lib/sandbox-state'

interface Props {
  variant: 'ld1' | 'ld2' | 'ld3'
  state: SandboxState
  onClose: () => void
}

interface Snapshot {
  privateAZA: bigint
  publicAZA: bigint
  privateAZB: bigint
  publicAZB: bigint
}

export function LendingPanel({ variant, state, onClose }: Props) {
  const isPublic = variant === 'ld3'
  const isShieldedDebt = variant === 'ld2'
  const [progress, setProgress] = useState<string | null>(null)
  const [sandbox, setSandbox] = useState<BrowserSandbox | null>(null)
  const [error, setError] = useState<string | null>(null)
  const [result, setResult] = useState<string | null>(null)
  const [snap, setSnap] = useState<Snapshot | null>(null)
  const [busy, setBusy] = useState(false)
  // Persist the borrower secret across actions so deposit + borrow + repay
  // refer to the same position.
  const secretRef = useRef<bigint | null>(null)
  // ld2 position lookup: collateral + debt totals against our commitment.
  const [ld2Position, setLd2Position] = useState<{ collateral: bigint; debt: bigint } | null>(
    null,
  )
  const commitmentRef = useRef<bigint | null>(null)

  async function refresh(sb: BrowserSandbox) {
    const [pA, uA, pB, uB] = await Promise.all([
      sb.token0.methods.balance_of_private(sb.admin).simulate({ from: sb.admin }),
      sb.token0.methods.balance_of_public(sb.admin).simulate({ from: sb.admin }),
      sb.token1.methods.balance_of_private(sb.admin).simulate({ from: sb.admin }),
      sb.token1.methods.balance_of_public(sb.admin).simulate({ from: sb.admin }),
    ])
    setSnap({
      privateAZA: pA.result as bigint,
      publicAZA: uA.result as bigint,
      privateAZB: pB.result as bigint,
      publicAZB: uB.result as bigint,
    })
  }

  async function ensureSecret() {
    if (secretRef.current === null) {
      const { Fr } = await import('@aztec/aztec.js/fields')
      secretRef.current = Fr.random().toBigInt()
    }
    return secretRef.current
  }

  async function handleInit() {
    setError(null)
    setBusy(true)
    try {
      const sb = await initBrowserSandbox(state, setProgress)
      if (isShieldedDebt) {
        if (!sb.ld2)
          throw new Error('PublicCollateralPrivateDebt not deployed — re-run sandbox:setup')
      } else {
        if (!sb.lending) throw new Error('Lending not deployed — re-run sandbox:setup')
      }
      setSandbox(sb)
      await refresh(sb)
    } catch (e) {
      setError(formatError(e))
    } finally {
      setBusy(false)
    }
  }

  async function refreshLd2Position(sb: BrowserSandbox, commitment: bigint) {
    if (!sb.ld2) return
    const [coll, dbt] = await Promise.all([
      sb.ld2.methods.get_collateral(commitment).simulate({ from: sb.admin }),
      sb.ld2.methods.get_debt(commitment).simulate({ from: sb.admin }),
    ])
    setLd2Position({
      collateral: coll.result as bigint,
      debt: dbt.result as bigint,
    })
  }

  async function ensureLd2Commitment(sb: BrowserSandbox): Promise<bigint> {
    if (commitmentRef.current !== null) return commitmentRef.current
    const secret = await ensureSecret()
    const { Fr } = await import('@aztec/aztec.js/fields')
    const { pedersenHash } = await import('@aztec/foundation/crypto/sync')
    const commitment = pedersenHash([new Fr(secret), sb.admin.toField()]).toBigInt()
    commitmentRef.current = commitment
    return commitment
  }

  async function handleLd2Deposit() {
    if (!sandbox?.ld2) return
    setBusy(true)
    setError(null)
    setResult(null)
    try {
      const { Fr } = await import('@aztec/aztec.js/fields')
      const { SetPublicAuthwitContractInteraction } = await import('@aztec/aztec.js/authorization')
      const COLLATERAL = 50_000n
      const { admin, token0, ld2, wallet } = sandbox
      const commitment = await ensureLd2Commitment(sandbox)
      const nonce = Fr.random()
      const authIntent = {
        caller: ld2.address,
        call: await token0.methods
          .transfer_in_public(admin, ld2.address, COLLATERAL, nonce)
          .getFunctionCall(),
      }
      const authInteraction = await SetPublicAuthwitContractInteraction.create(
        wallet,
        admin,
        authIntent,
        true,
      )
      await authInteraction.send()
      await ld2.methods
        .deposit_public(COLLATERAL, commitment, nonce)
        .send({ from: admin })
      setResult(
        `deposited ${COLLATERAL} ${state.token0.symbol} publicly — attributed to commitment ${shortHex(
          commitment,
        )}`,
      )
      await refresh(sandbox)
      await refreshLd2Position(sandbox, commitment)
    } catch (e) {
      setError(formatError(e))
    } finally {
      setBusy(false)
    }
  }

  async function handleLd2Borrow() {
    if (!sandbox?.ld2) return
    if (commitmentRef.current === null) {
      setError('Deposit collateral first — the commitment derives from the same secret.')
      return
    }
    setBusy(true)
    setError(null)
    setResult(null)
    try {
      const BORROW = 10_000n
      const { admin, ld2 } = sandbox
      const secret = secretRef.current
      if (secret === null) throw new Error('secret missing')
      await ld2.methods.borrow_private(secret, admin, BORROW).send({ from: admin })
      setResult(
        `borrowed ${BORROW} ${state.token1.symbol} as a PRIVATE note (LTV-checked publicly against the commitment)`,
      )
      await refresh(sandbox)
      await refreshLd2Position(sandbox, commitmentRef.current)
    } catch (e) {
      setError(formatError(e))
    } finally {
      setBusy(false)
    }
  }

  async function handleDeposit() {
    if (!sandbox?.lending) return
    setBusy(true)
    setError(null)
    setResult(null)
    try {
      const { Fr } = await import('@aztec/aztec.js/fields')
      const COLLATERAL = 50_000n
      const { admin, token0, lending, wallet } = sandbox
      const secret = await ensureSecret()
      const nonce = Fr.random()
      const authwit = await wallet.createAuthWit(admin, {
        caller: lending.address,
        call: await token0.methods
          .transfer_to_public(admin, lending.address, COLLATERAL, nonce)
          .getFunctionCall(),
      })
      await lending.methods
        .deposit_private(admin, COLLATERAL, nonce, secret, 0n, token0.address)
        .send({ from: admin, authWitnesses: [authwit] })
      setResult(`deposited ${COLLATERAL} ${state.token0.symbol} as private collateral`)
      await refresh(sandbox)
    } catch (e) {
      setError(formatError(e))
    } finally {
      setBusy(false)
    }
  }

  async function handleBorrow() {
    if (!sandbox?.lending) return
    if (secretRef.current === null) {
      setError('Deposit collateral first — the same secret keys the position.')
      return
    }
    setBusy(true)
    setError(null)
    setResult(null)
    try {
      const BORROW = 10_000n
      const { admin, lending } = sandbox
      const secret = secretRef.current
      await lending.methods.borrow_private(secret, admin, BORROW).send({ from: admin })
      setResult(`borrowed ${BORROW} ${state.token1.symbol} (minted into your public balance)`)
      await refresh(sandbox)
    } catch (e) {
      setError(formatError(e))
    } finally {
      setBusy(false)
    }
  }

  async function handleDepositPublic() {
    if (!sandbox?.lending) return
    setBusy(true)
    setError(null)
    setResult(null)
    try {
      const { Fr } = await import('@aztec/aztec.js/fields')
      const { SetPublicAuthwitContractInteraction } = await import('@aztec/aztec.js/authorization')
      const COLLATERAL = 50_000n
      const { admin, token0, lending, wallet } = sandbox
      const nonce = Fr.random()
      // Authorize Lending to pull 50k AZA from admin's public balance.
      const authIntent = {
        caller: lending.address,
        call: await token0.methods
          .transfer_in_public(admin, lending.address, COLLATERAL, nonce)
          .getFunctionCall(),
      }
      const authInteraction = await SetPublicAuthwitContractInteraction.create(
        wallet,
        admin,
        authIntent,
        true,
      )
      await authInteraction.send()
      await lending.methods
        .deposit_public(COLLATERAL, nonce, admin.toField(), token0.address)
        .send({ from: admin })
      setResult(`deposited ${COLLATERAL} ${state.token0.symbol} as PUBLIC collateral`)
      await refresh(sandbox)
    } catch (e) {
      setError(formatError(e))
    } finally {
      setBusy(false)
    }
  }

  async function handleBorrowPublic() {
    if (!sandbox?.lending) return
    setBusy(true)
    setError(null)
    setResult(null)
    try {
      const BORROW = 10_000n
      const { admin, lending } = sandbox
      await lending.methods.borrow_public(admin, BORROW).send({ from: admin })
      setResult(`borrowed ${BORROW} ${state.token1.symbol} publicly`)
      await refresh(sandbox)
    } catch (e) {
      setError(formatError(e))
    } finally {
      setBusy(false)
    }
  }

  const cfg = state.lending
  const ld2Cfg = state.publicCollateralPrivateDebt

  const headerTitle = isShieldedDebt
    ? 'Lending — public collateral · private debt (variant ld2)'
    : isPublic
      ? 'Lending — fully public baseline (variant ld3)'
      : 'Lending — private collateral & debt (variant ld1)'

  const headerCopy = isShieldedDebt
    ? `Custom PublicCollateralPrivateDebt contract. Your collateral lands in a public pool attributed to commitment = pedersen(secret, your_addr). Borrowing happens privately — the contract reconstructs the same commitment from the secret you supply privately, enqueues a public LTV check (50% LTV), and mints ${state.token1.symbol} as a private note. Observers see the deposit but not the borrow.`
    : isPublic
      ? `Same bundled Lending contract, run via deposit_public + borrow_public. Position is keyed by your address (msg_sender) — visible to anyone. This is the Aave baseline that the private variants are measured against.`
      : `Bundled Lending contract. Your position is keyed by a secret Fr generated in this tab — observers see the lending contract being called, but cannot link the position to your address. Deposit transfers ${state.token0.symbol} to the contract's public balance; borrowed ${state.token1.symbol} is minted into your public balance (the contract is the AZB minter).`

  return (
    <section className="mt-10 rounded-2xl border border-black/10 bg-white p-6">
      <div className="flex items-center justify-between">
        <h3 className="text-lg font-semibold">{headerTitle}</h3>
        <button onClick={onClose} className="text-sm text-black/50 underline-offset-4 hover:underline">
          Close
        </button>
      </div>

      <p className="mt-2 text-sm text-black/60">{headerCopy}</p>

      {isShieldedDebt && ld2Cfg && (
        <dl className="mt-3 grid grid-cols-1 gap-x-6 gap-y-1 text-xs md:grid-cols-2">
          <dt className="text-black/40">Contract address</dt>
          <dd className="font-mono">{ld2Cfg.address.slice(0, 18)}…</dd>
          <dt className="text-black/40">Collateral / debt asset</dt>
          <dd className="font-mono">{ld2Cfg.collateralAsset} / {ld2Cfg.debtAsset}</dd>
          <dt className="text-black/40">Max LTV</dt>
          <dd className="font-mono">{ld2Cfg.ltvNumerator}/{ld2Cfg.ltvDenominator}</dd>
        </dl>
      )}
      {!isShieldedDebt && cfg && (
        <dl className="mt-3 grid grid-cols-1 gap-x-6 gap-y-1 text-xs md:grid-cols-2">
          <dt className="text-black/40">Lending address</dt>
          <dd className="font-mono">{cfg.address.slice(0, 18)}…</dd>
          <dt className="text-black/40">Oracle</dt>
          <dd className="font-mono">{state.priceFeed?.address.slice(0, 18)}…</dd>
          <dt className="text-black/40">Collateral / debt asset</dt>
          <dd className="font-mono">{cfg.collateralAsset} / {cfg.stableCoin}</dd>
          <dt className="text-black/40">LTV (bps)</dt>
          <dd className="font-mono">{cfg.loanToValueBps}</dd>
        </dl>
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
            {variant === 'ld1' && (
              <>
                <button
                  onClick={handleDeposit}
                  disabled={busy}
                  className="rounded-full bg-[var(--color-private)] px-4 py-2 text-sm font-medium text-white hover:opacity-90 disabled:opacity-50"
                >
                  {busy ? 'Submitting…' : `Deposit 50k ${state.token0.symbol} privately`}
                </button>
                <button
                  onClick={handleBorrow}
                  disabled={busy}
                  className="rounded-full border border-[var(--color-private)] px-4 py-2 text-sm font-medium text-[var(--color-private)] hover:bg-[var(--color-private)]/5 disabled:opacity-50"
                >
                  Borrow 10k {state.token1.symbol} privately
                </button>
              </>
            )}
            {isShieldedDebt && (
              <>
                <button
                  onClick={handleLd2Deposit}
                  disabled={busy}
                  className="rounded-full bg-[var(--color-public)] px-4 py-2 text-sm font-medium text-white hover:opacity-90 disabled:opacity-50"
                >
                  {busy ? 'Submitting…' : `Deposit 50k ${state.token0.symbol} publicly (to commitment)`}
                </button>
                <button
                  onClick={handleLd2Borrow}
                  disabled={busy}
                  className="rounded-full border border-[var(--color-private)] bg-[var(--color-private)]/5 px-4 py-2 text-sm font-medium text-[var(--color-private)] hover:bg-[var(--color-private)]/10 disabled:opacity-50"
                >
                  Borrow 10k {state.token1.symbol} privately
                </button>
              </>
            )}
            {isPublic && (
              <>
                <button
                  onClick={handleDepositPublic}
                  disabled={busy}
                  className="rounded-full bg-[var(--color-public)] px-4 py-2 text-sm font-medium text-white hover:opacity-90 disabled:opacity-50"
                >
                  {busy ? 'Submitting…' : `Deposit 50k ${state.token0.symbol} publicly`}
                </button>
                <button
                  onClick={handleBorrowPublic}
                  disabled={busy}
                  className="rounded-full border border-[var(--color-public)] px-4 py-2 text-sm font-medium text-[var(--color-public)] hover:bg-[var(--color-public)]/5 disabled:opacity-50"
                >
                  Borrow 10k {state.token1.symbol} publicly
                </button>
              </>
            )}
            <span className="text-xs text-emerald-700">
              PXE ready · admin {sandbox.admin.toString().slice(0, 8)}…
            </span>
          </div>

          {snap && (
            <div className="mt-4 grid grid-cols-2 gap-4 rounded-xl border border-black/10 bg-zinc-50 p-3 text-sm">
              <Stat
                label={`${state.token0.symbol} balance`}
                privAmt={snap.privateAZA}
                pubAmt={snap.publicAZA}
              />
              <Stat
                label={`${state.token1.symbol} balance`}
                privAmt={snap.privateAZB}
                pubAmt={snap.publicAZB}
              />
            </div>
          )}

          {variant === 'ld1' && secretRef.current !== null && (
            <p className="mt-3 text-xs text-black/40">
              position secret (kept in-tab): <code className="font-mono">0x{secretRef.current.toString(16).slice(0, 12)}…</code>
            </p>
          )}
          {isShieldedDebt && (
            <div className="mt-4 rounded-xl border border-amber-200 bg-amber-50/60 p-3 text-xs text-amber-900">
              <div className="font-medium">
                On-chain position (public — anyone can read this)
              </div>
              <dl className="mt-2 grid grid-cols-1 gap-x-6 gap-y-1 md:grid-cols-2">
                <dt className="text-amber-900/60">commitment</dt>
                <dd className="font-mono">
                  {commitmentRef.current !== null ? shortHex(commitmentRef.current) : '—'}
                </dd>
                <dt className="text-amber-900/60">public collateral against commitment</dt>
                <dd className="font-mono">
                  {ld2Position ? fmt(ld2Position.collateral) : '—'} {state.token0.symbol}
                </dd>
                <dt className="text-amber-900/60">debt drawn against commitment</dt>
                <dd className="font-mono">
                  {ld2Position ? fmt(ld2Position.debt) : '—'} {state.token1.symbol}
                </dd>
              </dl>
              <p className="mt-2 text-amber-900/70">
                The debt amount is public state (the contract has to enforce LTV) but the borrower
                is not — the borrow tx leaves no address-keyed footprint. The note itself lives
                privately on the borrower's side, so balance_of_private reflects it but no one
                else can see it.
              </p>
            </div>
          )}
          {isPublic && (
            <p className="mt-3 text-xs text-black/40">
              Position is keyed by admin's public address — visible to all observers.
            </p>
          )}
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

function Stat({
  label,
  privAmt,
  pubAmt,
}: {
  label: string
  privAmt: bigint
  pubAmt: bigint
}) {
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

function shortHex(n: bigint): string {
  const hex = n.toString(16)
  return `0x${hex.slice(0, 8)}…${hex.slice(-4)}`
}

function formatError(e: unknown): string {
  if (e instanceof Error) return `${e.name}: ${e.message}`
  return String(e)
}
