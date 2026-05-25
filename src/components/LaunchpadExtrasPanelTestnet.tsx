import { useEffect, useState } from 'react'
import {
  getResolvedTestnetClient,
  subscribeTestnetClient,
  type TestnetClient,
} from '../lib/browser-testnet'
import type { SandboxState } from '../lib/sandbox-state'
import { NETWORKS } from '../lib/network'
import { PrivacyLeakage } from './ui/PrivacyLeakage'

type Variant = 'lp2' | 'lp3'

interface Props {
  variant: Variant
  state: SandboxState
  onClose: () => void
}

// A single donation amount used by both variants. The donor spends their own
// per-tab private AZA (grabbed from the faucet in the wallet panel above).
const AMOUNT = 100n

// Minimal structural type for the attached contract — both lp2 and lp3 expose
// the methods we touch. Avoids importing two concrete contract classes here.
interface DonationContract {
  address: { toString(): string }
  methods: {
    donate?: (amount: bigint, nonce: unknown) => DonationInteraction
    donate_with_receipt?: (amount: bigint, salt: unknown, nonce: unknown) => DonationInteraction
    get_total_raised: () => DonationInteraction
    get_receipt: (key: unknown) => DonationInteraction
  }
}
interface DonationInteraction {
  getFunctionCall(): Promise<unknown>
  simulate(opts: { from: unknown }): Promise<{ result: unknown }>
  send(opts: { from: unknown; fee: unknown; authWitnesses?: unknown[] }): {
    wait(): Promise<unknown>
  }
}

