import { useEffect, useState } from 'react'
import { initBrowserSandbox, type BrowserSandbox } from '../lib/browser-sandbox'
import type { SandboxState } from '../lib/sandbox-state'
import { PrivacyLeakage } from './ui/PrivacyLeakage'

interface Props {
  state: SandboxState
  onClose: () => void
}

const STATUS_UNSET = 0
const STATUS_AVAILABLE = 1
const STATUS_SPENT = 2

function statusLabel(s: number): string {
  switch (s) {
    case STATUS_AVAILABLE: return 'available'
    case STATUS_SPENT: return 'spent'
    default: return 'unset'
  }
}

export function AttestationPanel({ state, onClose }: Props) {
  const [sandbox, setSandbox] = useState<BrowserSandbox | null>(null)
  const [progress, setProgress] = useState<string | null>(null)
  const [error, setError] = useState<string | null>(null)
  const [busy, setBusy] = useState(false)
  const [totalIssued, setTotalIssued] = useState<number>(0)
  const [totalProven, setTotalProven] = useState<number>(0)
  const [slotStatuses, setSlotStatuses] = useState<Record<string, number>>({})

  const cfg = state.attestation
  const credentials = cfg?.credentials ?? []

  async function refreshStatus(sb: BrowserSandbox) {
    if (!sb.attestation) return
    const { Fr } = await import('@aztec/aztec.js/fields')
    const [issuedR, provenR] = await Promise.all([
      sb.attestation.methods.get_total_issued().simulate({ from: sb.admin }),
      sb.attestation.methods.get_total_proven().simulate({ from: sb.admin }),
    ])
    setTotalIssued(Number(issuedR.result))
    setTotalProven(Number(provenR.result))
    // Read per-credential status
    const statuses: Record<string, number> = {}
    await Promise.all(
      credentials.map(async (c) => {
        const r = await sb.attestation!.methods
          .get_slot_status(Fr.fromString(c.commitment))
          .simulate({ from: sb.admin })
        statuses[c.commitment] = Number(r.result)
      }),
    )
    setSlotStatuses(statuses)
  }

  async function handleInit() {
    setError(null)
    setBusy(true)
    try {
      const sb = await initBrowserSandbox(state, setProgress)
      if (!sb.attestation) {
        throw new Error('IdentityAttestation not deployed - re-run sandbox:setup')
      }
      setSandbox(sb)
      await refreshStatus(sb)
    } catch (e) {
      setError(formatError(e))
    } finally {
      setBusy(false)
    }
  }

  async function handleProve(secretHex: string) {
    if (!sandbox?.attestation) return
    setBusy(true)
    setError(null)
    try {
      const { Fr } = await import('@aztec/aztec.js/fields')
      const secret = Fr.fromString(secretHex)
      await sandbox.attestation.methods
        .prove_membership(secret)
        .send({ from: sandbox.admin })
      await refreshStatus(sandbox)
    } catch (e) {
      setError(formatError(e))
    } finally {
      setBusy(false)
    }
  }

  async function handleIssueNew() {
    if (!sandbox?.attestation) return
    setBusy(true)
    setError(null)
    try {
      const { Fr } = await import('@aztec/aztec.js/fields')
      const { pedersenHash } = await import('@aztec/foundation/crypto/sync')
      const secret = Fr.random()
      const commitment = pedersenHash([secret])
      await sandbox.attestation.methods
        .add_credential(commitment.toBigInt())
        .send({ from: sandbox.admin })
      // Append to local credentials so the user can prove it. Note: in a
      // real deployment this would never land in shared state.
      credentials.push({
        secret: secret.toString(),
        commitment: commitment.toString(),
      })
      await refreshStatus(sandbox)
    } catch (e) {
      setError(formatError(e))
    } finally {
      setBusy(false)
    }
  }

  useEffect(() => {
    if (!sandbox) return
    void refreshStatus(sandbox)
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [sandbox])

  return (
    <section className="mt-10 rounded-2xl border border-black/10 bg-white p-6">
      <div className="flex items-center justify-between">
        <h3 className="text-lg font-semibold">Identity attestation - anonymous credential</h3>
        <button onClick={onClose} className="text-sm text-black/50 underline-offset-4 hover:underline">
          Close
        </button>
      </div>
      <p className="mt-2 text-sm text-black/60">
        Issuer (KYC provider / age-gate operator / etc.) pre-publishes credential commitments to
        an on-chain whitelist. Holders prove membership privately - the contract verifies their
        secret matches an available slot and marks it spent. The L2 caller stays hidden in the
        private kernel, so observers see "some address proved membership" but not which holder.
      </p>
      <p className="mt-2 rounded border border-emerald-200 bg-emerald-50 p-2 text-xs text-emerald-900">
        <strong>Use case:</strong> KYC-without-deanonymization. A regulator checks identity
        off-chain, issues a credential, and the user later proves they're an "approved" address
        without revealing which one. Solidity can't do this without an MPC operator.
      </p>
      <p className="mt-2 rounded border border-amber-200 bg-amber-50 p-2 text-xs text-amber-900">
        <strong>Honest caveat:</strong> the issuer correlates "I added C for Alice" with "C was
        consumed", so the issuer can still link Alice to her proof. For fully unlinkable
        anonymous proofs across multiple contexts, you'd extend this to a Semaphore-style derived
        nullifier scheme - not in this MVP.
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
          <div className="mt-4 grid grid-cols-1 gap-3 md:grid-cols-2">
            <div className="rounded-xl border border-black/10 bg-zinc-50 p-3 text-xs">
              <p className="text-[10px] uppercase tracking-wide text-black/40">On-chain state</p>
              <p className="mt-1 font-mono text-sm">
                credentials issued: {totalIssued}
              </p>
              <p className="mt-1 font-mono text-sm">
                proofs submitted: {totalProven}
              </p>
            </div>
            <div className="rounded-xl border border-black/10 bg-zinc-50 p-3 text-xs">
              <p className="text-[10px] uppercase tracking-wide text-black/40">Issuer</p>
              <p className="mt-1 font-mono text-[10px]">
                {cfg?.issuer.slice(0, 20)}...
              </p>
              <button
                onClick={handleIssueNew}
                disabled={busy}
                className="mt-2 rounded-full bg-amber-600 px-3 py-1 text-xs font-medium text-white hover:opacity-90 disabled:opacity-50"
              >
                Issue new credential
              </button>
            </div>
          </div>

          <div className="mt-4 rounded-xl border border-black/10 p-4">
            <p className="text-sm font-medium">
              Available credentials ({credentials.length})
            </p>
            <p className="mt-1 text-xs text-black/50">
              In a real deploy each (secret, commitment) pair lives only in its holder's PXE.
              The demo pre-distributes them so you can play both roles.
            </p>
            {credentials.length === 0 ? (
              <p className="mt-2 text-xs text-black/40">no credentials yet</p>
            ) : (
              <ul className="mt-2 space-y-2">
                {credentials.map((c, i) => {
                  const status = slotStatuses[c.commitment] ?? STATUS_UNSET
                  return (
                    <li
                      key={i}
                      className="flex flex-wrap items-center justify-between gap-2 rounded border border-black/10 bg-white px-3 py-2 text-xs"
                    >
                      <div>
                        <span className="font-mono">
                          credential #{i + 1}
                        </span>
                        <span className="ml-2 font-mono text-[10px] text-black/50">
                          commit {c.commitment.slice(0, 14)}...
                        </span>
                        <span
                          className={`ml-2 rounded-full px-2 py-0.5 text-[10px] ${
                            status === STATUS_AVAILABLE
                              ? 'bg-emerald-100 text-emerald-900'
                              : status === STATUS_SPENT
                                ? 'bg-zinc-200 text-zinc-700'
                                : 'bg-amber-100 text-amber-900'
                          }`}
                        >
                          {statusLabel(status)}
                        </span>
                      </div>
                      <button
                        onClick={() => handleProve(c.secret)}
                        disabled={status !== STATUS_AVAILABLE || busy}
                        className="rounded-full bg-violet-600 px-3 py-1 text-xs font-medium text-white hover:opacity-90 disabled:opacity-40"
                      >
                        {status === STATUS_SPENT ? 'already proven' : 'Prove membership'}
                      </button>
                    </li>
                  )
                })}
              </ul>
            )}
            <PrivacyLeakage
              className="mt-3"
              publicLeaks={['consumed slot commitment', 'proven counter +1']}
              staysPrivate={['prover address (private kernel)']}
              caveat="issuer knows the mapping commitment <-> identity, so they CAN link a proof back to a holder. Public observers cannot."
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
