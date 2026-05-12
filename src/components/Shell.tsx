import { useEffect, useState } from 'react'
import { NETWORKS, loadNetwork, saveNetwork, type NetworkId } from '../lib/network'
import { type ConnectedAccount } from '../lib/wallet'
import { NetworkBadge } from './NetworkBadge'
import { WalletConnect } from './WalletConnect'
import { NodeStatus } from './NodeStatus'
import { HeaderProofIndicator } from './HeaderProofIndicator'
import { SandboxStatePanel } from './SandboxState'
import { StatsStrip } from './StatsStrip'
import { Walkthrough } from './Walkthrough'
import { WalletPanel } from './WalletPanel'
import { PrivacyMatrix } from './PrivacyMatrix'
import { SwapPanel } from './SwapPanel'
import { AMMPanelTestnet } from './AMMPanelTestnet'
import { LaunchpadMatrix } from './LaunchpadMatrix'
import { LaunchpadPanel } from './LaunchpadPanel'
import { LaunchpadPanelTestnet } from './LaunchpadPanelTestnet'
import { LendingMatrix } from './LendingMatrix'
import { LendingPanel } from './LendingPanel'
import { LendingPanelTestnet } from './LendingPanelTestnet'
import { CrossChainCard } from './CrossChainCard'
import { VotingPanel } from './VotingPanel'
import { VotingPanelTestnet } from './VotingPanelTestnet'
import { BridgePanel } from './BridgePanel'
import { loadDeployState, type SandboxState } from '../lib/sandbox-state'
import type { Variation } from '../data/variations'
import type { LaunchpadVariation } from '../data/launchpad'
import type { LendingVariation } from '../data/lending'

