/**
 * Liveness audit: confirm every contract recorded in a network's state file is
 * actually deployed on-chain (catches dead addresses, stale state, testnet
 * resets). Read-only — no account, no fees, no txs.
 *
 *   npm run audit:sandbox     # http://localhost:8090
 *   npm run audit:testnet     # rpc.testnet.aztec-labs.com
 */
import { readFileSync } from 'node:fs'
import { dirname, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { createAztecNodeClient } from '@aztec/aztec.js/node'
import { AztecAddress } from '@aztec/stdlib/aztec-address'

const __dirname = dirname(fileURLToPath(import.meta.url))

async function main() {
  const net = process.argv[2] === 'testnet' ? 'testnet' : 'sandbox'
  const stateFile = resolve(__dirname, '..', 'public', `${net}-state.json`)
  const state = JSON.parse(readFileSync(stateFile, 'utf8'))
  const url =
    net === 'testnet'
      ? process.env.TESTNET_URL ?? 'https://rpc.testnet.aztec-labs.com'
      : state.sandboxUrl ?? 'http://localhost:8090'

  const node = createAztecNodeClient(url)
  const info = await node.getNodeInfo()
  console.log(`[audit:${net}] ${url} — node ${info.nodeVersion}, l1 ${info.l1ChainId}\n`)

  const entries = Object.entries(state)
    .filter(([, v]) => v && typeof v === 'object' && 'address' in (v as object))
    .map(([k, v]) => [k, (v as { address: string }).address] as const)
    .sort((a, b) => a[0].localeCompare(b[0]))

  let live = 0
  let dead = 0
  for (const [name, addr] of entries) {
    try {
      const c = await node.getContract(AztecAddress.fromString(addr))
      if (c) {
        live++
        console.log(`  ✓ ${name.padEnd(26)} ${addr.slice(0, 14)}…`)
      } else {
        dead++
        console.log(`  ✗ ${name.padEnd(26)} ${addr.slice(0, 14)}…  NOT DEPLOYED`)
      }
    } catch (e) {
      dead++
      console.log(`  ✗ ${name.padEnd(26)} ${addr.slice(0, 14)}…  ERROR ${(e as Error).message.slice(0, 60)}`)
    }
  }
  console.log(`\n[audit:${net}] ${live}/${entries.length} live, ${dead} dead`)
  if (dead > 0) process.exitCode = 1
}

main().catch((e) => {
  console.error('[audit] FAILED:', e)
  process.exit(1)
})
