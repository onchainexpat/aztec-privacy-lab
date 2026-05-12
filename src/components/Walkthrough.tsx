import { useEffect, useState } from 'react'
import type { NetworkId } from '../lib/network'

const STORAGE_KEY = 'aztec-experiments:walkthrough-dismissed'

interface Props {
  network: NetworkId
  hasSandboxDeployment: boolean
  hasUniswapStack: boolean
}

export function Walkthrough({ network, hasSandboxDeployment, hasUniswapStack }: Props) {
  const [dismissed, setDismissed] = useState(false)
  const [showLocal, setShowLocal] = useState(false)

  useEffect(() => {
    if (typeof localStorage !== 'undefined') {
      setDismissed(localStorage.getItem(STORAGE_KEY) === '1')
    }
  }, [])

  function dismiss() {
    setDismissed(true)
    if (typeof localStorage !== 'undefined') localStorage.setItem(STORAGE_KEY, '1')
  }

  function reopen() {
    setDismissed(false)
    if (typeof localStorage !== 'undefined') localStorage.removeItem(STORAGE_KEY)
  }

  if (dismissed) {
    return (
      <div className="mt-2 flex justify-end">
        <button
          onClick={reopen}
          className="text-xs text-black/40 underline-offset-4 hover:text-black/70 hover:underline"
        >
          Show walkthrough
        </button>
      </div>
    )
  }

  return (
    <section className="mt-6 rounded-2xl border border-black/10 bg-gradient-to-br from-violet-50/40 via-white to-sky-50/40 p-5">
      <div className="flex items-start justify-between gap-4">
        <div>
          <h2 className="text-lg font-semibold">How to use this playground</h2>
          <p className="mt-1 max-w-prose text-sm text-black/60">
            Four interactive demos on Aztec Alpha v4 testnet — AMM swap, lending (ld2),
            anonymous voting, and shield/unshield in the wallet panel below. Each one
            generates a real ClientIVC proof in your browser. No wallet install required.
          </p>
        </div>
        <button
          onClick={dismiss}
          className="shrink-0 rounded-full px-2 py-0.5 text-xs text-black/40 hover:bg-black/5 hover:text-black/70"
          title="Hide this walkthrough"
        >
          dismiss
        </button>
      </div>

      <ol className="mt-4 grid grid-cols-1 gap-3 text-sm md:grid-cols-2 lg:grid-cols-3">
        <Step
          n={1}
          title="Initialize your wallet"
          body={
            <>
              The <strong>Your testnet wallet</strong> panel below generates a fresh Schnorr
              account in your browser, deploys it to Aztec testnet via the SponsoredFPC
              paymaster, and persists the credentials to{' '}
              <code className="font-mono text-xs">localStorage</code>. First-time setup
              takes 1-2 minutes (account-deploy IVC proof). Reuse across reloads is instant.
            </>
          }
        />

        <Step
          n={2}
          title="Get funds"
          body={
            <>
              Click <strong>+10k pub</strong> or <strong>+10k priv</strong> in the wallet
              panel to mint 10,000 azETH or azUSDC into your account. Public mint is faster
              (~36 s for block inclusion). Private mint generates an extra IVC proof on the
              faucet side (~40 s). Rate-limited per address.
            </>
          }
        />

        <Step
          n={3}
          title="Shield / unshield"
          body={
            <>
              The wallet's <strong>shield</strong> button converts your public balance into a
              private note via <code className="font-mono text-xs">Token.transfer_to_private</code>
              ; <strong>unshield</strong> does the reverse. Watch the <strong>Generating ZK
              proof</strong> pill in the header — that's bb.js producing a real proof in your
              tab, not on a server.
            </>
          }
        />

        <Step
          n={4}
          title="Try a demo variant"
          body={
            <>
              Scroll to a privacy matrix (AMM, Lending, Voting…) and click the{' '}
              <strong>Try variant ?</strong> button. Each interactive variant on testnet
              reuses your wallet — no second initialization. The proof log under the panel
              streams the SDK events (witness gen, proof, tx submit) so you can see what's
              happening.
            </>
          }
        />

        <Step
          n={5}
          title="Watch the privacy delta"
          body={
            <>
              Side-by-side variants in the same section let you compare what's hidden vs
              public. e.g. lending ld1 (private collateral, secret-keyed) vs ld3 (Aave-style
              fully public) use the <em>same contract</em> — only the entrypoints differ.
              ld2 splits the difference: public deposit, private debt.
            </>
          }
        />

        <Step
          n={6}
          title="Optional — connect Azguard"
          body={
            <>
              <strong>Connect wallet</strong> in the header links your Azguard browser
              extension. Today this is informational only — the demos still use the per-tab
              account. Routing transactions through Azguard's RPC (
              <code className="font-mono text-xs">client.execute(…)</code>) is a planned
              future addition.
            </>
          }
        />
      </ol>

      <p className="mt-4 text-xs text-black/50">
        Running locally as a dev?{' '}
        <button
          onClick={() => setShowLocal((s) => !s)}
          className="underline-offset-4 hover:underline"
        >
          {showLocal ? 'hide' : 'show'} sandbox bootstrap steps
        </button>
      </p>

      {showLocal && (
        <LocalDevSteps
          hasSandboxDeployment={hasSandboxDeployment}
          hasUniswapStack={hasUniswapStack}
          network={network}
        />
      )}
    </section>
  )
}

