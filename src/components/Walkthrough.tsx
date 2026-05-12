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
  const [showAzguard, setShowAzguard] = useState(false)

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
          <h2 className="text-lg font-semibold">Walkthrough</h2>
          <p className="mt-1 max-w-prose text-sm text-black/60">
            Five sections, each demonstrating one Aztec privacy primitive end-to-end. Run them
            in any order once the sandbox is bootstrapped.
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
          title="Bootstrap the sandbox"
          done={hasSandboxDeployment}
          body={
            <>
              In a separate shell:
              <pre className="mt-1 overflow-auto rounded bg-zinc-900 px-2 py-1.5 text-[11px] text-zinc-100">
{`aztec start --local-network --port 8090 \\
  --sequencer.minTxsPerBlock 0 \\
  --sequencer.enforceTimeTable false`}
              </pre>
              <p className="mt-1 text-black/60">
                Both flags are required — without them the L2 proposer stalls around block 30
                and L1→L2 claims fail.
              </p>
            </>
          }
        />

        <Step
          n={2}
          title="Deploy + seed contracts"
          done={hasSandboxDeployment}
          body={
            <>
              <pre className="overflow-auto rounded bg-zinc-900 px-2 py-1.5 text-[11px] text-zinc-100">
{`npm run sandbox:setup    # token+AMM+lending+voting
npm run sandbox:seed     # AMM liquidity + sample swap`}
              </pre>
              <p className="mt-1 text-black/60">
                Mints 1 M private AZA + AZB and 200 k public AZA to the admin.
              </p>
            </>
          }
        />

        <Step
          n={3}
          title="Wire the L1 stack (optional)"
          done={hasUniswapStack}
          body={
            <>
              For the cross-chain bridge + Uniswap-from-L2 demos:
              <pre className="mt-1 overflow-auto rounded bg-zinc-900 px-2 py-1.5 text-[11px] text-zinc-100">
{`npm run sandbox:l1-portal
npm run sandbox:mock-router
npm run sandbox:uniswap`}
              </pre>
              <p className="mt-1 text-black/60">
                Plants a Forge-compiled MockSwapRouter at the V3 mainnet address via{' '}
                <code className="font-mono">anvil_setCode</code>.
              </p>
            </>
          }
        />

        <Step
          n={4}
          title="Click into a section"
          body={
            <>
              Each section has a privacy matrix. Click a "Try variant ?" button → "Initialize
              browser PXE" (loads ~10 MB of WASM once) → action button. The first action takes
              ~10 s; subsequent ones take a few seconds.
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
            </>
          }
        />

        <Step
          n={6}
          title="Network toggle"
          body={
            <>
              The Sandbox / Testnet dropdown in the header is read-only when set to testnet.
              The node-status tile keeps refreshing live, but the deploy + claim demos still
              point at sandbox. See Azguard guide →
              <button
                onClick={() => setShowAzguard((s) => !s)}
                className="ml-1 underline-offset-4 hover:underline"
              >
                {showAzguard ? 'hide' : 'show'}
              </button>
              .
            </>
          }
        />
      </ol>

      {showAzguard && <AzguardGuide currentNetwork={network} />}
    </section>
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

function AzguardGuide({ currentNetwork }: { currentNetwork: NetworkId }) {
  return (
    <div className="mt-4 rounded-xl border border-violet-200 bg-violet-50/60 p-4 text-sm text-violet-950">
      <h3 className="text-sm font-semibold">Run against Aztec testnet with Azguard</h3>
      <p className="mt-1 text-violet-900/80">
        The dashboard's "Initialize browser PXE" path uses pre-funded sandbox test accounts and
        won't work against the public testnet. To take the demos to testnet you need a real
        wallet:
      </p>
      <ol className="mt-2 list-decimal space-y-1 pl-5 text-violet-900">
        <li>
          Install Azguard from the{' '}
          <a
            href="https://chromewebstore.google.com/detail/azguard-wallet/pliilpflcmabdiapdeihifihkbdfnbmn"
            target="_blank"
            rel="noreferrer"
            className="underline underline-offset-4"
          >
            Chrome Web Store
          </a>
          .
        </li>
        <li>Open the side panel, create or restore an Aztec account on Alpha v4 testnet.</li>
        <li>
          Use the wallet's built-in faucet (or the{' '}
          <a
            href="https://aztec-faucet.nethermind.io"
            target="_blank"
            rel="noreferrer"
            className="underline underline-offset-4"
          >
            Nethermind faucet
          </a>
          ) to fund the account with testnet AZA / fee juice.
        </li>
        <li>
          Switch this dashboard's network toggle to{' '}
          <strong>Testnet (Alpha v4)</strong>
          {currentNetwork === 'testnet' ? ' (already selected)' : ''} — it'll read live state
          from <code className="font-mono text-xs">https://aztec.drpc.org</code>.
        </li>
        <li>
          To deploy contracts <em>from a Node.js script</em> against testnet:{' '}
          <code className="font-mono text-xs">npm run testnet:generate-key</code> →{' '}
          <code className="font-mono text-xs">npm run testnet:setup</code>. Uses the canonical
          Aztec Labs testnet RPC and pays fees via the protocol's SponsoredFPC paymaster, so
          no fee-juice claim is needed.
        </li>
      </ol>
      <p className="mt-3 flex flex-wrap gap-3 text-xs text-violet-900/80">
        <span>
          Faucet:{' '}
          <a
            className="underline underline-offset-4"
            href="https://aztec-faucet.nethermind.io"
            target="_blank"
            rel="noreferrer"
          >
            aztec-faucet.nethermind.io
          </a>
        </span>
        <span>
          Explorer:{' '}
          <a
            className="underline underline-offset-4"
            href="https://testnet.aztecscan.xyz"
            target="_blank"
            rel="noreferrer"
          >
            testnet.aztecscan.xyz
          </a>
        </span>
        <span>
          Azguard docs:{' '}
          <a
            className="underline underline-offset-4"
            href="https://azguardwallet.io"
            target="_blank"
            rel="noreferrer"
          >
            azguardwallet.io
          </a>
        </span>
      </p>
    </div>
  )
}
