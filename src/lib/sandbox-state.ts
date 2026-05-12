export interface SandboxState {
  sandboxUrl: string
  deployer: string
  token0: { address: string; name: string; symbol: string; instance: unknown }
  token1: { address: string; name: string; symbol: string; instance: unknown }
  lpToken: { address: string; name: string; symbol: string; instance: unknown }
  amm: { address: string; instance: unknown }
  privateSwapWrapper?: { address: string; instance: unknown }
  priceFeed?: { address: string; instance: unknown; price: string }
  lending?: {
    address: string
    instance: unknown
    collateralAsset: string
    stableCoin: string
    loanToValueBps: string
  }
  publicCollateralPrivateDebt?: {
    address: string
    instance: unknown
    collateralAsset: string
    debtAsset: string
    ltvNumerator: string
    ltvDenominator: string
  }
  crowdfunding?: {
    address: string
    instance: unknown
    donationToken: string
    operator: string
    deadline: string
  }
  publicCrowdfunding?: {
    address: string
    instance: unknown
    donationToken: string
    operator: string
  }
  perDonorReceipts?: {
    address: string
    instance: unknown
    donationToken: string
    operator: string
  }
  voting?: {
    address: string
    instance: unknown
    admin: string
    electionId: string
  }
  crossChain?: {
    bridge0: string
    bridge1?: string
    l2Uniswap?: string
    placeholderPortal?: string
    /** Real L1 wiring populated by `npm run sandbox:l1-portal`. */
    l1Rpc?: string
    l1Token?: string
    l1Portal?: string
    l1Deployer?: string
    bridge0Instance?: unknown
    mockSwapRouter?: string
    mockSwapRouterRuntimeAt?: string
    /** Real Uniswap-from-L2 stack populated by `npm run sandbox:uniswap`. */
    l1TokenB?: string
    l1OutputPortal?: string
    l1UniswapPortal?: string
    l2BridgeB?: string
    l2BridgeBInstance?: unknown
    l2UniswapInstance?: unknown
  }
  initialPrivateBalances: { AZA: string; AZB: string }
  reserves?: { AZA: string; AZB: string }
  adminBalances?: { AZA: string; AZB: string }
  lastSwap?: {
    in: { symbol: string; amount: string }
    out: { symbol: string; amount: string }
    at: string
  }
  deployedAt: string
}

const cachedByNetwork = new Map<string, { state: SandboxState | null; ts: number }>()
const TTL_MS = 5_000

export async function loadDeployState(
  network: 'sandbox' | 'testnet' = 'sandbox',
): Promise<SandboxState | null> {
  const file = network === 'testnet' ? '/testnet-state.json' : '/sandbox-state.json'
  const hit = cachedByNetwork.get(network)
  if (hit && Date.now() - hit.ts < TTL_MS) return hit.state
  try {
    const res = await fetch(file, { cache: 'no-cache' })
    if (!res.ok) {
      cachedByNetwork.set(network, { state: null, ts: Date.now() })
      return null
    }
    const state = (await res.json()) as SandboxState
    cachedByNetwork.set(network, { state, ts: Date.now() })
    return state
  } catch {
    cachedByNetwork.set(network, { state: null, ts: Date.now() })
    return null
  }
}

export const loadSandboxState = () => loadDeployState('sandbox')

export function truncate(addr: string, len = 4): string {
  if (addr.length <= 10 + len) return addr
  return `${addr.slice(0, 6)}…${addr.slice(-len)}`
}
