import { useEffect, useRef, useState } from 'react'
import {
  getResolvedTestnetClient,
  subscribeTestnetClient,
  type TestnetClient,
} from '../lib/browser-testnet'
import type { SandboxState } from '../lib/sandbox-state'
import { NETWORKS } from '../lib/network'
import { PrivacyLeakage } from './ui/PrivacyLeakage'
import { TxResult } from './ui/TxResult'

type Variant = 'ld1' | 'ld3'

interface Props {
  variant: Variant
  state: SandboxState
  onClose: () => void
}

// Small constants — borrower funds collateral from the wallet panel faucet.
const COLLATERAL = 200n
const BORROW = 50n

// Minimal structural type for the bundled Lending contract — we only touch the
// four methods below. Avoids leaking the concrete contract class' typing here.
interface LendingLike {
  address: { toString(): string }
  methods: {
    deposit_private: (
      owner: unknown,
      amount: bigint,
      nonce: unknown,
      secret: unknown,
      assetId: bigint,
      collateralAsset: unknown,
    ) => LendingInteraction
    borrow_private: (secret: unknown, to: unknown, amount: bigint) => LendingInteraction
    deposit_public: (
      amount: bigint,
      nonce: unknown,
      onBehalfOf: unknown,
      collateralAsset: unknown,
    ) => LendingInteraction
    borrow_public: (to: unknown, amount: bigint) => LendingInteraction
  }
}
interface LendingInteraction {
  getFunctionCall(): Promise<unknown>
  send(opts: { from: unknown; fee: unknown; authWitnesses?: unknown[] }): {
    wait(): Promise<unknown>
  }
}

