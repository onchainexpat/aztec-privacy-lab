export type NetworkId = 'sandbox' | 'testnet'

export interface NetworkConfig {
  id: NetworkId
  label: string
  /** Aztec node JSON-RPC URL (public read-side). */
  nodeUrl: string
  explorerUrl: string | null
  faucetUrl: string | null
  enabled: boolean
}

export const NETWORKS: Record<NetworkId, NetworkConfig> = {
  sandbox: {
    id: 'sandbox',
    label: 'Sandbox',
    nodeUrl: 'http://localhost:8090',
    explorerUrl: null,
    faucetUrl: null,
    enabled: true,
  },
  testnet: {
    id: 'testnet',
    label: 'Testnet (Alpha v4)',
    // Canonical testnet RPC — L1 settles to Sepolia (chainId 11155111).
    // NOT aztec.drpc.org, which is the mainnet Aztec rollup (L1 chainId 1).
    nodeUrl: 'https://rpc.testnet.aztec-labs.com',
    explorerUrl: 'https://testnet.aztecscan.xyz',
    faucetUrl: 'https://aztec-faucet.nethermind.io',
    enabled: true,
  },
}

const STORAGE_KEY = 'aztec-experiments:network'

export function loadNetwork(): NetworkId {
  const v = typeof localStorage !== 'undefined' ? localStorage.getItem(STORAGE_KEY) : null
  // If a public-origin visitor has `sandbox` saved from an earlier visit, the
  // dashboard would try to reach http://localhost:8090 from a public hostname
  // and fail. Force testnet in that case; visitors who really want sandbox
  // can toggle in the header. Local-dev visitors keep their explicit choice.
  const onPublicOrigin =
    typeof window !== 'undefined' &&
    window.location.hostname !== 'localhost' &&
    window.location.hostname !== '127.0.0.1'
  if (v === 'sandbox' && onPublicOrigin) return 'testnet'
  return v === 'testnet' || v === 'sandbox' ? v : 'testnet'
}

export function saveNetwork(id: NetworkId): void {
  if (typeof localStorage !== 'undefined') localStorage.setItem(STORAGE_KEY, id)
}
