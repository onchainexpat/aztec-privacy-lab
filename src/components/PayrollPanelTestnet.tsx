import { useEffect, useState } from 'react'
import {
  getResolvedTestnetClient,
  subscribeTestnetClient,
  type TestnetClient,
} from '../lib/browser-testnet'
import type { SandboxState } from '../lib/sandbox-state'
import { PrivacyLeakage } from './ui/PrivacyLeakage'
import type { PayrollContract } from '../contracts/Payroll'

interface Props {
  state: SandboxState
  onClose: () => void
}

const SLOT_CLAIMABLE = 1
const SLOT_CLAIMED = 2

// Live, read-only view of the payroll register on Aztec testnet. Unlike the
// sandbox panel, the per-tab visitor is not the registered employee, and
// payroll claims are employee-ADDRESS-gated (commitment = pedersen(employee,
// amount, period)), so a random visitor cannot claim a pre-issued payslip.
// This panel proves the register is live on real testnet and shows what an
// observer sees: opaque commitments + aggregate counters, never the salaries.
export function PayrollPanelTestnet({ state, onClose }: Props) {
  const [client, setClient] = useState<TestnetClient | null>(getResolvedTestnetClient())
  const [contract, setContract] = useState<PayrollContract | null>(null)
  const [error, setError] = useState<string | null>(null)
  const [busy, setBusy] = useState(false)
  const [result, setResult] = useState<string | null>(null)

  const [funded, setFunded] = useState<bigint>(0n)
  const [period, setPeriod] = useState<number>(0)
  const [published, setPublished] = useState<number>(0)
  const [claimed, setClaimed] = useState<number>(0)
  const [slotStatus, setSlotStatus] = useState<Record<string, number>>({})

  const cfg = state.payroll
  const payslips = cfg?.payslips ?? []

  useEffect(() => subscribeTestnetClient(setClient), [])

  useEffect(() => {
    if (!client || !cfg) return
    let cancelled = false
    ;(async () => {
      try {
        const [{ jsonParseWithSchema }, { ContractInstanceWithAddressSchema }, mod, { AztecAddress }] =
          await Promise.all([
            import('@aztec/foundation/json-rpc'),
            import('@aztec/stdlib/contract'),
            import('../contracts/Payroll'),
            import('@aztec/aztec.js/addresses'),
          ])
        const inst = jsonParseWithSchema(
          JSON.stringify(cfg.instance),
          ContractInstanceWithAddressSchema,
        )
        await (client.wallet as unknown as {
          registerContract: (i: unknown, a: unknown) => Promise<void>
        }).registerContract(inst, mod.PayrollContractArtifact)
        const c = await mod.PayrollContract.at(AztecAddress.fromString(cfg.address), client.wallet)
        if (!cancelled) setContract(c as unknown as PayrollContract)
      } catch (e) {
        if (!cancelled) setError(formatError(e))
      }
    })()
    return () => {
      cancelled = true
    }
  }, [client, cfg])

  async function refresh(c: PayrollContract, cl: TestnetClient) {
    const { Fr } = await import('@aztec/aztec.js/fields')
    // "pool funded" = the contract's actual public AZA balance (reflects both
    // fund() deposits and any direct mint), not the fund()-only counter.
    const [fR, pR, slipsR, clR] = await Promise.all([
      cl.token0.methods.balance_of_public(c.address).simulate({ from: cl.address }),
      c.methods.get_period().simulate({ from: cl.address }),
      c.methods.get_payslip_count().simulate({ from: cl.address }),
      c.methods.get_claimed_count().simulate({ from: cl.address }),
    ])
    setFunded(fR.result as bigint)
    setPeriod(Number(pR.result))
    setPublished(Number(slipsR.result))
    setClaimed(Number(clR.result))
    const next: Record<string, number> = {}
    await Promise.all(
      payslips.map(async (p) => {
        const r = await c.methods.get_slot_status(Fr.fromString(p.commitment)).simulate({
          from: cl.address,
        })
        next[p.commitment] = Number(r.result)
      }),
    )
    setSlotStatus(next)
  }

  useEffect(() => {
    if (contract && client) void refresh(contract, client)
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [contract, client])

  // DEMO: the visitor plays employer + employee in their own session via the
  // permissionless demo_add_payslip path — publish an opaque payslip for their
  // own (address, amount, period), then claim it privately. Their identity
  // stays in the kernel; only the consumed slot + payout reach public state.
  const DEMO_AMOUNT = 100n
  async function handleDemoPlay() {
    if (!contract || !client) return
    setBusy(true)
    setError(null)
    setResult(null)
    try {
      const { Fr } = await import('@aztec/aztec.js/fields')
      const { pedersenHash } = await import('@aztec/foundation/crypto/sync')
      const periodR = await contract.methods.get_period().simulate({ from: client.address })
      const per = BigInt(periodR.result as bigint)
      const commitment = pedersenHash([
        client.address.toField(),
        new Fr(DEMO_AMOUNT),
        new Fr(per),
      ])
      // 1) publish the opaque payslip (permissionless demo path)
      await contract.methods
        .demo_add_payslip(commitment.toBigInt())
        .send({ from: client.address, fee: client.feeOpts })
      // 2) claim it privately — payout to self (use a fresh address for full unlinkability)
      await contract.methods
        .claim(DEMO_AMOUNT, per, client.address)
        .send({ from: client.address, fee: client.feeOpts })
      setResult(
        `Published an opaque payslip for ${DEMO_AMOUNT} AZA and claimed it privately — observers saw a commitment + a payout, not that it was you.`,
      )
      await refresh(contract, client)
    } catch (e) {
      setError(formatError(e))
    } finally {
      setBusy(false)
    }
  }

  return (
    <section className="mt-10 rounded-2xl border border-black/10 bg-white p-6">
      <div className="flex items-center justify-between">
        <h3 className="text-lg font-semibold">Confidential payroll — testnet</h3>
        <button onClick={onClose} className="text-sm text-black/50 underline-offset-4 hover:underline">
          Close
        </button>
      </div>
      <p className="mt-2 text-sm text-black/60">
        Live on Aztec testnet. An employer funded a pool and published one opaque commitment per
        employee per pay period. This is a read-only view of the on-chain register — exactly what an
        observer sees: aggregate counters and opaque commitments, never the salaries.
      </p>
      <p className="mt-2 rounded border border-emerald-200 bg-emerald-50 p-2 text-xs text-emerald-900">
        <strong>Try it:</strong> the production claim is employee-address-gated, so this demo gives
        you a permissionless path — you publish an opaque payslip for yourself and claim it
        privately, playing both employer and employee. Your identity stays in the private kernel;
        observers see a commitment get published and a payout happen, not that it was you.
      </p>

      {!client ? (
        <p className="mt-4 rounded border border-amber-200 bg-amber-50 p-3 text-sm text-amber-900">
          Initialize your testnet account in the wallet panel above first. Then this panel reads the
          live register.
        </p>
      ) : !contract ? (
        <p className="mt-4 text-sm text-black/50">Attaching contract…</p>
      ) : (
        <>
          <div className="mt-4 grid grid-cols-2 gap-3 md:grid-cols-4">
            <Stat label="pool funded" value={`${Number(funded).toLocaleString()} AZA`} />
            <Stat label="payslips published" value={String(published)} />
            <Stat label="claims paid" value={String(claimed)} />
            <Stat label="pay period" value={String(period)} />
          </div>

          <div className="mt-4 rounded-xl border border-violet-200 bg-violet-50/40 p-4">
            <p className="text-sm font-medium">Run a private payslip (demo)</p>
            <p className="mt-1 text-xs text-black/55">
              Publishes an opaque commitment for {Number(DEMO_AMOUNT)} AZA tied to your hidden
              address, then privately claims it to your account — two real testnet txs (~1–2 min
              each with proving).
            </p>
            <button
              onClick={handleDemoPlay}
              disabled={busy}
              className="mt-3 rounded-full bg-violet-600 px-4 py-2 text-sm font-medium text-white hover:opacity-90 disabled:opacity-50"
            >
              {busy ? 'Proving + claiming…' : `Publish & claim ${Number(DEMO_AMOUNT)} AZA privately`}
            </button>
            {result && (
              <p className="mt-3 rounded border border-emerald-200 bg-emerald-50 p-2 text-xs text-emerald-900">
                {result}
              </p>
            )}
          </div>

          <div className="mt-4 rounded-xl border border-black/10 p-4">
            <p className="text-sm font-medium">On-chain register ({payslips.length} payslips)</p>
            <p className="mt-1 text-xs text-black/50">
              Each row is a single opaque field element on chain. The amounts below come from the
              operator&apos;s off-chain book — they are not published on chain until a claim is paid.
            </p>
            <ul className="mt-2 space-y-2">
              {payslips.map((p, i) => {
                const status = slotStatus[p.commitment] ?? 0
                return (
                  <li
                    key={i}
                    className="flex flex-wrap items-center justify-between gap-2 rounded border border-black/10 bg-white px-3 py-2 text-xs"
                  >
                    <span className="font-mono">
                      payslip #{i + 1} · {Number(p.amount).toLocaleString()} AZA · period {p.period}
                      <span
                        className={`ml-2 rounded-full px-2 py-0.5 text-[10px] ${
                          status === SLOT_CLAIMABLE
                            ? 'bg-emerald-100 text-emerald-900'
                            : status === SLOT_CLAIMED
                              ? 'bg-zinc-200 text-zinc-700'
                              : 'bg-amber-100 text-amber-900'
                        }`}
                      >
                        {status === SLOT_CLAIMABLE
                          ? 'claimable'
                          : status === SLOT_CLAIMED
                            ? 'claimed'
                            : 'unset'}
                      </span>
                    </span>
                    <span className="font-mono text-[10px] text-black/40">
                      {p.commitment.slice(0, 14)}…
                    </span>
                  </li>
                )
              })}
            </ul>
            <PrivacyLeakage
              className="mt-3"
              publicLeaks={['payout amount (at claim)', 'recipient address (at claim)', 'claims-paid counter']}
              staysPrivate={[
                'claimant identity (private kernel)',
                'full salary register until claim',
                'employer<->employee<->amount mapping',
              ]}
            />
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
