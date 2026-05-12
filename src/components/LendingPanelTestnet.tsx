import { useEffect, useRef, useState } from 'react'
import { initTestnetClient, resetTestnetAccount, type TestnetClient } from '../lib/browser-testnet'
import type { SandboxState } from '../lib/sandbox-state'
import { NETWORKS } from '../lib/network'
import { faucetMint, isFaucetConfigured, FAUCET_URL } from '../lib/faucet'
import { captureProofLog, type ProofEvent } from '../lib/proof-log'

interface Props {
  state: SandboxState
  onClose: () => void
}

interface Balances {
  privateAZA: bigint
  publicAZA: bigint
  privateAZB: bigint
  publicAZB: bigint
}

interface Position {
  collateral: bigint
  debt: bigint
}

const DEPOSIT_AMOUNT = 5_000n
const BORROW_AMOUNT = 1_000n

export function LendingPanelTestnet({ state, onClose }: Props) {
  const [progress, setProgress] = useState<string | null>(null)
  const [client, setClient] = useState<TestnetClient | null>(null)
  const [error, setError] = useState<string | null>(null)
  const [result, setResult] = useState<string | null>(null)
  const [busy, setBusy] = useState(false)
  const [balances, setBalances] = useState<Balances | null>(null)
  const [position, setPosition] = useState<Position | null>(null)
  const [pendingMint, setPendingMint] = useState<{ token: string; txHash: string } | null>(null)
  const [proofLog, setProofLog] = useState<ProofEvent[]>([])
  const pollRef = useRef<number | null>(null)
  const logScrollRef = useRef<HTMLDivElement | null>(null)

  function pushProofEvent(ev: ProofEvent) {
    setProofLog((prev) => {
      const next = prev.concat(ev)
      // Cap at last 100 to keep the UI snappy.
      return next.length > 100 ? next.slice(next.length - 100) : next
    })
  }

  function pushNote(message: string) {
    pushProofEvent({ ts: Date.now(), kind: 'note', source: 'dashboard', message })
  }

  useEffect(() => {
    // Autoscroll to the latest log entry on every push.
    const el = logScrollRef.current
    if (el) el.scrollTop = el.scrollHeight
  }, [proofLog])

  const cfg = NETWORKS.testnet
  const ld2 = state.publicCollateralPrivateDebt
  const faucetReady = isFaucetConfigured()

  useEffect(() => {
    if (!client) return
    void refreshAll(client)
  }, [client])

  // While a mint tx is pending, poll balances every 15s so the visitor sees
  // the bump arrive without manually refreshing.
  useEffect(() => {
    if (!client || !pendingMint) return
    pollRef.current = window.setInterval(() => {
      void refreshAll(client)
    }, 15_000)
    return () => {
      if (pollRef.current !== null) window.clearInterval(pollRef.current)
    }
  }, [client, pendingMint])

  async function refreshAll(c: TestnetClient) {
    await Promise.all([refreshBalances(c), refreshPosition(c)])
  }

  async function refreshBalances(c: TestnetClient) {
    try {
      const [pA, uA, pB, uB] = await Promise.all([
        c.token0.methods.balance_of_private(c.address).simulate({ from: c.address }),
        c.token0.methods.balance_of_public(c.address).simulate({ from: c.address }),
        c.token1.methods.balance_of_private(c.address).simulate({ from: c.address }),
        c.token1.methods.balance_of_public(c.address).simulate({ from: c.address }),
      ])
      const next: Balances = {
        privateAZA: pA.result as bigint,
        publicAZA: uA.result as bigint,
        privateAZB: pB.result as bigint,
        publicAZB: uB.result as bigint,
      }
      setBalances(next)
      // Clear pending mint flag once the relevant balance has actually moved.
      if (pendingMint) {
        const expected = pendingMint.token === 'AZA' ? next.publicAZA : next.publicAZB
        if (expected > 0n) setPendingMint(null)
      }
    } catch {
      // transient PXE sync failures are fine
    }
  }

  async function refreshPosition(c: TestnetClient) {
    if (!c.ld2) return
    try {
      const [coll, dbt] = await Promise.all([
        c.ld2.methods.get_collateral(c.ld2Commitment).simulate({ from: c.address }),
        c.ld2.methods.get_debt(c.ld2Commitment).simulate({ from: c.address }),
      ])
      setPosition({
        collateral: coll.result as bigint,
        debt: dbt.result as bigint,
      })
    } catch {
      // ignore
    }
  }

  async function handleInit() {
    setError(null)
    setBusy(true)
    setProofLog([])
    const stopCapture = captureProofLog(pushProofEvent)
    try {
      const c = await initTestnetClient(state, (msg) => {
        setProgress(msg)
        pushNote(msg)
      })
      setClient(c)
      if (c.freshAccount) {
        setResult(
          `Your testnet account deployed at ${shortAddr(c.address.toString())} — fees paid by the canonical SponsoredFPC paymaster. Saved to localStorage so it persists across reloads.`,
        )
      }
    } catch (e) {
      setError(formatError(e))
    } finally {
      stopCapture()
      setBusy(false)
    }
  }

  async function handleResetAccount() {
    resetTestnetAccount()
    setClient(null)
    setBalances(null)
    setPosition(null)
    setPendingMint(null)
    setResult('Local account credentials cleared. Click "Initialize" to generate a new one.')
  }

  async function handleFaucet() {
    if (!client) return
    setError(null)
    setBusy(true)
    setResult(null)
    pushNote('requesting 10k AZA from faucet…')
    try {
      const resp = await faucetMint(client.address.toString(), 'AZA')
      setPendingMint({ token: 'AZA', txHash: resp.txHash })
      pushNote(`faucet tx submitted: ${shortHex(resp.txHash)}`)
      setResult(
        `Faucet mint submitted: ${resp.amount} AZA → your address. tx ${shortHex(resp.txHash)}. ` +
          `Block inclusion takes ~36 s on testnet; the balance below will update once it lands.`,
      )
    } catch (e) {
      setError(formatError(e))
    } finally {
      setBusy(false)
    }
  }

  async function handleDeposit() {
    if (!client?.ld2) return
    setError(null)
    setBusy(true)
    setResult(null)
    pushNote('deposit_public — building authwit + tx…')
    const stopCapture = captureProofLog(pushProofEvent)
    try {
      const { Fr } = await import('@aztec/aztec.js/fields')
      const { SetPublicAuthwitContractInteraction } = await import('@aztec/aztec.js/authorization')
      const nonce = Fr.random()
      // Authorise ld2 to pull DEPOSIT_AMOUNT AZA from our public balance.
      const authIntent = {
        caller: client.ld2.address,
        call: await client.token0.methods
          .transfer_in_public(client.address, client.ld2.address, DEPOSIT_AMOUNT, nonce)
          .getFunctionCall(),
      }
      const authInteraction = await SetPublicAuthwitContractInteraction.create(
        client.wallet,
        client.address,
        authIntent,
        true,
      )
      await authInteraction.send({ fee: client.feeOpts })
      await client.ld2.methods
        .deposit_public(DEPOSIT_AMOUNT, client.ld2Commitment, nonce)
        .send({ from: client.address, fee: client.feeOpts })
      setResult(
        `Deposited ${DEPOSIT_AMOUNT} AZA publicly into commitment ${shortHex(
          '0x' + client.ld2Commitment.toString(16),
        )} on ld2.`,
      )
      await refreshAll(client)
    } catch (e) {
      setError(formatError(e))
    } finally {
      stopCapture()
      setBusy(false)
    }
  }

  async function handleBorrow() {
    if (!client?.ld2) return
    setError(null)
    setBusy(true)
    setResult(null)
    pushNote('borrow_private — generating IVC proof (~1-2 min)…')
    const stopCapture = captureProofLog(pushProofEvent)
    try {
      const { Fr } = await import('@aztec/aztec.js/fields')
      const secret = Fr.fromString(client.accountSecretHex)
      await client.ld2.methods
        .borrow_private(secret, client.address, BORROW_AMOUNT)
        .send({ from: client.address, fee: client.feeOpts })
      setResult(
        `Borrowed ${BORROW_AMOUNT} AZB as a PRIVATE note. Public LTV check enforced against the commitment — the contract sees the commitment + new debt total, not your address.`,
      )
      await refreshAll(client)
    } catch (e) {
      setError(formatError(e))
    } finally {
      stopCapture()
      setBusy(false)
    }
  }

  return (
    <section className="mt-10 rounded-2xl border border-black/10 bg-white p-6">
      <div className="flex items-center justify-between">
        <h3 className="text-lg font-semibold">
          Lending — public collateral · private debt (variant ld2) on testnet
        </h3>
        <button onClick={onClose} className="text-sm text-black/50 underline-offset-4 hover:underline">
          Close
        </button>
      </div>

      <p className="mt-2 text-sm text-black/60">
        Custom <code className="font-mono text-xs">PublicCollateralPrivateDebt</code> contract
        deployed on Aztec Alpha v4 testnet. Each visitor gets their own per-tab Schnorr
        account (persisted in localStorage). Fees on every tx paid by the canonical
        SponsoredFPC paymaster — no fee-juice claim needed.
      </p>

      {ld2 && (
        <dl className="mt-3 grid grid-cols-1 gap-x-6 gap-y-1 text-xs md:grid-cols-2">
          <dt className="text-black/40">Contract address</dt>
          <dd className="font-mono">
            <a
              href={`${cfg.explorerUrl}/contracts/${ld2.address}`}
              target="_blank"
              rel="noreferrer"
              className="underline-offset-4 hover:underline"
            >
              {ld2.address.slice(0, 16)}… ↗
            </a>
          </dd>
          <dt className="text-black/40">Collateral / debt asset</dt>
          <dd className="font-mono">{ld2.collateralAsset} / {ld2.debtAsset}</dd>
          <dt className="text-black/40">Max LTV</dt>
          <dd className="font-mono">{ld2.ltvNumerator}/{ld2.ltvDenominator}</dd>
        </dl>
      )}

      {!client ? (
        <div className="mt-5">
          <button
            onClick={handleInit}
            disabled={busy}
            className="rounded-full bg-[var(--color-ink)] px-4 py-2 text-sm font-medium text-[var(--color-paper)] hover:opacity-90 disabled:opacity-50"
          >
            {busy ? 'Initializing…' : 'Initialize browser PXE + account on testnet'}
          </button>
          {progress && busy && <p className="mt-2 text-xs text-black/50">{progress}</p>}
          <p className="mt-3 max-w-prose text-xs text-black/50">
            First click is slow (~1-2 minutes): loads ~10 MB of WASM, syncs the PXE against
            the canonical testnet RPC, generates a fresh Schnorr account, and proves the
            account-deploy circuit before sending the tx. The account contract bytes live in
            <code className="font-mono"> localStorage</code> after that, so subsequent visits
            skip the deploy and just sync.
          </p>
        </div>
      ) : (
        <>
          <div className="mt-5 rounded-xl border border-sky-200 bg-sky-50/50 p-4 text-sm">
            <div className="flex flex-wrap items-center gap-x-6 gap-y-2">
              <div>
                <p className="text-xs uppercase tracking-wide text-sky-900/60">
                  your testnet account
                </p>
                <p className="mt-0.5 font-mono text-sky-950">
                  {shortAddr(client.address.toString())}
                </p>
              </div>
              <div>
                <p className="text-xs uppercase tracking-wide text-sky-900/60">
                  ld2 commitment
                </p>
                <p
                  className="mt-0.5 font-mono text-sky-950"
                  title={'0x' + client.ld2Commitment.toString(16)}
                >
                  {shortHex('0x' + client.ld2Commitment.toString(16))}
                </p>
              </div>
              {cfg.explorerUrl && (
                <a
                  href={`${cfg.explorerUrl}/contracts/${client.address.toString()}`}
                  target="_blank"
                  rel="noreferrer"
                  className="text-xs text-sky-700 underline-offset-4 hover:underline"
                >
                  Aztecscan ↗
                </a>
              )}
              <button
                onClick={handleResetAccount}
                className="ml-auto text-xs text-black/40 underline-offset-4 hover:text-black/70 hover:underline"
              >
                reset local account
              </button>
            </div>
          </div>

          {balances && (
            <div className="mt-3 grid grid-cols-1 gap-3 rounded-xl border border-black/10 bg-zinc-50 p-3 text-sm md:grid-cols-2">
              <Stat label="AZA balance" privAmt={balances.privateAZA} pubAmt={balances.publicAZA} />
              <Stat label="AZB balance" privAmt={balances.privateAZB} pubAmt={balances.publicAZB} />
            </div>
          )}

          <div className="mt-4 flex flex-wrap items-center gap-3">
            <button
              onClick={handleFaucet}
              disabled={busy || !faucetReady || !!pendingMint}
              className="rounded-full bg-[var(--color-public)] px-4 py-2 text-sm font-medium text-white hover:opacity-90 disabled:opacity-50"
              title={!faucetReady ? 'Faucet URL not configured — set VITE_FAUCET_URL' : ''}
            >
              {pendingMint
                ? 'Faucet mint pending…'
                : faucetReady
                  ? 'Request 10k AZA from faucet'
                  : 'Faucet not configured'}
            </button>
            <button
              onClick={handleDeposit}
              disabled={busy || !balances || balances.publicAZA < DEPOSIT_AMOUNT}
              className="rounded-full bg-[var(--color-public)] px-4 py-2 text-sm font-medium text-white hover:opacity-90 disabled:opacity-50"
            >
              {`Deposit ${DEPOSIT_AMOUNT} AZA publicly (to commitment)`}
            </button>
            <button
              onClick={handleBorrow}
              disabled={busy || !position || position.collateral === 0n}
              className="rounded-full border border-[var(--color-private)] bg-[var(--color-private)]/5 px-4 py-2 text-sm font-medium text-[var(--color-private)] hover:bg-[var(--color-private)]/10 disabled:opacity-50"
              title={
                !position || position.collateral === 0n
                  ? 'Need collateral against your commitment first — deposit AZA'
                  : ''
              }
            >
              {`Borrow ${BORROW_AMOUNT} AZB privately`}
            </button>
            {busy && progress && (
              <span className="text-xs text-black/50">{progress}</span>
            )}
          </div>

          {position && (
            <div className="mt-4 rounded-xl border border-amber-200 bg-amber-50/60 p-3 text-xs text-amber-900">
              <p className="font-medium">
                On-chain position against your commitment (publicly readable)
              </p>
              <dl className="mt-2 grid grid-cols-1 gap-x-6 gap-y-1 md:grid-cols-2">
                <dt className="text-amber-900/60">commitment</dt>
                <dd className="font-mono">
                  {shortHex('0x' + client.ld2Commitment.toString(16))}
                </dd>
                <dt className="text-amber-900/60">collateral</dt>
                <dd className="font-mono">{fmt(position.collateral)} {ld2?.collateralAsset ?? 'AZA'}</dd>
                <dt className="text-amber-900/60">debt</dt>
                <dd className="font-mono">{fmt(position.debt)} {ld2?.debtAsset ?? 'AZB'}</dd>
              </dl>
              <p className="mt-2 text-amber-900/70">
                Debt is enforced in public state for the LTV check — but the borrower's
                identity isn't tied to it. Anyone can read the commitment + debt, no-one can
                link them back to a wallet without the visitor's account secret.
              </p>
            </div>
          )}

          {!faucetReady && (
            <p className="mt-3 text-[11px] text-black/50">
              No faucet URL configured. Set <code className="font-mono">VITE_FAUCET_URL</code>{' '}
              at build time and rebuild — see <code className="font-mono">faucet/README.md</code>.
              Without it the deposit + borrow buttons stay disabled because per-tab accounts
              start at 0 AZA. Current value: <code className="font-mono">{FAUCET_URL || '(unset)'}</code>.
            </p>
          )}
        </>
      )}

      {proofLog.length > 0 && (
        <details className="mt-4" open>
          <summary className="cursor-pointer text-xs text-black/60 hover:underline">
            proof log ({proofLog.length} events)
          </summary>
          <div
            ref={logScrollRef}
            className="mt-2 max-h-56 overflow-auto rounded-lg border border-black/10 bg-zinc-950 p-3 font-mono text-[11px] leading-relaxed text-zinc-100"
          >
            {proofLog.map((ev, i) => (
              <div key={i} className="flex gap-3">
                <span className="shrink-0 text-zinc-500">
                  {new Date(ev.ts).toLocaleTimeString('en-US', { hour12: false })}
                </span>
                <span
                  className={`shrink-0 ${ev.kind === 'note' ? 'text-amber-300' : 'text-sky-300'}`}
                >
                  {ev.source}
                </span>
                <span className="text-zinc-100">{ev.message}</span>
              </div>
            ))}
          </div>
        </details>
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

function Stat({ label, privAmt, pubAmt }: { label: string; privAmt: bigint; pubAmt: bigint }) {
  return (
    <div>
      <p className="text-xs uppercase tracking-wide text-black/40">{label}</p>
      <p className="mt-0.5 flex items-center gap-2 font-mono">
        <span className="inline-flex items-center gap-1 text-violet-700">
          <span className="size-1.5 rounded-full bg-violet-500" />
          {fmt(privAmt)} priv
        </span>
        <span className="inline-flex items-center gap-1 text-sky-700">
          <span className="size-1.5 rounded-full bg-sky-500" />
          {fmt(pubAmt)} pub
        </span>
      </p>
    </div>
  )
}

function fmt(n: bigint): string {
  return Number(n).toLocaleString('en-US')
}

function shortAddr(a: string): string {
  return `${a.slice(0, 10)}…${a.slice(-6)}`
}

function shortHex(s: string): string {
  if (s.length <= 14) return s
  return `${s.slice(0, 10)}…${s.slice(-4)}`
}

function formatError(e: unknown): string {
  if (e instanceof Error) return `${e.name}: ${e.message}`
  return String(e)
}
