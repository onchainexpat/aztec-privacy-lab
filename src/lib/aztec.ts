import { createAztecNodeClient, waitForNode, type AztecNode } from '@aztec/aztec.js/node'
import type { NetworkConfig } from './network'

let cached: { url: string; node: AztecNode } | null = null

/** True if the URL points at a private-network address (localhost, RFC1918). */
export function isPrivateNetworkUrl(url: string): boolean {
  try {
    const u = new URL(url)
    const h = u.hostname
    if (h === 'localhost' || h === '127.0.0.1' || h === '::1') return true
    if (/^10\./.test(h)) return true
    if (/^192\.168\./.test(h)) return true
    if (/^172\.(1[6-9]|2\d|3[01])\./.test(h)) return true
    return false
  } catch {
    return false
  }
}

/** True if we're served from a public origin (i.e. not localhost in the browser). */
export function isOnPublicOrigin(): boolean {
  if (typeof window === 'undefined') return false
  const h = window.location.hostname
  return h !== 'localhost' && h !== '127.0.0.1' && h !== '::1'
}

/**
 * True if a request from the current origin to `url` would trigger Chrome /
 * Brave's Private Network Access prompt — i.e. we're public but the target
 * is private. Callers should short-circuit and surface a setup hint instead
 * of letting the prompt fire (and the eventual request fail anyway).
 */
export function isCrossPrivateBoundary(url: string): boolean {
  return isOnPublicOrigin() && isPrivateNetworkUrl(url)
}

export class PrivateNetworkUnreachableError extends Error {
  constructor(url: string) {
    super(
      `Cannot reach ${url} from this origin — it points at a local-network ` +
        `address and we're served from a public origin. Run the sandbox locally ` +
        `(clone the repo and follow README) or point the dashboard at a public ` +
        `node URL.`,
    )
    this.name = 'PrivateNetworkUnreachableError'
  }
}

export async function getNode(network: NetworkConfig): Promise<AztecNode> {
  if (isCrossPrivateBoundary(network.nodeUrl)) {
    throw new PrivateNetworkUnreachableError(network.nodeUrl)
  }
  if (cached && cached.url === network.nodeUrl) return cached.node
  const node = createAztecNodeClient(network.nodeUrl)
  await waitForNode(node)
  cached = { url: network.nodeUrl, node }
  return node
}

export async function getNodeInfo(network: NetworkConfig) {
  const node = await getNode(network)
  return node.getNodeInfo()
}

export async function getBlockNumber(network: NetworkConfig): Promise<number> {
  const node = await getNode(network)
  return node.getBlockNumber()
}