export function Shell() {
  // Lazy initializer so the first render already has the correct network. If
  // we instead used `useState('sandbox')` + a useEffect to call loadNetwork(),
  // there's a 1-render window where network='sandbox' + the state-load
  // useEffect fires → a stale sandbox fetch races against the subsequent
  // testnet fetch and sometimes wins, leaving sandboxState pointing at
  // localhost:8090. Initializing synchronously avoids the race entirely.
  const [network, setNetwork] = useState<NetworkId>(() => loadNetwork())
  const [account, setAccount] = useState<ConnectedAccount | null>(null)
  const [activeVariant, setActiveVariant] = useState<Variation['id'] | null>(null)
  const [activeLaunchpad, setActiveLaunchpad] = useState<LaunchpadVariation['id'] | null>(null)
  const [activeLending, setActiveLending] = useState<LendingVariation['id'] | null>(null)
  const [votingOpen, setVotingOpen] = useState(false)
  const [bridgeOpen, setBridgeOpen] = useState(false)
  const [sandboxState, setSandboxState] = useState<SandboxState | null>(null)

  useEffect(() => {
    let cancelled = false
    setSandboxState(null)
    loadDeployState(network).then((s) => {
      if (!cancelled) setSandboxState(s)
    })
    return () => {
      cancelled = true
    }
  }, [network])

  function changeNetwork(id: NetworkId) {
    setNetwork(id)
    saveNetwork(id)
  }

  const cfg = NETWORKS[network]

  return (
    <div className="mx-auto flex min-h-screen max-w-6xl flex-col px-6 py-6">
      <header className="flex items-center justify-between gap-4">
        <div className="flex items-center gap-3">
          <div className="size-8 rounded-lg bg-[var(--color-ink)]" />
          <div>
            <h1 className="text-lg font-semibold">Aztec Privacy Lab</h1>
            <p className="text-xs text-black/50">
              Try Noir privacy variations on Aztec — see what's hidden vs public.
            </p>
          </div>
        </div>
        <div className="flex items-center gap-3">
          <HeaderProofIndicator />
          {cfg.faucetUrl && (
            <a
              href={cfg.faucetUrl}
              target="_blank"
              rel="noreferrer"
              className="text-sm text-black/60 underline-offset-4 hover:underline"
            >
              Faucet ↗
            </a>
          )}
          {cfg.explorerUrl && (
            <a
              href={cfg.explorerUrl}
              target="_blank"
              rel="noreferrer"
              className="text-sm text-black/60 underline-offset-4 hover:underline"
            >
              Explorer ↗
            </a>
          )}
          <NetworkBadge current={network} onChange={changeNetwork} />
          <WalletConnect account={account} onChange={setAccount} />
        </div>
      </header>

      <section className="mt-6">
        <StatsStrip network={network} />
      </section>

      <Walkthrough
        network={network}
        hasSandboxDeployment={!!sandboxState?.amm}
        hasUniswapStack={!!sandboxState?.crossChain?.l1UniswapPortal}
      />

      {network === 'testnet' && sandboxState && <WalletPanel state={sandboxState} />}

      <section className="mt-4 grid grid-cols-1 gap-4 lg:grid-cols-[1fr_2fr]">
        <NodeStatus network={network} />
        <SandboxStatePanel state={sandboxState} network={network} />
      </section>

      <main className="mt-10 flex-1">
        <PrivacyMatrix onTry={(id) => setActiveVariant(id)} />

        {(activeVariant === 'a' || activeVariant === 'f') &&
          sandboxState &&
          network === 'testnet' && (
            <AMMPanelTestnet
              state={sandboxState}
              initialFocus={activeVariant === 'f' ? 'lp' : 'swap'}
              onClose={() => setActiveVariant(null)}
            />
          )}
        {activeVariant &&
          sandboxState &&
          network === 'sandbox' &&
          (activeVariant === 'a' || activeVariant === 'c' || activeVariant === 'f') && (
            <SwapPanel
              variant={activeVariant}
              state={sandboxState}
              onClose={() => setActiveVariant(null)}
            />
          )}
        {activeVariant && !sandboxState && (
          <section className="mt-10 rounded-2xl border border-amber-200 bg-amber-50 p-6 text-sm text-amber-900">
            Variant {activeVariant} needs the sandbox deployment. Run{' '}
            <code>npm run sandbox:setup</code> and reload.
            <button onClick={() => setActiveVariant(null)} className="ml-3 underline">
              Close
            </button>
          </section>
        )}

        <div className="mt-16">
          <LaunchpadMatrix onTry={(id) => setActiveLaunchpad(id)} />
        </div>

        {activeLaunchpad === 'lp1' && sandboxState && network === 'testnet' && (
          <LaunchpadPanelTestnet
            state={sandboxState}
            onClose={() => setActiveLaunchpad(null)}
          />
        )}
        {(activeLaunchpad === 'lp1' || activeLaunchpad === 'lp2' || activeLaunchpad === 'lp3') &&
          sandboxState &&
          network === 'sandbox' && (
            <LaunchpadPanel
              variant={activeLaunchpad}
              state={sandboxState}
              onClose={() => setActiveLaunchpad(null)}
            />
          )}
        {(activeLaunchpad === 'lp2' || activeLaunchpad === 'lp3') &&
          sandboxState &&
          network === 'testnet' && (
            <section className="mt-10 rounded-2xl border border-amber-200 bg-amber-50 p-6 text-sm text-amber-900">
              Variant {activeLaunchpad} uses a custom Noir contract that's currently only deployed
              on the sandbox. Switch the network toggle to <strong>Sandbox</strong> to try it, or
              ask for a testnet port.
              <button
                onClick={() => setActiveLaunchpad(null)}
                className="ml-3 underline"
              >
                Close
              </button>
            </section>
          )}

        <div className="mt-16">
          <LendingMatrix onTry={(id) => setActiveLending(id)} />
        </div>

        {activeLending === 'ld2' && sandboxState && network === 'testnet' && (
          <LendingPanelTestnet
            state={sandboxState}
            azguardAccount={account}
            onClose={() => setActiveLending(null)}
          />
        )}
        {(activeLending === 'ld1' || activeLending === 'ld2' || activeLending === 'ld3') &&
          sandboxState &&
          network === 'sandbox' && (
            <LendingPanel
              variant={activeLending}
              state={sandboxState}
              onClose={() => setActiveLending(null)}
            />
          )}

        <div className="mt-16 rounded-2xl border border-black/10 bg-white p-6">
          <div className="flex items-start justify-between gap-4">
            <div>
              <h2 className="text-xl font-semibold">Anonymous voting</h2>
              <p className="mt-1 text-sm text-black/60">
                One bonus primitive: a fully private vote whose tally accumulates in public
                state. The contract uses a nullifier-backed{' '}
                <code className="font-mono text-xs">SingleUseClaim</code> so each address can
                vote at most once per election.
              </p>
            </div>
            {!votingOpen && (
              <button
                onClick={() => setVotingOpen(true)}
                className="shrink-0 rounded-full bg-[var(--color-ink)] px-3 py-1.5 text-sm font-medium text-[var(--color-paper)] hover:opacity-90"
              >
                Try voting →
              </button>
            )}
          </div>
        </div>

        {votingOpen && sandboxState && network === 'testnet' && (
          <VotingPanelTestnet
            state={sandboxState}
            azguardAccount={account}
            onClose={() => setVotingOpen(false)}
          />
        )}
        {votingOpen && sandboxState && network === 'sandbox' && (
          <VotingPanel state={sandboxState} onClose={() => setVotingOpen(false)} />
        )}

        {network === 'sandbox' && (
          <div className="mt-16">
            <CrossChainCard />
            {sandboxState?.crossChain?.l1Portal && (
              <div className="mt-4">
                {!bridgeOpen ? (
                  <button
                    onClick={() => setBridgeOpen(true)}
                    className="rounded-full bg-[var(--color-ink)] px-3 py-1.5 text-sm font-medium text-[var(--color-paper)] hover:opacity-90"
                  >
                    Try L1 → L2 bridge →
                  </button>
                ) : (
                  <BridgePanel state={sandboxState} onClose={() => setBridgeOpen(false)} />
                )}
              </div>
            )}
          </div>
        )}
      </main>

      <footer className="mt-16 border-t border-black/10 pt-6 pb-4 text-xs text-black/50">
        <div className="flex flex-col gap-3 sm:flex-row sm:items-center sm:justify-between">
          <p className="max-w-prose">
            Experimental research dashboard. Not audited. Contracts are demos meant to illustrate
            Aztec's privacy model — do not deposit real funds. Built against{' '}
            <code className="font-mono">@aztec/aztec.js@4.2.0-rc.1</code> + Aztec Alpha v4 testnet
            (L1 settles to Sepolia).{' '}
            <span className="whitespace-nowrap">
              build{' '}
              <a
                href={`https://github.com/onchainexpat/aztec-privacy-lab/commit/${__APP_GIT_SHA__}`}
                target="_blank"
                rel="noreferrer"
                className="font-mono underline-offset-4 hover:underline"
                title={`built ${__APP_BUILD_TIME__}`}
              >
                {__APP_GIT_SHA__}
              </a>
              {' · '}
              {formatBuildAge(__APP_BUILD_TIME__)}
            </span>
          </p>
          <div className="flex gap-4">
            <a
              href="https://docs.aztec.network"
              target="_blank"
              rel="noreferrer"
              className="underline-offset-4 hover:underline"
            >
              Aztec docs ↗
            </a>
            <a
              href="https://noir-lang.org"
              target="_blank"
              rel="noreferrer"
              className="underline-offset-4 hover:underline"
            >
              Noir ↗
            </a>
            <a
              href="https://testnet.aztecscan.xyz"
              target="_blank"
              rel="noreferrer"
              className="underline-offset-4 hover:underline"
            >
              Aztecscan ↗
            </a>
          </div>
        </div>
      </footer>
    </div>
  )
}

function formatBuildAge(iso: string): string {
  try {
    const ms = Date.now() - new Date(iso).getTime()
    if (ms < 0) return iso
    const s = Math.round(ms / 1000)
    if (s < 60) return `${s} s ago`
    const m = Math.round(s / 60)
    if (m < 60) return `${m} min ago`
    const h = Math.round(m / 60)
    if (h < 48) return `${h} h ago`
    const d = Math.round(h / 24)
    return `${d} d ago`
  } catch {
    return 'unknown'
  }
}
