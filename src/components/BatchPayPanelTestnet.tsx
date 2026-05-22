import { useEffect, useState } from 'react'
import {
  getResolvedTestnetClient,
  subscribeTestnetClient,
  type TestnetClient,
} from '../lib/browser-testnet'
import type { SandboxState } from '../lib/sandbox-state'
import { PrivacyLeakage } from './ui/PrivacyLeakage'
import type { BatchPayContract } from '../contracts/BatchPay'

interface Props {
  state: SandboxState
  onClose: () => void
}

export function BatchPayPanelTestnet({ state, onClose }: Props) {
  const [client, setClient] = useState<TestnetClient | null>(getResolvedTestnetClient())
  const [contract, setContract] = useState<BatchPayContract | null>(null)
  const [error, setError] = useState<string | null>(null)
  const [busy, setBusy] = useState(false)
  const [privateAza, setPrivateAza] = useState<bigint | null>(null)
  const [to1, setTo1] = useState<string>('')
  const [amt1, setAmt1] = useState<string>('100')
  const [to2, setTo2] = useState<string>('')
  const [amt2, setAmt2] = useState<string>('250')
  const [lastTx, setLastTx] = useState<string | null>(null)

  const cfg = state.batchPay

  useEffect(() => subscribeTestnetClient(setClient), [])

  // Attach the BatchPay contract to the per-tab wallet.
  useEffect(() => {
    if (!client || !cfg) return
    let cancelled = false
    ;(async () => {
      try {
        const [{ jsonParseWithSchema }, { ContractInstanceWithAddressSchema }, mod, { AztecAddress }] =
          await Promise.all([
            import('@aztec/foundation/json-rpc'),
            import('@aztec/stdlib/contract'),
            import('../contracts/BatchPay'),
            import('@aztec/aztec.js/addresses'),
          ])
        const inst = jsonParseWithSchema(
          JSON.stringify(cfg.instance),
          ContractInstanceWithAddressSchema,
        )
        await (client.wallet as unknown as {
          registerContract: (i: unknown, a: unknown) => Promise<void>
        }).registerContract(inst, mod.BatchPayContractArtifact)
        const c = await mod.BatchPayContract.at(AztecAddress.fromString(cfg.address), client.wallet)
        if (!cancelled) {
          setContract(c as unknown as BatchPayContract)
          // Default both recipients to the visitor's own address (self-pay demo).
          const self = client.address.toString()
          setTo1(self)
          setTo2(self)
        }
      } catch (e) {
        if (!cancelled) setError(formatError(e))
      }
    })()
    return () => {
      cancelled = true
    }
  }, [client, cfg])

  async function refreshBalance(cl: TestnetClient) {
    const { result } = await cl.token0.methods
      .balance_of_private(cl.address)
      .simulate({ from: cl.address })
    setPrivateAza(result as bigint)
  }

  useEffect(() => {
    if (client) void refreshBalance(client)
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [client, contract])

  async function handlePayTwo() {
    if (!contract || !client) return
    setBusy(true)
    setError(null)
    setLastTx(null)
    try {
      const { Fr } = await import('@aztec/aztec.js/fields')
      const { AztecAddress } = await import('@aztec/aztec.js/addresses')
      const r1 = AztecAddress.fromString(to1)
      const r2 = AztecAddress.fromString(to2)
      const a1 = BigInt(amt1)
      const a2 = BigInt(amt2)
      const nonce1 = Fr.random()
      const nonce2 = Fr.random()
      // ONE private tx -> two nested Token.transfer_in_private sub-calls.
      // On testnet the visitor must authorize each inner transfer explicitly.
      const [aw1, aw2] = await Promise.all([
        client.wallet.createAuthWit(client.address, {
          caller: contract.address,
          call: await client.token0.methods
            .transfer_in_private(client.address, r1, a1, nonce1)
            .getFunctionCall(),
        }),
        client.wallet.createAuthWit(client.address, {
          caller: contract.address,
          call: await client.token0.methods
            .transfer_in_private(client.address, r2, a2, nonce2)
            .getFunctionCall(),
        }),
      ])
      const res = (await contract.methods
        .pay_two(r1, a1, nonce1, r2, a2, nonce2)
        .send({ from: client.address, fee: client.feeOpts, authWitnesses: [aw1, aw2] })) as unknown as {
        receipt: { txHash: { toString(): string } }
      }
      setLastTx(res.receipt.txHash.toString())
      await refreshBalance(client)
    } catch (e) {
      setError(formatError(e))
    } finally {
      setBusy(false)
    }
  }

  return (
    <section className="mt-10 rounded-2xl border border-black/10 bg-white p-6">
      <div className="flex items-center justify-between">
        <h3 className="text-lg font-semibold">Batch private payment — testnet</h3>
        <button onClick={onClose} className="text-sm text-black/50 underline-offset-4 hover:underline">
          Close
        </button>
      </div>
      <p className="mt-2 text-sm text-black/60">
        Live on Aztec testnet. One private tx pays two recipients. The BatchPay contract makes two
        nested <code className="font-mono text-xs">Token.transfer_in_private</code> sub-calls inside
        a single private function — a real private call stack across two contracts. You authorize
        each inner transfer with an authwit.
      </p>
      <p className="mt-2 rounded border border-emerald-200 bg-emerald-50 p-2 text-xs text-emerald-900">
        <strong>The headline:</strong> this batch has <em>zero public footprint</em>. Both
        transfers are private→private note operations. Observers see a tx landed and some
        commitments/nullifiers hit the global trees, but cannot tell the sender, the recipients,
        the amounts, or even <em>how many</em> recipients there were. A Solidity batch payment
        would expose every recipient + amount in calldata.
      </p>

      {!client ? (
        <p className="mt-4 rounded border border-amber-200 bg-amber-50 p-3 text-sm text-amber-900">
          Initialize your testnet account in the wallet panel above first (the per-tab Schnorr
          account funded by SponsoredFPC). You also need private AZA — grab some from the wallet
          panel's faucet. Then this panel activates.
        </p>
      ) : !contract ? (
        <p className="mt-4 text-sm text-black/50">Attaching contract…</p>
      ) : (
        <>
          <div className="mt-4 flex items-center gap-3 text-xs">
            <span className="text-black/60">
              your private AZA:{' '}
              <span className="font-mono">
                {privateAza === null ? '-' : Number(privateAza).toLocaleString()}
              </span>
            </span>
          </div>

          <div className="mt-4 space-y-3 rounded-xl border border-black/10 p-4">
            <div className="grid grid-cols-1 gap-2 md:grid-cols-[1fr_auto]">
              <input
                type="text"
                value={to1}
                onChange={(e) => setTo1(e.target.value)}
                disabled={busy}
                placeholder="recipient 1 (0x...)"
                className="rounded border border-black/15 px-2 py-1 font-mono text-xs disabled:opacity-40"
              />
              <input
                type="number"
                min={1}
                value={amt1}
                onChange={(e) => setAmt1(e.target.value)}
                disabled={busy}
                className="w-28 rounded border border-black/15 px-2 py-1 text-sm disabled:opacity-40"
              />
            </div>
            <div className="grid grid-cols-1 gap-2 md:grid-cols-[1fr_auto]">
              <input
                type="text"
                value={to2}
                onChange={(e) => setTo2(e.target.value)}
                disabled={busy}
                placeholder="recipient 2 (0x...)"
                className="rounded border border-black/15 px-2 py-1 font-mono text-xs disabled:opacity-40"
              />
              <input
                type="number"
                min={1}
                value={amt2}
                onChange={(e) => setAmt2(e.target.value)}
                disabled={busy}
                className="w-28 rounded border border-black/15 px-2 py-1 text-sm disabled:opacity-40"
              />
            </div>
            <p className="text-[11px] text-black/50">
              Both recipients default to your own address (self-pay) so the demo works without
              other accounts. Paste any Aztec address to send for real — the privacy is the same.
            </p>
            <button
              onClick={handlePayTwo}
              disabled={busy}
              className="rounded-full bg-violet-600 px-4 py-2 text-sm font-medium text-white hover:opacity-90 disabled:opacity-50"
            >
              {busy ? 'Working…' : 'Send batch privately (1 tx, 2 transfers)'}
            </button>
            <PrivacyLeakage
              publicLeaks={[]}
              staysPrivate={['sender', 'both recipients', 'both amounts', 'recipient count']}
            />
          </div>

          {lastTx && (
            <div className="mt-4 rounded-xl border border-emerald-200 bg-emerald-50/40 p-4 text-sm">
              <p className="text-emerald-950">
                Batch sent in one tx{' '}
                <span className="font-mono text-xs">{lastTx.slice(0, 18)}…</span>
              </p>
              <p className="mt-1 text-xs text-emerald-900/80">
                Two private transfers executed inside one private call stack. Check an explorer:
                you'll see the tx + opaque note commitments, but no recipient or amount data.
              </p>
            </div>
          )}

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
