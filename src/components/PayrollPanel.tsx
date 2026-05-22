import { useEffect, useState } from 'react'
import { initBrowserSandbox, type BrowserSandbox } from '../lib/browser-sandbox'
import type { SandboxState } from '../lib/sandbox-state'
import { PrivacyLeakage } from './ui/PrivacyLeakage'

interface Props {
  state: SandboxState
  onClose: () => void
}

const SLOT_CLAIMABLE = 1
const SLOT_CLAIMED = 2

export function PayrollPanel({ state, onClose }: Props) {
  const [sandbox, setSandbox] = useState<BrowserSandbox | null>(null)
  const [progress, setProgress] = useState<string | null>(null)
  const [error, setError] = useState<string | null>(null)
  const [busy, setBusy] = useState(false)

  const [pubAza, setPubAza] = useState<bigint | null>(null)
  const [funded, setFunded] = useState<bigint>(0n)
  const [period, setPeriod] = useState<number>(0)
  const [published, setPublished] = useState<number>(0)
  const [claimed, setClaimed] = useState<number>(0)
  const [slotStatus, setSlotStatus] = useState<Record<string, number>>({})

  const cfg = state.payroll
  const payslips = cfg?.payslips ?? []

  async function refreshGlobal(sb: BrowserSandbox) {
    if (!sb.payroll) return
    const [fR, pR, slipsR, clR] = await Promise.all([
      sb.payroll.methods.get_total_funded().simulate({ from: sb.admin }),
      sb.payroll.methods.get_period().simulate({ from: sb.admin }),
      sb.payroll.methods.get_payslip_count().simulate({ from: sb.admin }),
      sb.payroll.methods.get_claimed_count().simulate({ from: sb.admin }),
    ])
    setFunded(fR.result as bigint)
    setPeriod(Number(pR.result))
    setPublished(Number(slipsR.result))
    setClaimed(Number(clR.result))
    const pub = await sb.token0.methods.balance_of_public(sb.admin).simulate({ from: sb.admin })
    setPubAza(pub.result as bigint)
  }

  async function refreshSlots(sb: BrowserSandbox) {
    if (!sb.payroll) return
    const { Fr } = await import('@aztec/aztec.js/fields')
    const next: Record<string, number> = {}
    await Promise.all(
      payslips.map(async (p) => {
        const r = await sb.payroll!.methods
          .get_slot_status(Fr.fromString(p.commitment))
          .simulate({ from: sb.admin })
        next[p.commitment] = Number(r.result)
      }),
    )
    setSlotStatus(next)
  }

  async function handleInit() {
    setError(null)
    setBusy(true)
    try {
      const sb = await initBrowserSandbox(state, setProgress)
      if (!sb.payroll) throw new Error('Payroll not deployed - re-run sandbox:setup')
      setSandbox(sb)
      await refreshGlobal(sb)
      await refreshSlots(sb)
    } catch (e) {
      setError(formatError(e))
    } finally {
      setBusy(false)
    }
  }

  // Employee claims a payslip privately. The caller (the registered employee)
  // stays hidden in the private kernel; the payout lands in the recipient's
  // public balance. In this demo the recipient is the same account so the
  // balance visibly grows; production would pay to a fresh, unlinkable address.
  async function handleClaim(amount: string, slipPeriod: string) {
    if (!sandbox?.payroll) return
    setBusy(true)
    setError(null)
    try {
      await sandbox.payroll.methods
        .claim(BigInt(amount), BigInt(slipPeriod), sandbox.admin)
        .send({ from: sandbox.admin })
      await refreshGlobal(sandbox)
      await refreshSlots(sandbox)
    } catch (e) {
      setError(formatError(e))
    } finally {
      setBusy(false)
    }
  }

  // Operator advances the pay period so the same (employee, amount) pair can be
  // re-issued next cycle as a fresh, distinct commitment.
  async function handleAdvancePeriod() {
    if (!sandbox?.payroll) return
    setBusy(true)
    setError(null)
    try {
      await sandbox.payroll.methods.advance_period().send({ from: sandbox.admin })
      await refreshGlobal(sandbox)
    } catch (e) {
      setError(formatError(e))
    } finally {
      setBusy(false)
    }
  }

  useEffect(() => {
    if (!sandbox) return
    void refreshGlobal(sandbox)
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [sandbox])

  return (
    <section className="mt-10 rounded-2xl border border-black/10 bg-white p-6">
      <div className="flex items-center justify-between">
        <h3 className="text-lg font-semibold">Confidential payroll</h3>
        <button onClick={onClose} className="text-sm text-black/50 underline-offset-4 hover:underline">
          Close
        </button>
      </div>
      <p className="mt-2 text-sm text-black/60">
        An employer funds a pool and publishes one opaque commitment per employee per pay period -
        commitment = pedersen(employee, amount, period). Each employee claims privately: the claim
        hides which registered employee is collecting, and pays out to a recipient address that
        need not be linkable to them.
      </p>
      <p className="mt-2 rounded border border-emerald-200 bg-emerald-50 p-2 text-xs text-emerald-900">
        <strong>Privacy property:</strong> the whole salary register stays opaque on chain (each
        payslip is a single field element); the employer&harr;employee&harr;amount mapping and
        which employee is claiming stay private. The amounts shown below come from the operator&apos;s
        off-chain book - they are never published on chain until a claim is paid.
      </p>
      <p className="mt-2 rounded border border-amber-200 bg-amber-50 p-2 text-xs text-amber-900">
        <strong>Honest boundary:</strong> the contract custodies funds in public balance (the
        established Aztec pattern for contract-held funds), so the release is a public transfer -
        the payout amount + recipient address are visible at claim time. Paying to a burner keeps
        it unlinkable to the employee, but the amount leaks. Fully-amount-private payout would need
        contract-owned private notes.
      </p>

      {!sandbox ? (
        <div className="mt-4">
          <button
            onClick={handleInit}
            disabled={busy}
            className="rounded-full bg-[var(--color-ink)] px-4 py-2 text-sm font-medium text-[var(--color-paper)] hover:opacity-90 disabled:opacity-50"
          >
            {busy ? 'Initializing...' : 'Initialize browser PXE'}
          </button>
          {progress && busy && <p className="mt-2 text-xs text-black/50">{progress}</p>}
        </div>
      ) : (
        <>
          <div className="mt-4 grid grid-cols-2 gap-3 md:grid-cols-4">
            <Stat label="pool funded" value={`${Number(funded).toLocaleString()} AZA`} />
            <Stat label="payslips published" value={String(published)} />
            <Stat label="claims paid" value={String(claimed)} />
            <Stat label="pay period" value={String(period)} />
          </div>
          <div className="mt-3 rounded-xl border border-black/10 bg-zinc-50 p-3 text-xs">
            <p className="text-[10px] uppercase tracking-wide text-black/40">
              Your public AZA balance (payouts land here)
            </p>
            <p className="mt-1 font-mono text-sm">
              {pubAza === null ? '-' : Number(pubAza).toLocaleString()} AZA
            </p>
          </div>

          <div className="mt-5 rounded-xl border border-black/10 p-4">
            <p className="text-sm font-medium">Your payslips (period {period})</p>
            <p className="mt-1 text-xs text-black/50">
              On chain these are opaque commitments. The operator&apos;s book maps each to an amount;
              claim one to pull it from the pool into your balance.
            </p>
            <ul className="mt-2 space-y-2">
              {payslips.map((p, i) => {
                const status = slotStatus[p.commitment] ?? 0
                const claimable = status === SLOT_CLAIMABLE
                const isClaimed = status === SLOT_CLAIMED
                return (
                  <li
                    key={i}
                    className="flex flex-wrap items-center justify-between gap-2 rounded border border-black/10 bg-white px-3 py-2 text-xs"
                  >
                    <span className="font-mono">
                      payslip #{i + 1} · {Number(p.amount).toLocaleString()} AZA · period {p.period}
                      <span
                        className={`ml-2 rounded-full px-2 py-0.5 text-[10px] ${
                          claimable
                            ? 'bg-emerald-100 text-emerald-900'
                            : isClaimed
                              ? 'bg-zinc-200 text-zinc-700'
                              : 'bg-amber-100 text-amber-900'
                        }`}
                      >
                        {claimable ? 'claimable' : isClaimed ? 'claimed' : 'unset'}
                      </span>
                    </span>
                    <button
                      onClick={() => handleClaim(p.amount, p.period)}
                      disabled={busy || !claimable}
                      className="rounded-full bg-violet-600 px-3 py-1 text-xs font-medium text-white hover:opacity-90 disabled:opacity-40"
                    >
                      {isClaimed ? 'claimed' : 'Claim privately'}
                    </button>
                  </li>
                )
              })}
            </ul>
            <PrivacyLeakage
              className="mt-3"
              publicLeaks={['payout amount', 'recipient address', 'claims-paid counter +1']}
              staysPrivate={[
                'claimant identity (private kernel)',
                'full salary register until claim',
                'employer<->employee<->amount mapping',
              ]}
            />
          </div>

          <div className="mt-4 rounded-xl border border-amber-200 bg-amber-50/40 p-4">
            <p className="text-sm font-medium text-amber-950">Operator: next pay period</p>
            <p className="mt-1 text-xs text-amber-900/80">
              Bumps the active period so the operator can re-issue the same (employee, amount) pair
              next cycle as a fresh, distinct commitment - recurring payroll without linkable
              repeats.
            </p>
            <button
              onClick={handleAdvancePeriod}
              disabled={busy}
              className="mt-2 rounded-full bg-amber-600 px-3 py-1.5 text-xs font-medium text-white hover:opacity-90 disabled:opacity-50"
            >
              Advance to period {period + 1}
            </button>
          </div>

          {error && (
            <pre className="mt-3 max-h-48 overflow-auto rounded-lg border border-rose-200 bg-rose-50 p-3 text-xs text-rose-900">
              {error}
            </pre>
          )}
        </>
      )}
    </section>
  )
}

function Stat({ label, value }: { label: string; value: string }) {
  return (
    <div className="rounded-xl border border-black/10 bg-zinc-50 p-3 text-xs">
      <p className="text-[10px] uppercase tracking-wide text-black/40">{label}</p>
      <p className="mt-1 font-mono text-sm">{value}</p>
    </div>
  )
}

function formatError(e: unknown): string {
  if (e instanceof Error) return `${e.name}: ${e.message}`
  return String(e)
}
