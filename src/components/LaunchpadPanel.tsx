import { useState } from 'react'
import { initBrowserSandbox, type BrowserSandbox } from '../lib/browser-sandbox'
import type { SandboxState } from '../lib/sandbox-state'

interface Props {
  variant: 'lp1' | 'lp2' | 'lp3'
  state: SandboxState
  onClose: () => void
}

export function LaunchpadPanel({ variant, state, onClose }: Props) {
  const [progress, setProgress] = useState<string | null>(null)
  const [sandbox, setSandbox] = useState<BrowserSandbox | null>(null)
  const [error, setError] = useState<string | null>(null)
  const [result, setResult] = useState<string | null>(null)
  const [contributedTotal, setContributedTotal] = useState<bigint>(0n)
  const [publicTotal, setPublicTotal] = useState<bigint | null>(null)
  const [receiptHash, setReceiptHash] = useState<string | null>(null)
  const [receiptAmount, setReceiptAmount] = useState<bigint | null>(null)
  const [adminBalance, setAdminBalance] = useState<bigint | null>(null)
  const [busy, setBusy] = useState(false)

  async function refresh(sb: BrowserSandbox) {
    const { result: bal } = await sb.token0.methods
      .balance_of_private(sb.admin)
      .simulate({ from: sb.admin })
    setAdminBalance(bal as bigint)
    if (variant === 'lp2' && sb.publicCrowdfunding) {
      const { result: tot } = await sb.publicCrowdfunding.methods
        .get_total_raised()
        .simulate({ from: sb.admin })
      setPublicTotal(tot as bigint)
    }
    if (variant === 'lp3' && sb.perDonorReceipts) {
      const { result: tot } = await sb.perDonorReceipts.methods
        .get_total_raised()
        .simulate({ from: sb.admin })
      setPublicTotal(tot as bigint)
      if (receiptHash) {
        const { Fr } = await import('@aztec/aztec.js/fields')
        const { result: r } = await sb.perDonorReceipts.methods
          .get_receipt(Fr.fromString(receiptHash))
          .simulate({ from: sb.admin })
        setReceiptAmount(r as bigint)
      }
    }
  }

  async function handleInit() {
    setError(null)
    setBusy(true)
    try {
      const sb = await initBrowserSandbox(state, setProgress)
      if (variant === 'lp1' && !sb.crowdfunding)
        throw new Error('Crowdfunding not deployed — re-run sandbox:setup')
      if (variant === 'lp2' && !sb.publicCrowdfunding)
        throw new Error('PublicTotalCrowdfunding not deployed — re-run sandbox:setup')
      if (variant === 'lp3' && !sb.perDonorReceipts)
        throw new Error('PerDonorReceipts not deployed — re-run sandbox:setup')
      setSandbox(sb)
      await refresh(sb)
    } catch (e) {
      setError(formatError(e))
    } finally {
      setBusy(false)
    }
  }

  async function handleDonateLp1() {
    if (!sandbox?.crowdfunding) return
    setBusy(true)
    setError(null)
    setResult(null)
    try {
      const AMOUNT = 5_000n
      await sandbox.crowdfunding.methods.donate(AMOUNT).send({ from: sandbox.admin })
      setContributedTotal((n) => n + AMOUNT)
      setResult(`donated ${AMOUNT} ${state.token0.symbol} privately`)
      await refresh(sandbox)
    } catch (e) {
      setError(formatError(e))
    } finally {
      setBusy(false)
    }
  }

  async function handleDonateLp3() {
    if (!sandbox?.perDonorReceipts) return
    setBusy(true)
    setError(null)
    setResult(null)
    try {
      const { Fr } = await import('@aztec/aztec.js/fields')
      const { pedersenHash } = await import('@aztec/foundation/crypto/sync')
      const AMOUNT = 5_000n
      const { admin, token0, perDonorReceipts, wallet } = sandbox
      const salt = Fr.random()
      const nonce = Fr.random()
      const authwit = await wallet.createAuthWit(admin, {
        caller: perDonorReceipts.address,
        call: await token0.methods
          .transfer_to_public(admin, perDonorReceipts.address, AMOUNT, nonce)
          .getFunctionCall(),
      })
      // Replicate the on-chain receipt key client-side so we can query it.
      // Noir does pedersen_hash([donor.to_field(), salt]).
      const receiptKey = pedersenHash([admin.toField(), salt])
      await perDonorReceipts.methods
        .donate_with_receipt(AMOUNT, salt, nonce)
        .send({ from: admin, authWitnesses: [authwit] })
      setContributedTotal((n) => n + AMOUNT)
      setReceiptHash(receiptKey.toString())
      setResult(`donated ${AMOUNT} ${state.token0.symbol}; receipt key generated`)
      await refresh(sandbox)
      // refresh() reads receiptHash from the previous render closure, so query
      // the just-created key explicitly here.
      const { result: r } = await perDonorReceipts.methods
        .get_receipt(receiptKey)
        .simulate({ from: admin })
      setReceiptAmount(r as bigint)
    } catch (e) {
      setError(formatError(e))
    } finally {
      setBusy(false)
    }
  }

  async function handleDonateLp2() {
    if (!sandbox?.publicCrowdfunding) return
    setBusy(true)
    setError(null)
    setResult(null)
    try {
      const { Fr } = await import('@aztec/aztec.js/fields')
      const AMOUNT = 5_000n
      const { admin, token0, publicCrowdfunding, wallet } = sandbox
      const nonce = Fr.random()
      const authwit = await wallet.createAuthWit(admin, {
        caller: publicCrowdfunding.address,
        call: await token0.methods
          .transfer_to_public(admin, publicCrowdfunding.address, AMOUNT, nonce)
          .getFunctionCall(),
      })
      await publicCrowdfunding.methods
        .donate(AMOUNT, nonce)
        .send({ from: admin, authWitnesses: [authwit] })
      setContributedTotal((n) => n + AMOUNT)
      setResult(`donated ${AMOUNT} ${state.token0.symbol} (donor private, total public)`)
      await refresh(sandbox)
    } catch (e) {
      setError(formatError(e))
    } finally {
      setBusy(false)
    }
  }

  const cf =
    variant === 'lp1'
      ? state.crowdfunding
      : variant === 'lp2'
      ? state.publicCrowdfunding
      : state.perDonorReceipts
  const deadlineDate =
    variant === 'lp1' && state.crowdfunding
      ? new Date(Number(state.crowdfunding.deadline) * 1000)
      : null

  return (
    <section className="mt-10 rounded-2xl border border-black/10 bg-white p-6">
      <div className="flex items-center justify-between">
        <h3 className="text-lg font-semibold">
          {variant === 'lp1'
            ? 'Launchpad — fully private raise (variant lp1)'
            : variant === 'lp2'
            ? 'Launchpad — public total · private donors (variant lp2)'
            : 'Launchpad — public per-donor receipts (variant lp3)'}
        </h3>
        <button onClick={onClose} className="text-sm text-black/50 underline-offset-4 hover:underline">
          Close
        </button>
      </div>

      <p className="mt-2 text-sm text-black/60">
        {variant === 'lp1'
          ? `Bundled Crowdfunding contract. Donations move private notes from the donor to the contract; the running total only exists as a sum of the contract's private notes — visible to the operator at withdrawal time.`
          : variant === 'lp2'
          ? `Custom Noir wrapper (PublicTotalCrowdfunding) authored in this repo. Each donation pulls the donor's private balance via transfer_to_public, lands in the contract's public balance, and bumps a public total_raised counter. Donor identity stays private; the raise total is auditable by anyone.`
          : `Custom Noir wrapper (PerDonorReceipts). Each donation writes a public receipt slot keyed by pedersen_hash(donor_addr, donor_salt) -> amount. Anyone can read every receipt; nobody can link a receipt to a wallet without the salt. Donors can prove participation later by revealing (addr, salt).`}
      </p>

      {cf && (
        <dl className="mt-3 grid grid-cols-1 gap-x-6 gap-y-1 text-xs md:grid-cols-2">
          <dt className="text-black/40">Contract address</dt>
          <dd className="font-mono">{cf.address.slice(0, 18)}…</dd>
          <dt className="text-black/40">Donation token</dt>
          <dd className="font-mono">{cf.donationToken}</dd>
          <dt className="text-black/40">Operator</dt>
          <dd className="font-mono">{cf.operator.slice(0, 12)}…</dd>
          {deadlineDate && (
            <>
              <dt className="text-black/40">Deadline</dt>
              <dd className="font-mono">{deadlineDate.toLocaleString()}</dd>
            </>
          )}
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
          <div className="mt-4 flex items-center gap-3">
            <button
              onClick={
                variant === 'lp1'
                  ? handleDonateLp1
                  : variant === 'lp2'
                  ? handleDonateLp2
                  : handleDonateLp3
              }
              disabled={busy}
              className="rounded-full bg-[var(--color-private)] px-4 py-2 text-sm font-medium text-white hover:opacity-90 disabled:opacity-50"
            >
              {busy ? 'Submitting…' : `Donate 5,000 ${state.token0.symbol}`}
            </button>
            <span className="text-xs text-emerald-700">
              PXE ready · admin {sandbox.admin.toString().slice(0, 8)}…
            </span>
          </div>

          <div className="mt-4 grid grid-cols-1 gap-4 rounded-xl border border-black/10 bg-zinc-50 p-3 text-sm md:grid-cols-3">
            <Field
              label="your private contribution"
              tone="private"
              value={`${fmt(contributedTotal)} ${state.token0.symbol} (session)`}
            />
            <Field
              label="your remaining private balance"
              tone="private"
              value={adminBalance === null ? '—' : `${fmt(adminBalance)} ${state.token0.symbol}`}
            />
            {(variant === 'lp2' || variant === 'lp3') && (
              <Field
                label="public total_raised"
                tone="public"
                value={publicTotal === null ? '—' : `${fmt(publicTotal)} ${state.token0.symbol}`}
              />
            )}
          </div>

          {variant === 'lp3' && receiptHash && (
            <div className="mt-3 rounded-xl border border-black/10 bg-zinc-50 p-3 text-xs">
              <p className="text-black/40 uppercase tracking-wide">your latest receipt</p>
              <p className="mt-0.5 font-mono break-all">
                key: {receiptHash.slice(0, 18)}…
              </p>
              <p className="mt-0.5 font-mono">
                public amount under that key:{' '}
                {receiptAmount === null ? '—' : `${fmt(receiptAmount)} ${state.token0.symbol}`}
              </p>
            </div>
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

function Field({
  label,
  tone,
  value,
}: {
  label: string
  tone: 'public' | 'private'
  value: string
}) {
  const dot = tone === 'private' ? 'bg-violet-500' : 'bg-sky-500'
  return (
    <div>
      <p className="flex items-center gap-1.5 text-xs uppercase tracking-wide text-black/40">
        <span className={`size-1.5 rounded-full ${dot}`} />
        {label}
      </p>
      <p className="mt-0.5 font-mono">{value}</p>
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