export function LendingExtrasPanelTestnet({ variant, state, onClose }: Props) {
  const isPublic = variant === 'ld3'
  const [client, setClient] = useState<TestnetClient | null>(getResolvedTestnetClient())
  const [contract, setContract] = useState<LendingLike | null>(null)
  const [error, setError] = useState<string | null>(null)
  const [result, setResult] = useState<string | null>(null)
  const [busy, setBusy] = useState(false)
  // ld1 borrower secret — persisted across deposit → borrow within this panel.
  const secretRef = useRef<unknown>(null)

  const cfg = state.lending
  const t0sym = state.token0.symbol
  const t1sym = state.token1.symbol

  useEffect(() => subscribeTestnetClient(setClient), [])

  // Self-attach the bundled Lending contract to the per-tab wallet from the
  // serialized instance in testnet-state.json.
  useEffect(() => {
    if (!client || !cfg) return
    let cancelled = false
    ;(async () => {
      try {
        const [
          { jsonParseWithSchema },
          { ContractInstanceWithAddressSchema },
          { LendingContract },
          { AztecAddress },
        ] = await Promise.all([
          import('@aztec/foundation/json-rpc'),
          import('@aztec/stdlib/contract'),
          import('@aztec/noir-contracts.js/Lending'),
          import('@aztec/aztec.js/addresses'),
        ])
        const inst = jsonParseWithSchema(
          JSON.stringify(cfg.instance),
          ContractInstanceWithAddressSchema,
        )
        await (
          client.wallet as unknown as {
            registerContract: (i: unknown, a: unknown) => Promise<void>
          }
        ).registerContract(inst, LendingContract.artifact)
        const c = await LendingContract.at(AztecAddress.fromStringUnsafe(cfg.address), client.wallet)
        if (!cancelled) setContract(c as unknown as LendingLike)
      } catch (e) {
        if (!cancelled) setError(formatError(e))
      }
    })()
    return () => {
      cancelled = true
    }
  }, [client, cfg])

  async function ensureSecret() {
    if (secretRef.current === null) {
      const { Fr } = await import('@aztec/aztec.js/fields')
      secretRef.current = Fr.random()
    }
    return secretRef.current
  }

  async function handleDeposit() {
    if (!contract || !client) return
    setBusy(true)
    setError(null)
    setResult(null)
    try {
      const { Fr } = await import('@aztec/aztec.js/fields')
      const nonce = Fr.random()
      if (isPublic) {
        // ld3: pull collateral from the caller's PUBLIC balance via
        // transfer_in_public. On testnet the wallet does not auto-inject the
        // authwit, so build it explicitly.
        const { SetPublicAuthwitContractInteraction } = await import(
          '@aztec/aztec.js/authorization'
        )
        const authIntent = {
          caller: contract.address as never,
          call: await client.token0.methods
            .transfer_in_public(client.address, contract.address as never, COLLATERAL, nonce)
            .getFunctionCall(),
        }
        const authInteraction = await SetPublicAuthwitContractInteraction.create(
          client.wallet as never,
          client.address,
          authIntent as never,
          true,
        )
        await (
          authInteraction as unknown as { send: (o: unknown) => { wait(): Promise<unknown> } }
        ).send({ fee: client.feeOpts })
        await contract.methods
          .deposit_public(COLLATERAL, nonce, client.address.toField(), client.token0.address)
          .send({ from: client.address, fee: client.feeOpts })
          .wait()
        setResult(`Deposited ${COLLATERAL} ${t0sym} as PUBLIC collateral (position keyed by your address).`)
      } else {
        // ld1: pull collateral from the caller's PRIVATE balance via
        // transfer_to_public, authorized through createAuthWit.
        const secret = await ensureSecret()
        const authwit = await client.wallet.createAuthWit(client.address, {
          caller: contract.address as never,
          call: await client.token0.methods
            .transfer_to_public(client.address, contract.address as never, COLLATERAL, nonce)
            .getFunctionCall(),
        })
        await contract.methods
          .deposit_private(client.address, COLLATERAL, nonce, secret, 0n, client.token0.address)
          .send({ from: client.address, fee: client.feeOpts, authWitnesses: [authwit] })
          .wait()
        setResult(`Deposited ${COLLATERAL} ${t0sym} as PRIVATE collateral (position keyed by a secret kept in this tab).`)
      }
    } catch (e) {
      setError(formatError(e))
    } finally {
      setBusy(false)
    }
  }

  async function handleBorrow() {
    if (!contract || !client) return
    if (!isPublic && secretRef.current === null) {
      setError('Deposit collateral first — the same secret keys your private position.')
      return
    }
    setBusy(true)
    setError(null)
    setResult(null)
    try {
      if (isPublic) {
        await contract.methods
          .borrow_public(client.address, BORROW)
          .send({ from: client.address, fee: client.feeOpts })
          .wait()
        setResult(`Borrowed ${BORROW} ${t1sym} publicly (position + debt keyed by your address).`)
      } else {
        await contract.methods
          .borrow_private(secretRef.current, client.address, BORROW)
          .send({ from: client.address, fee: client.feeOpts })
          .wait()
        setResult(`Borrowed ${BORROW} ${t1sym} privately — minted into your balance; LTV checked against the secret-keyed position.`)
      }
    } catch (e) {
      setError(formatError(e))
    } finally {
      setBusy(false)
    }
  }

  const explorer = NETWORKS.testnet.explorerUrl

  const headerTitle = isPublic
    ? 'Lending — fully public baseline (variant ld3) — testnet'
    : 'Lending — private collateral & debt (variant ld1) — testnet'
  const headerCopy = isPublic
    ? `Bundled Lending contract on Aztec testnet, run via deposit_public + borrow_public. Position is keyed by your address (msg_sender) — visible to anyone. Aave baseline. Fees paid by the canonical SponsoredFPC paymaster.`
    : `Bundled Lending contract on Aztec testnet. Your position is keyed by a secret Fr generated in this tab — observers see the contract being called, but cannot link the position to your address. Collateral is pulled from your private ${t0sym}; borrowed ${t1sym} is minted into your balance. Fees paid by the canonical SponsoredFPC paymaster.`

  return (
    <section className="mt-10 rounded-2xl border border-black/10 bg-white p-6">
      <div className="flex items-center justify-between">
        <h3 className="text-lg font-semibold">{headerTitle}</h3>
        <button onClick={onClose} className="text-sm text-black/50 underline-offset-4 hover:underline">
          Close
        </button>
      </div>

      <p className="mt-2 text-sm text-black/60">{headerCopy}</p>

      {cfg && (
        <dl className="mt-3 grid grid-cols-1 gap-x-6 gap-y-1 text-xs md:grid-cols-2">
          <dt className="text-black/40">Lending address</dt>
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
          <dt className="text-black/40">Oracle</dt>
          <dd className="font-mono">{state.priceFeed?.address.slice(0, 18) ?? '—'}…</dd>
          <dt className="text-black/40">Collateral / debt asset</dt>
          <dd className="font-mono">{cfg.collateralAsset} / {cfg.stableCoin}</dd>
          <dt className="text-black/40">LTV (bps)</dt>
          <dd className="font-mono">{cfg.loanToValueBps}</dd>
        </dl>
      )}

      {!client ? (
        <div className="mt-4 rounded-xl border border-amber-200 bg-amber-50/60 p-4 text-sm text-amber-900">
          <p className="font-medium">Wallet not initialized yet</p>
          <p className="mt-1 text-amber-900/80">
            Scroll up to <strong>Your testnet wallet</strong> and click{' '}
            <strong>Initialize wallet</strong>, then grab some {t0sym} from the faucet — the
            borrower needs {t0sym} for collateral. This panel syncs automatically once your
            per-tab account is deployed.
          </p>
        </div>
      ) : !contract ? (
        <p className="mt-4 text-sm text-black/50">Attaching…</p>
      ) : (
        <>
          <div className="mt-4 flex flex-wrap items-center gap-3">
            <button
              onClick={handleDeposit}
              disabled={busy}
              className={`rounded-full px-4 py-2 text-sm font-medium text-white hover:opacity-90 disabled:opacity-50 ${
                isPublic ? 'bg-[var(--color-public)]' : 'bg-[var(--color-private)]'
              }`}
            >
              {busy
                ? 'Submitting…'
                : `Deposit ${COLLATERAL} ${t0sym} ${isPublic ? 'publicly' : 'privately'}`}
            </button>
            <button
              onClick={handleBorrow}
              disabled={busy}
              className={`rounded-full border px-4 py-2 text-sm font-medium hover:opacity-90 disabled:opacity-50 ${
                isPublic
                  ? 'border-[var(--color-public)] text-[var(--color-public)] hover:bg-[var(--color-public)]/5'
                  : 'border-[var(--color-private)] text-[var(--color-private)] hover:bg-[var(--color-private)]/5'
              }`}
            >
              {`Borrow ${BORROW} ${t1sym} ${isPublic ? 'publicly' : 'privately'}`}
            </button>
            <span className="text-xs text-emerald-700">
              account {client.address.toString().slice(0, 8)}…
            </span>
          </div>

          <PrivacyLeakage
            className="mt-4"
            publicLeaks={isPublic ? ['collateral', 'debt', 'borrower'] : ['LTV check passed']}
            staysPrivate={
              isPublic ? [] : ['collateral amount', 'debt amount', 'borrower identity']
            }
          />

          <p className="mt-3 text-[11px] text-black/50">
            The borrower needs {t0sym} for collateral — grab some from the faucet in the wallet
            panel above. If your balance is 0 the deposit will error.
          </p>
        </>
      )}

      {result && (
        <p className="mt-3 rounded-lg border border-emerald-200 bg-emerald-50 p-2 text-xs text-emerald-900">
          {result}
        </p>
      )}
      {error && <TxResult message={error} />}
    </section>
  )
}

function formatError(e: unknown): string {
  if (e instanceof Error) return `${e.name}: ${e.message}`
  return String(e)
}
