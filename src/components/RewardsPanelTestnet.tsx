import { useEffect, useState } from 'react'
import {
  getResolvedTestnetClient,
  subscribeTestnetClient,
  type TestnetClient,
} from '../lib/browser-testnet'
import type { SandboxState } from '../lib/sandbox-state'
import { PrivacyLeakage } from './ui/PrivacyLeakage'
import type { RewardsContract } from '../contracts/Rewards'

interface Props {
  state: SandboxState
  onClose: () => void
}

// Read-only live view of the rewards campaign on Aztec testnet. Claims are
// address-gated (the leaf binds the eligible address), so an anonymous visitor
// can't claim a pre-published leaf — switch to Sandbox for the interactive
// claim with both payout modes.
export function RewardsPanelTestnet({ state, onClose }: Props) {
  const [client, setClient] = useState<TestnetClient | null>(getResolvedTestnetClient())
  const [contract, setContract] = useState<RewardsContract | null>(null)
  const [error, setError] = useState<string | null>(null)

  const [poolBal, setPoolBal] = useState<bigint>(0n)
  const [period, setPeriod] = useState<number>(0)
  const [totalClaimed, setTotalClaimed] = useState<number>(0)
  const [root, setRoot] = useState<string>('')

  const cfg = state.rewards
  const entries = cfg?.entries ?? []

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
            import('../contracts/Rewards'),
            import('@aztec/aztec.js/addresses'),
          ])
        const inst = jsonParseWithSchema(
          JSON.stringify(cfg.instance),
          ContractInstanceWithAddressSchema,
        )
        await (client.wallet as unknown as {
          registerContract: (i: unknown, a: unknown) => Promise<void>
        }).registerContract(inst, mod.RewardsContractArtifact)
        const c = await mod.RewardsContract.at(AztecAddress.fromString(cfg.address), client.wallet)
        if (!cancelled) setContract(c as unknown as RewardsContract)
      } catch (e) {
        if (!cancelled) setError(formatError(e))
      }
    })()
    return () => {
      cancelled = true
    }
  }, [client, cfg])

  async function refresh(c: RewardsContract, cl: TestnetClient) {
    const { AztecAddress } = await import('@aztec/aztec.js/addresses')
    const [pool, pR, tcR, rootR] = await Promise.all([
      cl.token0.methods
        .balance_of_public(AztecAddress.fromString(cfg!.address))
        .simulate({ from: cl.address }),
      c.methods.get_period().simulate({ from: cl.address }),
      c.methods.get_total_claimed().simulate({ from: cl.address }),
      c.methods.get_root().simulate({ from: cl.address }),
    ])
    setPoolBal(pool.result as bigint)
    setPeriod(Number(pR.result))
    setTotalClaimed(Number(tcR.result))
    setRoot((rootR.result as bigint).toString(16))
  }

  useEffect(() => {
    if (contract && client) void refresh(contract, client)
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [contract, client])

  return (
    <section className="mt-10 rounded-2xl border border-black/10 bg-white p-6">
      <div className="flex items-center justify-between">
        <h3 className="text-lg font-semibold">Private rewards (Merkl-style) — testnet</h3>
        <button onClick={onClose} className="text-sm text-black/50 underline-offset-4 hover:underline">
          Close
        </button>
      </div>
      <p className="mt-2 text-sm text-black/60">
        Live on Aztec testnet. An app funded a pool and published a single Merkle root over the
        campaign&apos;s (recipient, amount) entitlements. This is the read-only view — aggregate
        counters + the opaque root, which is all an observer sees.
      </p>
      <p className="mt-2 rounded border border-emerald-200 bg-emerald-50 p-2 text-xs text-emerald-900">
        <strong>Why read-only here:</strong> claims are address-gated (the leaf binds the eligible
        address), so only a registered recipient — not an anonymous visitor — can claim. Switch to
        <strong> Sandbox</strong> to run the interactive claim with both public and
        private-recipient payout modes.
      </p>

      {!client ? (
        <p className="mt-4 rounded border border-amber-200 bg-amber-50 p-3 text-sm text-amber-900">
          Initialize your testnet account in the wallet panel above first. Then this panel reads the
          live campaign.
        </p>
      ) : !contract ? (
        <p className="mt-4 text-sm text-black/50">Attaching contract…</p>
      ) : (
        <>
          <div className="mt-4 grid grid-cols-2 gap-3 md:grid-cols-4">
            <Stat label="pool balance" value={`${Number(poolBal).toLocaleString()} AZA`} />
            <Stat label="claims paid" value={String(totalClaimed)} />
            <Stat label="campaign period" value={String(period)} />
            <Stat label="campaign leaves" value={String(entries.length)} />
          </div>
          <div className="mt-3 rounded-xl border border-black/10 bg-zinc-50 p-3 text-xs">
            <p className="text-[10px] uppercase tracking-wide text-black/40">published Merkle root</p>
            <p className="mt-1 break-all font-mono text-[11px]">0x{root}</p>
          </div>

          <div className="mt-4 rounded-xl border border-black/10 p-4">
            <p className="text-sm font-medium">Campaign entitlements ({entries.length})</p>
            <p className="mt-1 text-xs text-black/50">
              These (address, amount) pairs are the operator&apos;s off-chain book that the root
              commits to — on chain only the single root is public.
            </p>
            <ul className="mt-2 space-y-1.5">
              {entries.map((e, i) => (
                <li
                  key={i}
                  className="flex flex-wrap items-center justify-between gap-2 rounded border border-black/10 bg-white px-3 py-1.5 text-xs"
                >
                  <span className="font-mono text-[11px] text-black/50">{e.address.slice(0, 16)}…</span>
                  <span className="font-mono">{Number(e.amount).toLocaleString()} AZA</span>
                </li>
              ))}
            </ul>
            <PrivacyLeakage
              className="mt-3"
              publicLeaks={['Merkle root', 'pool balance', 'payout amount (at claim)', 'claims-paid counter']}
              staysPrivate={['which eligible member claims (private kernel)', 'recipient (private-recipient mode)']}
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
