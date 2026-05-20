import { useEffect, useState } from 'react'
import {
  getResolvedTestnetClient,
  subscribeTestnetClient,
  type TestnetClient,
} from '../lib/browser-testnet'
import type { SandboxState } from '../lib/sandbox-state'
import { PrivacyLeakage } from './ui/PrivacyLeakage'
import type { IdentityAttestationContract } from '../contracts/IdentityAttestation'

interface Props {
  state: SandboxState
  onClose: () => void
}

const STATUS_AVAILABLE = 1
const STATUS_SPENT = 2

export function AttestationPanelTestnet({ state, onClose }: Props) {
  const [client, setClient] = useState<TestnetClient | null>(getResolvedTestnetClient())
  const [contract, setContract] = useState<IdentityAttestationContract | null>(null)
  const [error, setError] = useState<string | null>(null)
  const [busy, setBusy] = useState(false)
  const [totalIssued, setTotalIssued] = useState<number>(0)
  const [totalProven, setTotalProven] = useState<number>(0)
  const [slotStatuses, setSlotStatuses] = useState<Record<string, number>>({})

  const cfg = state.attestation
  const credentials = cfg?.credentials ?? []

  useEffect(() => subscribeTestnetClient(setClient), [])

  // Attach the IdentityAttestation contract to the per-tab wallet.
  useEffect(() => {
    if (!client || !cfg) return
    let cancelled = false
    ;(async () => {
      try {
        const [{ jsonParseWithSchema }, { ContractInstanceWithAddressSchema }, mod, { AztecAddress }] =
          await Promise.all([
            import('@aztec/foundation/json-rpc'),
            import('@aztec/stdlib/contract'),
            import('../contracts/IdentityAttestation'),
            import('@aztec/aztec.js/addresses'),
          ])
        const inst = jsonParseWithSchema(
          JSON.stringify(cfg.instance),
          ContractInstanceWithAddressSchema,
        )
        await (client.wallet as unknown as {
          registerContract: (i: unknown, a: unknown) => Promise<void>
        }).registerContract(inst, mod.IdentityAttestationContractArtifact)
        const c = await mod.IdentityAttestationContract.at(
          AztecAddress.fromString(cfg.address),
          client.wallet,
        )
        if (!cancelled) {
          setContract(c as unknown as IdentityAttestationContract)
        }
      } catch (e) {
        if (!cancelled) setError(formatError(e))
      }
    })()
    return () => {
      cancelled = true
    }
  }, [client, cfg])

  async function refreshStatus(c: IdentityAttestationContract, cl: TestnetClient) {
    const { Fr } = await import('@aztec/aztec.js/fields')
    const [issuedR, provenR] = await Promise.all([
      c.methods.get_total_issued().simulate({ from: cl.address }),
      c.methods.get_total_proven().simulate({ from: cl.address }),
    ])
    setTotalIssued(Number(issuedR.result))
    setTotalProven(Number(provenR.result))
    const statuses: Record<string, number> = {}
    await Promise.all(
      credentials.map(async (cr) => {
        const r = await c.methods
          .get_slot_status(Fr.fromString(cr.commitment))
          .simulate({ from: cl.address })
        statuses[cr.commitment] = Number(r.result)
      }),
    )
    setSlotStatuses(statuses)
  }

  useEffect(() => {
    if (contract && client) void refreshStatus(contract, client)
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [contract, client])

  async function handleProve(secretHex: string) {
    if (!contract || !client) return
    setBusy(true)
    setError(null)
    try {
      const { Fr } = await import('@aztec/aztec.js/fields')
      await contract.methods
        .prove_membership(Fr.fromString(secretHex))
        .send({ from: client.address, fee: client.feeOpts })
      await refreshStatus(contract, client)
    } catch (e) {
      setError(formatError(e))
    } finally {
      setBusy(false)
    }
  }

  return (
    <section className="mt-10 rounded-2xl border border-black/10 bg-white p-6">
      <div className="flex items-center justify-between">
        <h3 className="text-lg font-semibold">Identity attestation — testnet</h3>
        <button onClick={onClose} className="text-sm text-black/50 underline-offset-4 hover:underline">
          Close
        </button>
      </div>
      <p className="mt-2 text-sm text-black/60">
        Live on Aztec testnet. An issuer pre-published credential commitments; prove membership
        with your per-tab account — the prover stays hidden in the private kernel. Observers see an
        opaque slot get consumed, not which holder proved.
      </p>
      <p className="mt-2 rounded border border-emerald-200 bg-emerald-50 p-2 text-xs text-emerald-900">
        <strong>Privacy property:</strong> prove_membership is a private function; only the
        consumed slot commitment + a proven counter land publicly. The issuer can correlate
        commitment ↔ identity (off-chain), public observers cannot.
      </p>

      {!client ? (
        <p className="mt-4 rounded border border-amber-200 bg-amber-50 p-3 text-sm text-amber-900">
          Initialize your testnet account in the wallet panel above first (the per-tab Schnorr
          account funded by SponsoredFPC). Then this panel activates.
        </p>
      ) : !contract ? (
        <p className="mt-4 text-sm text-black/50">Attaching contract…</p>
      ) : (
        <>
          <div className="mt-4 grid grid-cols-1 gap-3 md:grid-cols-2">
            <div className="rounded-xl border border-black/10 bg-zinc-50 p-3 text-xs">
              <p className="text-[10px] uppercase tracking-wide text-black/40">On-chain state</p>
              <p className="mt-1 font-mono text-sm">credentials issued: {totalIssued}</p>
              <p className="mt-1 font-mono text-sm">proofs submitted: {totalProven}</p>
            </div>
            <div className="rounded-xl border border-black/10 bg-zinc-50 p-3 text-xs">
              <p className="text-[10px] uppercase tracking-wide text-black/40">Your account</p>
              <p className="mt-1 font-mono text-[10px]">{client.address.toString().slice(0, 24)}…</p>
              <p className="mt-1 text-[10px] text-black/40">per-tab · SponsoredFPC pays gas</p>
            </div>
          </div>

          <div className="mt-4 rounded-xl border border-black/10 p-4">
            <p className="text-sm font-medium">Available credentials ({credentials.length})</p>
            <ul className="mt-2 space-y-2">
              {credentials.map((c, i) => {
                const status = slotStatuses[c.commitment] ?? 0
                return (
                  <li
                    key={i}
                    className="flex flex-wrap items-center justify-between gap-2 rounded border border-black/10 bg-white px-3 py-2 text-xs"
                  >
                    <span className="font-mono">
                      credential #{i + 1}{' '}
                      <span
                        className={`ml-1 rounded-full px-2 py-0.5 text-[10px] ${
                          status === STATUS_AVAILABLE
                            ? 'bg-emerald-100 text-emerald-900'
                            : status === STATUS_SPENT
                              ? 'bg-zinc-200 text-zinc-700'
                              : 'bg-amber-100 text-amber-900'
                        }`}
                      >
                        {status === STATUS_AVAILABLE ? 'available' : status === STATUS_SPENT ? 'spent' : 'unset'}
                      </span>
                    </span>
                    <button
                      onClick={() => handleProve(c.secret)}
                      disabled={status !== STATUS_AVAILABLE || busy}
                      className="rounded-full bg-violet-600 px-3 py-1 text-xs font-medium text-white hover:opacity-90 disabled:opacity-40"
                    >
                      {busy ? 'Proving…' : status === STATUS_SPENT ? 'proven' : 'Prove membership'}
                    </button>
                  </li>
                )
              })}
            </ul>
            <PrivacyLeakage
              className="mt-3"
              publicLeaks={['consumed slot commitment', 'proven counter +1']}
              staysPrivate={['prover address (private kernel)']}
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

function formatError(e: unknown): string {
  if (e instanceof Error) return `${e.name}: ${e.message}`
  return String(e)
}
