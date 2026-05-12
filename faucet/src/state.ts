/**
 * Loads the dashboard's public testnet-state.json so the faucet knows the
 * canonical AZA + AZB contract instances to register in its PXE. The file is
 * copied in at Docker build time (see Dockerfile).
 */
import { readFileSync } from 'node:fs'
import { resolve, dirname } from 'node:path'
import { fileURLToPath } from 'node:url'

const here = dirname(fileURLToPath(import.meta.url))

export interface TestnetState {
  sandboxUrl: string
  deployer: string
  sponsoredFpc?: string
  token0: { address: string; symbol: string; instance: unknown }
  token1: { address: string; symbol: string; instance: unknown }
  network?: string
}

export function loadTestnetState(): TestnetState {
  const candidates = [
    resolve(here, '..', 'testnet-state.json'),
    resolve(here, '..', '..', 'public', 'testnet-state.json'),
  ]
  for (const p of candidates) {
    try {
      return JSON.parse(readFileSync(p, 'utf8')) as TestnetState
    } catch {
      // try next
    }
  }
  throw new Error(
    `Could not find testnet-state.json. Looked in:\n  ${candidates.join('\n  ')}`,
  )
}
