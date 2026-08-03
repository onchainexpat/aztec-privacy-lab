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
import { LaunchpadExtrasPanelTestnet } from './LaunchpadExtrasPanelTestnet'
import { LendingMatrix } from './LendingMatrix'
import { GamesMatrix } from './GamesMatrix'
import { MinesweeperPanel } from './MinesweeperPanel'
import { BattleshipPanel } from './BattleshipPanel'
import { BattleshipPvPPanel } from './BattleshipPvPPanel'
import { BattleshipPvPPanelTestnet } from './BattleshipPvPPanelTestnet'
import { AuctionPanel } from './AuctionPanel'
import { AuctionPanelTestnet } from './AuctionPanelTestnet'
import { WordlePanel } from './WordlePanel'
import { WordlePanelTestnet } from './WordlePanelTestnet'
import { LotteryPanel } from './LotteryPanel'
import { LotteryPanelTestnet } from './LotteryPanelTestnet'
import { AttestationPanel } from './AttestationPanel'
import { AttestationPanelTestnet } from './AttestationPanelTestnet'
import { BatchPayPanel } from './BatchPayPanel'
import { BatchPayPanelTestnet } from './BatchPayPanelTestnet'
import { EscrowPanel } from './EscrowPanel'
import { EscrowPanelTestnet } from './EscrowPanelTestnet'
import { PayrollPanel } from './PayrollPanel'
import { PayrollPanelTestnet } from './PayrollPanelTestnet'
import { RewardsMatrix } from './RewardsMatrix'
import { RewardsPanel } from './RewardsPanel'
import { RewardsPanelTestnet } from './RewardsPanelTestnet'
import { BlackjackPanel } from './BlackjackPanel'
import { LendingPanel } from './LendingPanel'
import { LendingPanelTestnet } from './LendingPanelTestnet'
import { LendingExtrasPanelTestnet } from './LendingExtrasPanelTestnet'
import { CrossChainCard } from './CrossChainCard'
import { AnonymousVotingPanel } from './AnonymousVotingPanel'
import { AnonymousVotingPanelTestnet } from './AnonymousVotingPanelTestnet'
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
  const [attestationOpen, setAttestationOpen] = useState(false)
  const [batchPayOpen, setBatchPayOpen] = useState(false)
  const [escrowOpen, setEscrowOpen] = useState(false)
  const [payrollOpen, setPayrollOpen] = useState(false)
  const [rewardsOpen, setRewardsOpen] = useState(false)
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
                  Live and verified end to end on Aztec testnet → Sepolia → back: L1 portals are
                  deployed on Sepolia and wired to the L2 contracts, and the full private swap
                  (L2 <code className="font-mono">swap_private</code> → L2→L1 messages → Sepolia{' '}
                  <code className="font-mono">swapPrivate</code> → L1→L2 mint → private claim) runs
                  via the CLI. It&apos;s CLI-driven on purpose: the L1 leg has to be signed by a
                  funded Sepolia key, which shouldn&apos;t live in a browser tab — so unlike the
                  sandbox bridge there&apos;s no in-page trigger here.
                </p>
                <pre className="mt-3 overflow-x-auto rounded-lg border border-emerald-300/40 bg-white p-3 font-mono text-[11px]">
{`TESTNET_SECRET=0x... TESTNET_SALT=0x... TESTNET_SIGNING=0x... \\
SEPOLIA_RPC=https://... SEPOLIA_PRIVATE_KEY=0x... \\
  npm run testnet:swap-l1-private`}
                </pre>
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
                  Once wired, the end-to-end CLI run script{' '}
                  <code className="font-mono">scripts/run-testnet-swap-private.ts</code> (
                  <code className="font-mono">npm run testnet:swap-l1-private</code>) drives the
                  whole private swap — it mirrors the sandbox{' '}
                  <code className="font-mono">run-uniswap-swap-private.ts</code> but reads the
                  Sepolia portal addresses from <code>testnet-state.json</code>. An{' '}
                  <em>in-page</em> trigger stays out of scope: the L1 leg needs a funded Sepolia
                  signer, which doesn&apos;t belong in a browser tab.
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
            <LaunchpadExtrasPanelTestnet
              variant={activeLaunchpad}
              state={sandboxState}
              onClose={() => setActiveLaunchpad(null)}
            />
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
        {(activeLending === 'ld1' || activeLending === 'ld3') &&
          sandboxState &&
          network === 'testnet' && (
            <LendingExtrasPanelTestnet
              variant={activeLending}
              state={sandboxState}
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
        {activeGame === 'g7' && sandboxState && network === 'sandbox' && (
          <LotteryPanel state={sandboxState} onClose={() => setActiveGame(null)} />
        )}
        {activeGame === 'g3' && sandboxState && network === 'sandbox' && (
          <BattleshipPvPPanel state={sandboxState} onClose={() => setActiveGame(null)} />
        )}
        {activeGame === 'g4' && sandboxState && network === 'sandbox' && (
          <BlackjackPanel state={sandboxState} onClose={() => setActiveGame(null)} />
        )}
        {activeGame === 'g4' && network === 'testnet' && (
          <section className="mt-10 rounded-2xl border border-amber-200 bg-amber-50 p-6 text-sm text-amber-900">
            Blackjack&apos;s contract is live on testnet, but the interactive game needs the dealer
            operator online to deal cards each hand — so play it on <strong>Sandbox</strong> (one
            session plays both roles). A real deployment would run the dealer as a service.
            <button onClick={() => setActiveGame(null)} className="ml-3 underline">
              Close
            </button>
          </section>
        )}
        {activeGame === 'g5' && sandboxState && network === 'testnet' && (
          <AuctionPanelTestnet state={sandboxState} onClose={() => setActiveGame(null)} />
        )}
        {activeGame === 'g6' && sandboxState && network === 'testnet' && (
          <WordlePanelTestnet state={sandboxState} onClose={() => setActiveGame(null)} />
        )}
        {activeGame === 'g7' && sandboxState && network === 'testnet' && (
          <LotteryPanelTestnet state={sandboxState} onClose={() => setActiveGame(null)} />
        )}
        {activeGame === 'g3' && sandboxState && network === 'testnet' && (
          <BattleshipPvPPanelTestnet state={sandboxState} onClose={() => setActiveGame(null)} />
        )}
        {activeGame && ['g1', 'g2'].includes(activeGame) && network === 'testnet' && (
          <section className="mt-10 rounded-2xl border border-amber-200 bg-amber-50 p-6 text-sm text-amber-900">
            Variant {activeGame} (Minesweeper/Battleship-solo) is sandbox-only — it needs the
            contract-side RNG that only the local sandbox provides. Switch the network toggle to{' '}
            <strong>Sandbox</strong> to try it.
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
          <AnonymousVotingPanelTestnet state={sandboxState} onClose={() => setVotingOpen(false)} />
        )}
        {votingOpen && sandboxState && network === 'sandbox' && (
          <AnonymousVotingPanel state={sandboxState} onClose={() => setVotingOpen(false)} />
        )}

        <div className="mt-10 rounded-2xl border border-black/10 bg-white p-6">
          <div className="flex items-start justify-between gap-4">
            <div>
              <h2 className="text-xl font-semibold">Identity attestation</h2>
              <p className="mt-1 text-sm text-black/60">
                Anonymous credential primitive — KYC-without-deanonymization. An issuer
                publishes credential commitments to a public whitelist; holders prove
                membership privately. The contract sees an opaque slot get consumed; public
                observers don't learn which holder proved. Concrete fits: accredited investor
                proofs, age gates, allowlist airdrops, sybil-resistant voting eligibility.
              </p>
            </div>
            {!attestationOpen && (
              <button
                onClick={() => setAttestationOpen(true)}
                className="shrink-0 rounded-full bg-[var(--color-ink)] px-3 py-1.5 text-sm font-medium text-[var(--color-paper)] hover:opacity-90"
              >
                Try attestation →
              </button>
            )}
          </div>
        </div>

        {attestationOpen && sandboxState && network === 'sandbox' && (
          <AttestationPanel
            state={sandboxState}
            onClose={() => setAttestationOpen(false)}
          />
        )}
        {attestationOpen && sandboxState && network === 'testnet' && (
          <AttestationPanelTestnet
            state={sandboxState}
            onClose={() => setAttestationOpen(false)}
          />
        )}

        <div className="mt-10 rounded-2xl border border-black/10 bg-white p-6">
          <div className="flex items-start justify-between gap-4">
            <div>
              <h2 className="text-xl font-semibold">Nested private composability</h2>
              <p className="mt-1 text-sm text-black/60">
                One private tx, multiple private sub-calls across contracts. A BatchPay
                orchestrator makes two nested <code className="font-mono text-xs">
                Token.transfer_in_private
                </code>{' '}
                calls in a single private function — zero public footprint. Observers can't tell
                the sender, recipients, amounts, or even how many recipients. This is Aztec's
                "call stack of nested private functions" property that a mixer or a public batch
                payment can't match.
              </p>
            </div>
            {!batchPayOpen && (
              <button
                onClick={() => setBatchPayOpen(true)}
                className="shrink-0 rounded-full bg-[var(--color-ink)] px-3 py-1.5 text-sm font-medium text-[var(--color-paper)] hover:opacity-90"
              >
                Try batch pay →
              </button>
            )}
          </div>
        </div>

        {batchPayOpen && sandboxState && network === 'sandbox' && (
          <BatchPayPanel state={sandboxState} onClose={() => setBatchPayOpen(false)} />
        )}
        {batchPayOpen && sandboxState && network === 'testnet' && (
          <BatchPayPanelTestnet state={sandboxState} onClose={() => setBatchPayOpen(false)} />
        )}

        <div className="mt-10 rounded-2xl border border-black/10 bg-white p-6">
          <div className="flex items-start justify-between gap-4">
            <div>
              <h2 className="text-xl font-semibold">P2P goods escrow (zkp2p-style)</h2>
              <p className="mt-1 text-sm text-black/60">
                "Buy me this on Amazon." Lock USDC against an item commitment; a fulfiller buys it
                IRL and an attestor (production: a zkEmail/zkTLS proof of Amazon's confirmation
                emails) releases the funds on delivery. Buyer + fulfiller identities and the
                on-chain↔off-chain order link all stay private — only an opaque order-id nullifier
                is public. Same shape as zkp2p's EscrowV2 + AttestationService, in Noir.
              </p>
              <p className="mt-1 text-xs text-black/45">
                Trustless-upgrade PoC: a Noir zkEmail circuit that verifies Amazon's DKIM-signed
                confirmation email + extracts the order id lives at{' '}
                <code className="font-mono">contracts-zkemail/amazon_order_proof</code>. It
                demonstrates the exact API that would replace the attestor; compiling it needs a
                stand-alone nargo aligned with zkemail.nr (the lib + the Aztec toolchain are on
                diverging Noir release trains today). See the circuit's README.
              </p>
            </div>
            {!escrowOpen && (
              <button
                onClick={() => setEscrowOpen(true)}
                className="shrink-0 rounded-full bg-[var(--color-ink)] px-3 py-1.5 text-sm font-medium text-[var(--color-paper)] hover:opacity-90"
              >
                Try escrow →
              </button>
            )}
          </div>
        </div>

        {escrowOpen && sandboxState && network === 'sandbox' && (
          <EscrowPanel state={sandboxState} onClose={() => setEscrowOpen(false)} />
        )}
        {escrowOpen && sandboxState && network === 'testnet' && (
          <EscrowPanelTestnet state={sandboxState} onClose={() => setEscrowOpen(false)} />
        )}

        <div className="mt-10 rounded-2xl border border-black/10 bg-white p-6">
          <div className="flex items-start justify-between gap-4">
            <div>
              <h2 className="text-xl font-semibold">Confidential payroll</h2>
              <p className="mt-1 text-sm text-black/60">
                An employer funds a pool and publishes one opaque commitment per employee per pay
                period — <code className="font-mono text-xs">pedersen(employee, amount, period)</code>.
                Each employee claims privately: the claim hides which registered employee is
                collecting (private kernel), and pays out to an address that need not be linkable to
                them. The whole salary register stays opaque on chain; only aggregate counters and
                opaque commitments are public. Concrete fits: confidential salaries, grant
                disbursements, recurring vendor payments.
              </p>
            </div>
            {!payrollOpen && (
              <button
                onClick={() => setPayrollOpen(true)}
                className="shrink-0 rounded-full bg-[var(--color-ink)] px-3 py-1.5 text-sm font-medium text-[var(--color-paper)] hover:opacity-90"
              >
                Try payroll →
              </button>
            )}
          </div>
        </div>

        {payrollOpen && sandboxState && network === 'sandbox' && (
          <PayrollPanel state={sandboxState} onClose={() => setPayrollOpen(false)} />
        )}
        {payrollOpen && sandboxState && network === 'testnet' && (
          <PayrollPanelTestnet state={sandboxState} onClose={() => setPayrollOpen(false)} />
        )}

        <RewardsMatrix onTry={() => setRewardsOpen(true)} />
        {rewardsOpen && sandboxState && network === 'sandbox' && (
          <RewardsPanel state={sandboxState} onClose={() => setRewardsOpen(false)} />
        )}
        {rewardsOpen && sandboxState && network === 'testnet' && (
          <RewardsPanelTestnet state={sandboxState} onClose={() => setRewardsOpen(false)} />
        )}

        {/* Multi-asset fee abstraction (FPC). The primitive is buildable on Aztec
            and our client path is verified on 5.1.0; the only public multi-asset
            FPC (Nethermind staging) has drifted out of sync, so the live demo is
            parked rather than faked. Honest boundary, not a hidden failure. */}
        <section className="mt-16 rounded-2xl border border-amber-200 bg-amber-50/70 p-6 text-sm text-amber-900">
          <div className="flex flex-wrap items-center gap-2">
            <h3 className="text-lg font-semibold text-amber-950">
              Multi-asset fees · pay gas in any accepted token (FPC)
            </h3>
            <span className="rounded-full border border-amber-300 bg-amber-100 px-2 py-0.5 text-xs font-medium">
              buildable · live demo parked on upstream
            </span>
          </div>
          <p className="mt-3 max-w-prose">
            A Fee-Paying Contract lets a user pay transaction gas in an accepted ERC-20 (not
            just fee-juice/ETH): the FPC fronts the fee and pulls the token from the user via an
            authwit. The mechanism itself works on Aztec today — what&apos;s missing is a healthy
            public deployment to point at.
          </p>
          <div className="mt-4 grid gap-3 sm:grid-cols-3">
            <div className="rounded-lg border border-amber-200 bg-white/60 p-3">
              <div className="text-xs font-semibold uppercase tracking-wide text-amber-700">
                Verified on our side
              </div>
              <p className="mt-1 text-xs">
                <code className="font-mono">scripts/verify-testnet-fpc.ts</code> spins up a fresh
                ephemeral account, proves it, and sends it on the live 5.1.0 testnet — the
                wallet/PXE/split-node path is healthy end to end.
              </p>
            </div>
            <div className="rounded-lg border border-amber-200 bg-white/60 p-3">
              <div className="text-xs font-semibold uppercase tracking-wide text-amber-700">
                Why it&apos;s parked
              </div>
              <p className="mt-1 text-xs">
                The only public multi-asset FPC (Nethermind staging) is out of sync with 5.1.0.
                Its vendored artifacts compute a different class id than the deployed contract, so
                attaching the Faucet rejects before any fee tx runs.
              </p>
            </div>
            <div className="rounded-lg border border-amber-200 bg-white/60 p-3">
              <div className="text-xs font-semibold uppercase tracking-wide text-amber-700">
                What unblocks it
              </div>
              <p className="mt-1 text-xs">
                5.1.0-matching artifacts + a live attestation host, or we self-host our own
                token-accepting FPC + signer so the demo no longer depends on a third-party
                staging environment.
              </p>
            </div>
          </div>
          <p className="mt-3 font-mono text-[11px] text-amber-900/70">
            Faucet artifact class 0x10e31a… (vendored) ≠ on-chain 0x18c66f… · attestation host
            /.well-known/fpc.json → 404
          </p>
        </section>

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
            <code className="font-mono">@aztec/aztec.js@5.1.0</code> + Aztec v5 testnet
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
