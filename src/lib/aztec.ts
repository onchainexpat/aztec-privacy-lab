import { createAztecNodeClient, waitForNode, type AztecNode } from '@aztec/aztec.js/node'
import type { NetworkConfig } from './network'

let cached: { url: string; node: AztecNode } | null = null

export async function getNode(network: NetworkConfig): Promise<AztecNode> {
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
