import { useEffect, useState } from 'react'
import {
  getResolvedTestnetClient,
  subscribeTestnetClient,
  type TestnetClient,
} from '../lib/browser-testnet'
import type { SandboxState } from '../lib/sandbox-state'
import { PrivacyLeakage } from './ui/PrivacyLeakage'
import { TxResult } from './ui/TxResult'
import type { AnonymousVotingContract } from '../contracts/AnonymousVoting'

interface Props {
  state: SandboxState
  onClose: () => void
}

// Testnet anonymous voting. The production `vote` is eligibility-gated (Merkle
// membership in the credential set), so this panel gives shared-testnet
// visitors the permissionless `demo_vote` path: a one-vote-per-address ballot
// whose voter is hidden behind an app-siloed SingleUseClaim nullifier. The full
// eligibility-gated flow runs interactively on the sandbox.
export function AnonymousVotingPanelTestnet({ state, onClose }: Props) {
  const [client, setClient] = useState<TestnetClient | null>(getResolvedTestnetClient())
  const [contract, setContract] = useState<AnonymousVotingContract | null>(null)
  const [error, setError] = useState<string | null>(null)
  const [busy, setBusy] = useState(false)
  const [tallies, setTallies] = useState<number[]>([])
  const [total, setTotal] = useState<number>(0)

  const cfg = state.anonymousVoting
  const candidates = cfg?.candidates ?? []

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
            import('../contracts/AnonymousVoting'),
            import('@aztec/aztec.js/addresses'),
          ])
        const inst = jsonParseWithSchema(JSON.stringify(cfg.instance), ContractInstanceWithAddressSchema)
        await (client.wallet as unknown as {
          registerContract: (i: unknown, a: unknown) => Promise<void>
        }).registerContract(inst, mod.AnonymousVotingContractArtifact)
        const c = await mod.AnonymousVotingContract.at(AztecAddress.fromStringUnsafe(cfg.address), client.wallet)
        if (!cancelled) setContract(c as unknown as AnonymousVotingContract)
      } catch (e) {
        if (!cancelled) setError(formatError(e))
      }
    })()
    return () => {
      cancelled = true
    }
  }, [client, cfg])

  async function refresh(c: AnonymousVotingContract, cl: TestnetClient) {
    const counts = await Promise.all(
      candidates.map(async (_, i) =>
        Number((await c.methods.get_tally(BigInt(i)).simulate({ from: cl.address })).result),
      ),
    )
    setTallies(counts)
    setTotal(Number((await c.methods.get_total_votes().simulate({ from: cl.address })).result))
  }

  useEffect(() => {
    if (contract && client) void refresh(contract, client)
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [contract, client])

  async function vote(candidate: number) {
    if (!contract || !client) return
    setBusy(true)
    setError(null)
    try {
      await contract.methods
        .demo_vote(BigInt(candidate))
        .send({ from: client.address, fee: client.feeOpts })
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
        <h3 className="text-lg font-semibold">Anonymous voting — testnet</h3>
        <button onClick={onClose} className="text-sm text-black/50 underline-offset-4 hover:underline">
          Close
        </button>
      </div>
      <p className="mt-2 text-sm text-black/60">
        Live on Aztec testnet. Cast a private ballot — the vote runs as a private function so your
        wallet never appears in public state; only the option&apos;s tally ticks up.
      </p>
      <p className="mt-2 rounded border border-emerald-200 bg-emerald-50 p-2 text-xs text-emerald-900">
        <strong>Try it:</strong> the production vote is eligibility-gated (Merkle membership in a
        credential set), so this demo gives you a permissionless ballot — one vote per address,
        enforced by an app-siloed SingleUseClaim nullifier (you stay hidden). The full
        eligibility-gated flow runs interactively on <strong>Sandbox</strong>.
      </p>

      {!client ? (
        <p className="mt-4 rounded border border-amber-200 bg-amber-50 p-3 text-sm text-amber-900">
          Initialize your testnet account in the wallet panel above first.
        </p>
      ) : !contract ? (
        <p className="mt-4 text-sm text-black/50">Attaching contract…</p>
      ) : (
        <>
          <p className="mt-4 text-sm font-medium">
            Total votes cast: <span className="font-mono">{total}</span>
          </p>
          <div className="mt-3 space-y-2">
            {candidates.map((name, i) => (
              <div
                key={i}
                className="flex items-center justify-between gap-3 rounded-xl border border-black/10 bg-zinc-50 p-3"
              >
                <div>
                  <p className="text-sm font-medium">{name}</p>
                  <p className="font-mono text-xs text-black/50">{tallies[i] ?? 0} votes</p>
                </div>
                <button
                  onClick={() => vote(i)}
                  disabled={busy}
                  className="rounded-full bg-violet-600 px-4 py-1.5 text-sm font-medium text-white hover:opacity-90 disabled:opacity-40"
                >
                  {busy ? 'Proving…' : 'Vote'}
                </button>
              </div>
            ))}
          </div>
          <PrivacyLeakage
            className="mt-4"
            publicLeaks={['tally increment for chosen option', 'app-siloed nullifier']}
            staysPrivate={['voter identity (private kernel)']}
          />
          {error && <TxResult message={error} />}
        </>
      )}
    </section>
  )
}

function formatError(e: unknown): string {
  if (e instanceof Error) return `${e.name}: ${e.message}`
  return String(e)
}
