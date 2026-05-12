import { loadSandboxState, type SandboxState } from '../lib/sandbox-state'
import { useEffect, useState } from 'react'
import { Copyable } from './ui/Copyable'
import { MatrixHeader } from './ui/MatrixHeader'

export function CrossChainCard() {
  const [state, setState] = useState<SandboxState | null>(null)

  useEffect(() => {
    loadSandboxState().then(setState)
  }, [])

  const cc = state?.crossChain
  const portalWired = !!cc?.l1Portal && !!cc?.l1Token
  const uniswapWired =
    !!cc?.l1UniswapPortal && !!cc?.l1OutputPortal && !!cc?.l2BridgeB && !!cc?.mockSwapRouter

  return (
    <section>
      <MatrixHeader
        title="Cross-chain — L1↔L2 token bridge + Uniswap-from-L2"
        subtitle={
          portalWired
            ? `Real TestERC20 + TokenPortal on the anvil L1 chain, paired bidirectionally with L2 TokenBridges. Bidirectional bridge round-trip closes from the browser; the Uniswap swap layer runs via a mock V3 router planted at the hardcoded mainnet address.`
            : `Run npm run sandbox:l1-portal to deploy real L1 portals. Until then the L2 contracts hold placeholder portal addresses and the round-trip can't complete.`
        }
        legend={false}
      />

      <div className="rounded-2xl border border-black/10 bg-white p-5">
        <div className="mb-3 flex items-center justify-between">
          <div>
            <span className="font-mono text-xs text-black/40">
              phase 2 ({portalWired ? 'L1+L2 wired' : 'L2 only'})
            </span>
            <h3 className="text-base font-semibold leading-snug">
              {portalWired
                ? 'Paired portals deployed — bridge round-trip ready to wire'
                : 'L2 contracts deployed · L1 portal setup is the gap'}
            </h3>
          </div>
          {uniswapWired ? (
            <span className="shrink-0 rounded-full border border-emerald-200 bg-emerald-50 px-2 py-0.5 text-[11px] font-medium text-emerald-700">
              Uniswap stack wired
            </span>
          ) : portalWired ? (
            <span className="shrink-0 rounded-full border border-emerald-200 bg-emerald-50 px-2 py-0.5 text-[11px] font-medium text-emerald-700">
              L1 portal live
            </span>
          ) : (
            <span className="shrink-0 rounded-full border border-amber-200 bg-amber-50 px-2 py-0.5 text-[11px] font-medium text-amber-700">
              Partial — L1 portals TBD
            </span>
          )}
        </div>

        <div className="grid grid-cols-1 gap-4 md:grid-cols-2">
          <div>
            <p className="text-xs uppercase tracking-wide text-black/40">What ships today</p>
            <ul className="mt-2 list-disc space-y-1 pl-5 text-sm text-black/80">
              {portalWired ? (
                <>
                  <li>
                    Real <code className="font-mono text-xs">TestERC20</code> on L1 anvil (mirror
                    of AZA) with the deployer pre-funded.
                  </li>
                  <li>
                    Real <code className="font-mono text-xs">TokenPortal.sol</code> on L1,
                    initialised against the Aztec registry and pointed at a freshly redeployed
                    L2 <code className="font-mono text-xs">TokenBridge</code>.
                  </li>
                  <li>
                    L2 bridge holds the real L1 portal address in its storage and has minter
                    rights on AZA, so a consumed L1→L2 message can mint AZA notes for the
                    recipient.
                  </li>
                </>
              ) : (
                <>
                  <li>
                    <code className="font-mono text-xs">UniswapContract</code> + two{' '}
                    <code className="font-mono text-xs">TokenBridge</code>s on L2 with placeholder
                    portal addresses.
                  </li>
                  <li>
                    L2 entry points reachable, but the portal addresses point at{' '}
                    <code className="font-mono text-xs">0xdead</code>.
                  </li>
                </>
              )}
            </ul>
          </div>
          <div>
            <p className="text-xs uppercase tracking-wide text-black/40">
              What's missing for the Uniswap round-trip
            </p>
            <ul className="mt-2 list-disc space-y-1 pl-5 text-sm text-black/80">
              <li>
                <strong>(resolved)</strong> The router at the hardcoded mainnet address{' '}
                <code className="font-mono text-xs">0xE592...1564</code>:{' '}
                <code className="font-mono">npm run sandbox:mock-router</code> uses anvil's{' '}
                <code className="font-mono text-xs">anvil_setCode</code> to plant a{' '}
                <code className="font-mono text-xs">MockSwapRouter.sol</code> runtime there
                (Forge-compiled in <code className="font-mono text-xs">contracts-l1/</code>).
              </li>
              <li>
                <strong>(resolved)</strong> The output-side stack:{' '}
                <code className="font-mono">npm run sandbox:uniswap</code> deploys a second{' '}
                <code className="font-mono text-xs">TestERC20</code> + paired{' '}
                <code className="font-mono text-xs">TokenPortal</code> + L1{' '}
                <code className="font-mono text-xs">UniswapPortal.sol</code> (initialised against
                a freshly redeployed L2 <code className="font-mono text-xs">UniswapContract</code>
                pointing at the real portal), plus an L2 bridge for the output token and 1 M
                TestERC20-B pre-funded into the mock router.
              </li>
              <li>
                A browser-driven <code className="font-mono text-xs">swap_public</code> call from
                L2 that emits the L2→L1 withdrawal+swap message and a matching L1→L2 mint claim
                on the way back. The stack is in place — wiring the UI button is the remaining
                step.
              </li>
            </ul>
          </div>
        </div>

        {cc && (
          <details className="mt-4" open={portalWired}>
            <summary className="cursor-pointer text-sm text-black/60 hover:underline">
              deployed addresses
            </summary>
            <dl className="mt-2 grid grid-cols-1 gap-x-6 gap-y-1 text-xs md:grid-cols-2">
              {portalWired && (
                <>
                  <dt className="text-black/40">L1 RPC</dt>
                  <dd className="font-mono">{cc.l1Rpc}</dd>
                  <dt className="text-black/40">L1 TestERC20 (AZA mirror)</dt>
                  <dd><Copyable value={cc.l1Token!} truncate={6} /></dd>
                  <dt className="text-black/40">L1 TokenPortal</dt>
                  <dd><Copyable value={cc.l1Portal!} truncate={6} /></dd>
                  <dt className="text-black/40">L1 deployer</dt>
                  <dd><Copyable value={cc.l1Deployer!} truncate={6} /></dd>
                </>
              )}
              {cc.mockSwapRouter && (
                <>
                  <dt className="text-black/40">Mock V3 SwapRouter (planted)</dt>
                  <dd><Copyable value={cc.mockSwapRouter} truncate={6} /></dd>
                </>
              )}
              {cc.l1TokenB && (
                <>
                  <dt className="text-black/40">L1 TestERC20-B (output)</dt>
                  <dd><Copyable value={cc.l1TokenB} truncate={6} /></dd>
                </>
              )}
              {cc.l1OutputPortal && (
                <>
                  <dt className="text-black/40">L1 OutputTokenPortal</dt>
                  <dd><Copyable value={cc.l1OutputPortal} truncate={6} /></dd>
                </>
              )}
              {cc.l1UniswapPortal && (
                <>
                  <dt className="text-black/40">L1 UniswapPortal</dt>
                  <dd><Copyable value={cc.l1UniswapPortal} truncate={6} /></dd>
                </>
              )}
              <dt className="text-black/40">L2 Bridge(AZA)</dt>
              <dd><Copyable value={cc.bridge0} truncate={6} /></dd>
              {cc.l2BridgeB && (
                <>
                  <dt className="text-black/40">L2 Bridge(AZB)</dt>
                  <dd><Copyable value={cc.l2BridgeB} truncate={6} /></dd>
                </>
              )}
              {cc.bridge1 && !cc.l2BridgeB && (
                <>
                  <dt className="text-black/40">L2 Bridge(AZB)</dt>
                  <dd><Copyable value={cc.bridge1} truncate={6} /></dd>
                </>
              )}
              {cc.l2Uniswap && (
                <>
                  <dt className="text-black/40">L2 Uniswap{cc.l1UniswapPortal ? '' : ' (placeholder portal)'}</dt>
                  <dd><Copyable value={cc.l2Uniswap} truncate={6} /></dd>
                </>
              )}
            </dl>
          </details>
        )}

        <p className="mt-4 text-xs text-black/50">
          Privacy story: L2 caller stays private behind the bridge address. Observers on L1 see
          only the portal's deposit/withdraw event, not the originating L2 user. The unshielded
          amount and token are revealed at L1; nothing else.
        </p>
      </div>
    </section>
  )
}
