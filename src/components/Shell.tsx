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
import { GamesMatrix } from './GamesMatrix'
import { MinesweeperPanel } from './MinesweeperPanel'
import { BattleshipPanel } from './BattleshipPanel'
import { AuctionPanel } from './AuctionPanel'
import { WordlePanel } from './WordlePanel'
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
import type { GameVariation } from '../data/games'

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
  const [activeGame, setActiveGame] = useState<GameVariation['id'] | null>(null)
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
        {activeVariant === 'h' && (
          <section className="mt-10 rounded-2xl border border-emerald-200 bg-emerald-50/50 p-6 text-sm text-emerald-900">
            <div className="flex items-center justify-between">
              <h3 className="text-lg font-semibold text-emerald-950">
                Variant h — L2 private deposit → L1 Uniswap → L2 private receiver
              </h3>
              <button
                onClick={() => setActiveVariant(null)}
                className="text-sm text-emerald-900/60 underline-offset-4 hover:underline"
              >
                Close
              </button>
            </div>
            {network === 'sandbox' ? (
              <>
                <p className="mt-2">
                  This variant runs end-to-end on the local sandbox using Aztec's bundled{' '}
                  <code className="font-mono text-xs">UniswapContract</code> +{' '}
                  <code className="font-mono text-xs">UniswapPortal</code>. Scroll to the{' '}
                  <strong>Cross-chain L1 bridge</strong> card below, open it, and look for the
                  green <strong>Private flow</strong> sub-panel.
                </p>

                <div className="mt-4 grid grid-cols-1 gap-3 md:grid-cols-3">
                  <div className="rounded-xl border border-emerald-300 bg-white p-3">
                    <p className="text-xs font-semibold uppercase tracking-wide text-emerald-900">
                      1 · L2 private
                    </p>
                    <p className="mt-1 font-mono text-xs">swap_private</p>
                    <p className="mt-2 text-xs text-emerald-900/80">
                      Depositor's private notes burned via{' '}
                      <code className="text-[10px]">transfer_to_public</code>. L2 caller hidden in
                      private kernel — only the L2 Uniswap public balance moves.
                    </p>
                    <p className="mt-2 text-[10px] uppercase tracking-wide text-emerald-700">
                      hides: depositor address
                    </p>
                  </div>
                  <div className="rounded-xl border border-sky-300 bg-white p-3">
                    <p className="text-xs font-semibold uppercase tracking-wide text-sky-900">
                      2 · L1 public swap
                    </p>
                    <p className="mt-1 font-mono text-xs">UniswapPortal.swapPrivate</p>
                    <p className="mt-2 text-xs text-sky-900/80">
                      Portal consumes two L2→L1 messages (withdraw + swap), routes through real
                      Uniswap V3 router, queues an L1→L2 mint keyed by{' '}
                      <code className="text-[10px]">claim_secret_hash</code>.
                    </p>
                    <p className="mt-2 text-[10px] uppercase tracking-wide text-sky-700">
                      public: amount, fee, tokens
                    </p>
                  </div>
                  <div className="rounded-xl border border-emerald-300 bg-white p-3">
                    <p className="text-xs font-semibold uppercase tracking-wide text-emerald-900">
                      3 · L2 private
                    </p>
                    <p className="mt-1 font-mono text-xs">claim_private</p>
                    <p className="mt-2 text-xs text-emerald-900/80">
                      Any L2 address with the secret redeems the output as private notes. Demo
                      claims to a different account from the depositor.
                    </p>
                    <p className="mt-2 text-[10px] uppercase tracking-wide text-emerald-700">
                      hides: recipient ⇎ depositor link
                    </p>
                  </div>
                </div>
                <p className="mt-3 text-center text-xs text-emerald-800">
                  Alice (private) → <span className="font-mono">[L2 Uniswap]</span> →{' '}
                  <span className="font-mono">L2→L1 msgs</span> →{' '}
                  <span className="font-mono">[V3 router]</span> →{' '}
                  <span className="font-mono">L1→L2 msg</span> → Bob (private, ≠ Alice)
                </p>

                <ul className="mt-4 list-disc space-y-1 pl-5 text-emerald-900/90">
                  <li>
                    <strong>swap_private</strong> on L2: depositor's L2 identity never enters
                    public state — only the Uniswap contract's public balance moves.
                  </li>
                  <li>
                    <strong>swapPrivate</strong> on L1: portal consumes the two L2→L1 messages and
                    queues an L1→L2 mint keyed by the claim secret (no recipient bound to the
                    deposit).
                  </li>
                  <li>
                    <strong>claim_private</strong> on L2: any L2 address holding the secret can
                    redeem the AZB as private notes — observers cannot link claim recipient back
                    to depositor.
                  </li>
                </ul>
                <div className="mt-3 space-y-2 text-emerald-900/80">
                  <p>
                    <strong>Mock L1 (default):</strong>{' '}
                    <code className="font-mono text-xs">
                      sandbox:setup &amp;&amp; sandbox:seed &amp;&amp; sandbox:l1-portal &amp;&amp;
                      sandbox:mock-router &amp;&amp; sandbox:uniswap
                    </code>{' '}
                    →{' '}
                    <code className="font-mono text-xs">npm run sandbox:swap-l1-private</code>. 1:1
                    swap math via a stubbed router planted at the V3 SwapRouter address.
                  </p>
                  <p>
                    <strong>Real Uniswap V3 via mainnet-forked Anvil:</strong> in one terminal run{' '}
                    <code className="font-mono text-xs">./scripts/start-fork-anvil.sh</code> (port
                    8546). In another start the Aztec sandbox pointing at it:{' '}
                    <code className="font-mono text-xs">
                      ETHEREUM_HOSTS=http://localhost:8546 aztec start --local-network --port 8090
                    </code>
                    . Then{' '}
                    <code className="font-mono text-xs">
                      sandbox:setup &amp;&amp; sandbox:seed &amp;&amp; sandbox:fork-uniswap
                    </code>{' '}
                    →{' '}
                    <code className="font-mono text-xs">
                      npm run sandbox:swap-l1-private-forked
                    </code>{' '}
                    (or the UI button). WETH → USDC at real pool prices.
                  </p>
                </div>
                <button
                  onClick={() => {
                    setBridgeOpen(true)
                    setActiveVariant(null)
                    requestAnimationFrame(() => {
                      document
                        .querySelector('[data-cross-chain-card]')
                        ?.scrollIntoView({ behavior: 'smooth' })
                    })
                  }}
                  className="mt-4 rounded-full bg-emerald-600 px-4 py-2 text-sm font-medium text-white hover:opacity-90"
                >
                  Open bridge panel ↓
                </button>
              </>
            ) : sandboxState?.crossChain?.l1UniswapPortal && sandboxState.crossChain.portalsInitialized ? (
              <>
                <p className="mt-2">
                  Testnet L1 portals are deployed on Sepolia and wired to the Aztec testnet L2
                  contracts. Interactive trigger from the dashboard is not yet wired — for now the
                  flow is driven via the CLI.
                </p>
                <div className="mt-3 grid grid-cols-1 gap-2 text-xs">
                  <p>
                    L1 UniswapPortalSepolia:{' '}
                    <code className="font-mono">{sandboxState.crossChain.l1UniswapPortal}</code>
                  </p>
                  <p>
                    L1 router (V3 SwapRouter02 on Sepolia):{' '}
                    <code className="font-mono">{sandboxState.crossChain.l1Router}</code>
                  </p>
                  <p>
                    L2 Uniswap:{' '}
                    <code className="font-mono">{sandboxState.crossChain.l2Uniswap}</code>
                  </p>
                </div>
              </>
            ) : (
              <>
                <p className="mt-2">
                  Testnet ship is staged but not yet executed. Bundled UniswapPortal hardcodes the
                  mainnet V3 router; we ship a Sepolia-friendly fork at{' '}
                  <code className="font-mono text-xs">
                    contracts-l1/UniswapPortalSepolia/src/UniswapPortalSepolia.sol
                  </code>
                  . To fire the deploy you need a Sepolia key with ~0.1 ETH:
                </p>
                <pre className="mt-3 overflow-x-auto rounded-lg border border-emerald-300/40 bg-white p-3 font-mono text-[11px]">
{`# 1. L1 contracts (Sepolia)
SEPOLIA_RPC=https://... SEPOLIA_PRIVATE_KEY=0x... \\
  npm run testnet:deploy-l1-portals

# 2. L2 contracts (Aztec testnet) + init L1 portals
TESTNET_SECRET=0x... TESTNET_SALT=0x... TESTNET_SIGNING=0x... \\
SEPOLIA_RPC=https://... SEPOLIA_PRIVATE_KEY=0x... \\
  npm run testnet:wire-uniswap`}
                </pre>
                <p className="mt-2 text-xs text-emerald-900/70">
                  Once wired, an interactive testnet flow needs (a) Sepolia ETH for the L1 portal
                  call and (b) a per-tab Schnorr account deployed via SponsoredFPC. Tracked in the
                  testnet-interactive blocker note. The CLI run script is{' '}
                  <strong>not yet written</strong> in this batch — it would mirror{' '}
                  <code className="font-mono">run-uniswap-swap-private.ts</code> but read the
                  Sepolia portal addresses from <code>testnet-state.json</code>.
                </p>
              </>
            )}
          </section>
        )}
        {activeVariant === 'i' && (
          <section className="mt-10 rounded-2xl border border-sky-200 bg-sky-50/40 p-6 text-sm text-sky-900">
            <div className="flex items-center justify-between">
              <h3 className="text-lg font-semibold text-sky-950">
                Variant i — Aztec L2 private deposit → L1 portal → Base L2
              </h3>
              <button
                onClick={() => setActiveVariant(null)}
                className="text-sm text-sky-900/60 underline-offset-4 hover:underline"
              >
                Close
              </button>
            </div>
            {network === 'sandbox' ? (
              <>
                <p className="mt-2">
                  Same primitive as variant h, retargeted at Base's L1StandardBridge. The L2 caller
                  burns a private AZA note via{' '}
                  <code className="font-mono text-xs">transfer_to_public</code>; the L1
                  BaseBridgePortal consumes both L2→L1 messages and forwards to a Mock Base bridge
                  that emits a public deposit event keyed by the Base recipient.
                </p>
                <div className="mt-4 grid grid-cols-1 gap-3 md:grid-cols-3">
                  <div className="rounded-xl border border-emerald-300 bg-white p-3">
                    <p className="text-xs font-semibold uppercase tracking-wide text-emerald-900">
                      1 · L2 private
                    </p>
                    <p className="mt-1 font-mono text-xs">bridge_private</p>
                    <p className="mt-2 text-xs text-emerald-900/80">
                      Caller's private AZA notes burn into the contract's public balance. L2
                      identity stays inside the private kernel.
                    </p>
                    <p className="mt-2 text-[10px] uppercase tracking-wide text-emerald-700">
                      hides: depositor address
                    </p>
                  </div>
                  <div className="rounded-xl border border-sky-300 bg-white p-3">
                    <p className="text-xs font-semibold uppercase tracking-wide text-sky-900">
                      2 · L1 portal hop
                    </p>
                    <p className="mt-1 font-mono text-xs">BaseBridgePortal.bridgeToBase</p>
                    <p className="mt-2 text-xs text-sky-900/80">
                      Consumes withdrawal + bridge-intent L2→L1 messages, pulls the released ERC20,
                      forwards to Base L1StandardBridge.
                    </p>
                    <p className="mt-2 text-[10px] uppercase tracking-wide text-sky-700">
                      public: amount, recipient, tokens
                    </p>
                  </div>
                  <div className="rounded-xl border border-amber-300 bg-white p-3">
                    <p className="text-xs font-semibold uppercase tracking-wide text-amber-900">
                      3 · Base L2
                    </p>
                    <p className="mt-1 font-mono text-xs">bridgeERC20To(to, amount)</p>
                    <p className="mt-2 text-xs text-amber-900/80">
                      On real Base mainnet this is the canonical L1 → Base L2 deposit (~3 min).
                      Sandbox uses a stub that emits the same event.
                    </p>
                    <p className="mt-2 text-[10px] uppercase tracking-wide text-amber-700">
                      public: recipient on Base
                    </p>
                  </div>
                </div>
                <p className="mt-3 text-center text-xs text-sky-800">
                  Alice (private) → <span className="font-mono">[L2 BaseBridge]</span> →{' '}
                  <span className="font-mono">L2→L1 msgs</span> →{' '}
                  <span className="font-mono">[BaseBridgePortal]</span> →{' '}
                  <span className="font-mono">[L1StandardBridge]</span> → 0xbabe (public, ≠ Alice)
                </p>
                <p className="mt-4">
                  <strong>Run it:</strong>{' '}
                  <code className="font-mono text-xs">
                    sandbox:setup &amp;&amp; sandbox:seed &amp;&amp; sandbox:l1-portal &amp;&amp;
                    sandbox:base-bridge
                  </code>{' '}
                  →{' '}
                  <code className="font-mono text-xs">npm run sandbox:base-bridge-private</code>.
                </p>
                <p className="mt-2 text-xs text-sky-900/70">
                  <strong>One-way only:</strong> no L1→L2 claim message — the tokens leave Aztec
                  entirely. Anonymity set is other Aztec depositors funneling through the same
                  portal in a similar window; single-user usage leaks via timing correlation.
                </p>
              </>
            ) : (
              <p className="mt-2">
                Currently runs only on the sandbox L1 anvil chain. Testnet support waits on
                deploying BaseBridgePortal to Sepolia + the real Base L1StandardBridge on Sepolia
                (address <code className="font-mono text-xs">0xfd0Bf71F60660E2f608ed56e1659C450eB113120</code> at last check). Switch the network toggle to <strong>Sandbox</strong> to try it.
              </p>
            )}
          </section>
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
        {activeVariant &&
          activeVariant !== 'h' &&
          activeVariant !== 'i' &&
          !sandboxState && (
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

        <div className="mt-16">
          <GamesMatrix onTry={(id) => setActiveGame(id)} />
        </div>

        {activeGame === 'g1' && sandboxState && network === 'sandbox' && (
          <MinesweeperPanel state={sandboxState} onClose={() => setActiveGame(null)} />
        )}
        {activeGame === 'g2' && sandboxState && network === 'sandbox' && (
          <BattleshipPanel state={sandboxState} onClose={() => setActiveGame(null)} />
        )}
        {activeGame === 'g5' && sandboxState && network === 'sandbox' && (
          <AuctionPanel state={sandboxState} onClose={() => setActiveGame(null)} />
        )}
        {activeGame === 'g6' && sandboxState && network === 'sandbox' && (
          <WordlePanel state={sandboxState} onClose={() => setActiveGame(null)} />
        )}
        {activeGame === 'g3' && sandboxState && network === 'sandbox' && (
          <section className="mt-10 rounded-2xl border border-amber-200 bg-amber-50/40 p-6 text-sm text-amber-900">
            <div className="flex items-center justify-between">
              <h3 className="text-lg font-semibold text-amber-950">
                Variant g3 — PvP Battleship: research-grade
              </h3>
              <button
                onClick={() => setActiveGame(null)}
                className="text-sm text-amber-900/60 underline-offset-4 hover:underline"
              >
                Close
              </button>
            </div>
            <p className="mt-2">
              Two-player Battleship with hidden boards is genuinely hard on Aztec: each player
              needs to prove a hit/miss without revealing their fleet, which requires either ZK
              proofs of board membership per turn or a trusted external operator. The matrix card
              above explains the trade-offs — playable panel intentionally omitted.
            </p>
          </section>
        )}
        {activeGame && network === 'testnet' && (
          <section className="mt-10 rounded-2xl border border-amber-200 bg-amber-50 p-6 text-sm text-amber-900">
            Variant {activeGame} needs the sandbox + the Minesweeper/Battleship Noir contract. Switch
            the network toggle to <strong>Sandbox</strong> when it ships.
            <button onClick={() => setActiveGame(null)} className="ml-3 underline">
              Close
            </button>
          </section>
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
          <div className="mt-16" data-cross-chain-card>
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