function LocalDevSteps({
  hasSandboxDeployment,
  hasUniswapStack,
  network,
}: {
  hasSandboxDeployment: boolean
  hasUniswapStack: boolean
  network: NetworkId
}) {
  return (
    <div className="mt-3 rounded-xl border border-zinc-200 bg-zinc-50 p-4 text-xs text-zinc-700">
      <p className="text-zinc-900">
        The default deploy on Vercel runs against testnet. To iterate against a local
        sandbox (faster block times, no faucet, no real proofs by default), clone the repo
        and:
      </p>
      <ol className="mt-2 grid grid-cols-1 gap-3 md:grid-cols-3">
        <LocalStep
          n={1}
          title="Start the sandbox"
          done={hasSandboxDeployment && network === 'sandbox'}
          body={
            <>
              <pre className="mt-1 overflow-auto rounded bg-zinc-900 px-2 py-1.5 text-[11px] text-zinc-100">
{`aztec start --local-network --port 8090 \\
  --sequencer.minTxsPerBlock 0 \\
  --sequencer.enforceTimeTable false`}
              </pre>
              <p className="mt-1 text-zinc-600">
                Both sequencer flags required — without them the L2 proposer stalls.
              </p>
            </>
          }
        />
        <LocalStep
          n={2}
          title="Deploy + seed contracts"
          done={hasSandboxDeployment && network === 'sandbox'}
          body={
            <pre className="overflow-auto rounded bg-zinc-900 px-2 py-1.5 text-[11px] text-zinc-100">
{`npm run sandbox:setup
npm run sandbox:seed`}
            </pre>
          }
        />
        <LocalStep
          n={3}
          title="Optional — L1 bridge stack"
          done={hasUniswapStack && network === 'sandbox'}
          body={
            <>
              <pre className="overflow-auto rounded bg-zinc-900 px-2 py-1.5 text-[11px] text-zinc-100">
{`npm run sandbox:l1-portal
npm run sandbox:mock-router
npm run sandbox:uniswap`}
              </pre>
              <p className="mt-1 text-zinc-600">For the cross-chain bridge demo.</p>
            </>
          }
        />
      </ol>
      <p className="mt-3 text-zinc-600">
        Then toggle the header to <strong>Sandbox</strong> and the dashboard switches
        wholesale.
      </p>
    </div>
  )
}

function Step({
  n,
  title,
  body,
  done,
}: {
  n: number
  title: string
  body: React.ReactNode
  done?: boolean
}) {
  return (
    <li className="flex gap-3 rounded-xl border border-black/10 bg-white/70 p-3">
      <span
        className={`mt-0.5 flex size-6 shrink-0 items-center justify-center rounded-full text-xs font-mono ${
          done
            ? 'bg-emerald-500 text-white'
            : 'border border-black/20 bg-white text-black/60'
        }`}
        aria-hidden
      >
        {done ? '✓' : n}
      </span>
      <div className="min-w-0 flex-1">
        <h3 className="text-sm font-semibold">{title}</h3>
        <div className="mt-1 text-[13px] text-black/70 [&_pre]:my-1">{body}</div>
      </div>
    </li>
  )
}

function LocalStep({
  n,
  title,
  body,
  done,
}: {
  n: number
  title: string
  body: React.ReactNode
  done?: boolean
}) {
  return (
    <li className="flex gap-3 rounded-lg border border-zinc-200 bg-white p-3">
      <span
        className={`mt-0.5 flex size-5 shrink-0 items-center justify-center rounded-full text-[10px] font-mono ${
          done ? 'bg-emerald-500 text-white' : 'border border-zinc-300 bg-white text-zinc-600'
        }`}
        aria-hidden
      >
        {done ? '✓' : n}
      </span>
      <div className="min-w-0 flex-1">
        <h4 className="text-xs font-semibold text-zinc-900">{title}</h4>
        <div className="mt-1 text-[11px] text-zinc-600 [&_pre]:my-1">{body}</div>
      </div>
    </li>
  )
}