export function LaunchpadExtrasPanelTestnet({ variant, state, onClose }: Props) {
  const [client, setClient] = useState<TestnetClient | null>(getResolvedTestnetClient())
  const [contract, setContract] = useState<DonationContract | null>(null)
  const [error, setError] = useState<string | null>(null)
  const [busy, setBusy] = useState(false)
  const [totalRaised, setTotalRaised] = useState<bigint | null>(null)
  const [receiptKey, setReceiptKey] = useState<string | null>(null)
  const [receiptAmount, setReceiptAmount] = useState<bigint | null>(null)
  const [result, setResult] = useState<string | null>(null)

  const cfg = variant === 'lp2' ? state.publicCrowdfunding : state.perDonorReceipts
  const symbol = state.token0.symbol

  useEffect(() => subscribeTestnetClient(setClient), [])

  // Self-attach the contract to the per-tab wallet from the serialized instance.
  useEffect(() => {
    if (!client || !cfg) return
    let cancelled = false
    ;(async () => {
      try {
        const [{ jsonParseWithSchema }, { ContractInstanceWithAddressSchema }, mod, { AztecAddress }] =
          await Promise.all([
            import('@aztec/foundation/json-rpc'),
            import('@aztec/stdlib/contract'),
            variant === 'lp2'
              ? import('../contracts/PublicTotalCrowdfunding')
              : import('../contracts/PerDonorReceipts'),
            import('@aztec/aztec.js/addresses'),
          ])
        const inst = jsonParseWithSchema(
          JSON.stringify(cfg.instance),
          ContractInstanceWithAddressSchema,
        )
        const artifact =
          'PublicTotalCrowdfundingContractArtifact' in mod
            ? mod.PublicTotalCrowdfundingContractArtifact
            : mod.PerDonorReceiptsContractArtifact
        await (client.wallet as unknown as {
          registerContract: (i: unknown, a: unknown) => Promise<void>
        }).registerContract(inst, artifact)
        const ContractClass =
          'PublicTotalCrowdfundingContract' in mod
            ? mod.PublicTotalCrowdfundingContract
            : mod.PerDonorReceiptsContract
        const c = await ContractClass.at(AztecAddress.fromString(cfg.address), client.wallet)
        if (!cancelled) setContract(c as unknown as DonationContract)
      } catch (e) {
        if (!cancelled) setError(formatError(e))
      }
    })()
    return () => {
      cancelled = true
    }
  }, [client, cfg, variant])

  async function refreshTotal(c: DonationContract, cl: TestnetClient) {
    const { result: tot } = await c.methods.get_total_raised().simulate({ from: cl.address })
    setTotalRaised(tot as bigint)
  }

  useEffect(() => {
    if (contract && client) void refreshTotal(contract, client)
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [contract, client])

  async function handleDonate() {
    if (!contract || !client) return
    setBusy(true)
    setError(null)
    setResult(null)
    try {
      const { Fr } = await import('@aztec/aztec.js/fields')
      const nonce = Fr.random()
      // Both variants pull the donor's private AZA via transfer_to_public, so
      // authorize that inner call to the contract here.
      const authwit = await client.wallet.createAuthWit(client.address, {
        caller: contract.address as never,
        call: await client.token0.methods
          .transfer_to_public(client.address, contract.address as never, AMOUNT, nonce)
          .getFunctionCall(),
      })

      if (variant === 'lp2') {
        if (!contract.methods.donate) throw new Error('donate() missing on contract')
        await contract.methods
          .donate(AMOUNT, nonce)
          .send({ from: client.address, fee: client.feeOpts, authWitnesses: [authwit] })
          .wait()
        setResult(`donated ${AMOUNT} ${symbol} — donor private, total public`)
      } else {
        if (!contract.methods.donate_with_receipt)
          throw new Error('donate_with_receipt() missing on contract')
        const { pedersenHash } = await import('@aztec/foundation/crypto/sync')
        const salt = Fr.random()
        // Replicate the on-chain receipt key: pedersen_hash([donor, salt]).
        const key = pedersenHash([client.address.toField(), salt])
        await contract.methods
          .donate_with_receipt(AMOUNT, salt, nonce)
          .send({ from: client.address, fee: client.feeOpts, authWitnesses: [authwit] })
          .wait()
        setReceiptKey(key.toString())
        const { result: r } = await contract.methods
          .get_receipt(key)
          .simulate({ from: client.address })
        setReceiptAmount(r as bigint)
        setResult(`donated ${AMOUNT} ${symbol}; receipt key generated`)
      }
      await refreshTotal(contract, client)
    } catch (e) {
      setError(formatError(e))
    } finally {
      setBusy(false)
    }
  }

  const explorer = NETWORKS.testnet.explorerUrl

  return (
    <section className="mt-10 rounded-2xl border border-black/10 bg-white p-6">
      <div className="flex items-center justify-between">
        <h3 className="text-lg font-semibold">
          {variant === 'lp2'
            ? 'Launchpad — public total · private donors (variant lp2) — testnet'
            : 'Launchpad — public per-donor receipts (variant lp3) — testnet'}
        </h3>
        <button onClick={onClose} className="text-sm text-black/50 underline-offset-4 hover:underline">
          Close
        </button>
      </div>

      <p className="mt-2 text-sm text-black/60">
        {variant === 'lp2'
          ? `Custom Noir wrapper (PublicTotalCrowdfunding), live on Aztec testnet. Each donation pulls your private AZA via transfer_to_public into the contract's public balance and bumps a public total_raised counter. Donor identity stays private; the raise total is auditable by anyone.`
          : `Custom Noir wrapper (PerDonorReceipts), live on Aztec testnet. Each donation writes a public receipt slot keyed by pedersen_hash(donor, salt) -> amount. Anyone can read receipts; nobody can link a receipt to a wallet without the salt.`}
      </p>

      {cfg && (
        <dl className="mt-3 grid grid-cols-1 gap-x-6 gap-y-1 text-xs md:grid-cols-2">
          <dt className="text-black/40">Contract address</dt>
          <dd className="font-mono">
            {explorer ? (
              <a
                href={`${explorer}/contracts/${cfg.address}`}
                target="_blank"
                rel="noreferrer"
                className="underline-offset-2 hover:underline"
              >
                {cfg.address.slice(0, 18)}…
              </a>
            ) : (
              `${cfg.address.slice(0, 18)}…`
            )}
          </dd>
          <dt className="text-black/40">Donation token</dt>
          <dd className="font-mono">{cfg.donationToken}</dd>
          <dt className="text-black/40">Operator</dt>
          <dd className="font-mono">{cfg.operator.slice(0, 12)}…</dd>
        </dl>
      )}

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
          <div className="mt-4 flex items-center gap-3">
            <button
              onClick={handleDonate}
              disabled={busy}
              className="rounded-full bg-[var(--color-private)] px-4 py-2 text-sm font-medium text-white hover:opacity-90 disabled:opacity-50"
            >
              {busy ? 'Submitting…' : `Donate ${AMOUNT} ${symbol}`}
            </button>
            <span className="text-xs text-emerald-700">
              account {client.address.toString().slice(0, 8)}…
            </span>
          </div>

          <div className="mt-4 rounded-xl border border-black/10 bg-zinc-50 p-3 text-sm">
            <p className="flex items-center gap-1.5 text-xs uppercase tracking-wide text-black/40">
              <span className="size-1.5 rounded-full bg-sky-500" />
              public total_raised
            </p>
            <p className="mt-0.5 font-mono">
              {totalRaised === null ? '—' : `${Number(totalRaised).toLocaleString()} ${symbol}`}
            </p>
          </div>

          {variant === 'lp3' && receiptKey && (
            <div className="mt-3 rounded-xl border border-black/10 bg-zinc-50 p-3 text-xs">
              <p className="uppercase tracking-wide text-black/40">your latest receipt</p>
              <p className="mt-0.5 break-all font-mono">key: {receiptKey.slice(0, 18)}…</p>
              <p className="mt-0.5 font-mono">
                public amount under that key:{' '}
                {receiptAmount === null ? '—' : `${Number(receiptAmount).toLocaleString()} ${symbol}`}
              </p>
            </div>
          )}

          <PrivacyLeakage
            className="mt-3"
            publicLeaks={
              variant === 'lp2'
                ? ['total raised', 'donation amount']
                : ['total raised', 'per-donor receipt (hashed)']
            }
            staysPrivate={
              variant === 'lp2'
                ? ['donor identity (private kernel)']
                : ['donor identity', 'receipt salt']
            }
          />
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

function formatError(e: unknown): string {
  if (e instanceof Error) return `${e.name}: ${e.message}`
  return String(e)
}
