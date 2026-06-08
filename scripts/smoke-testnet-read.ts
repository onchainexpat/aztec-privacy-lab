/**
 * Read-only smoke test for an SDK/version bump. Registers our DEPLOYED testnet
 * AMM contracts (Token x2 + AMM) using the CURRENT @aztec/noir-contracts.js
 * artifacts and does public reads. If the vendored artifacts' class ids no
 * longer match what's deployed on testnet, registerContract throws
 * "Artifact does not match expected class id" — the same failure mode that
 * parked the multi-asset FPC. A clean run means the bump is compatible with our
 * live deployments (no redeploy needed).
 *
 *   npx tsx scripts/smoke-testnet-read.ts
 *   # reads via the public RPC by default; override with TESTNET_URL=...
 */
import { readFileSync } from 'node:fs'
import { resolve, dirname } from 'node:path'
import { fileURLToPath } from 'node:url'

import { EmbeddedWallet } from '@aztec/wallets/embedded'
import { createAztecNodeClient } from '@aztec/aztec.js/node'
import { AztecAddress } from '@aztec/stdlib/aztec-address'
import { TokenContract } from '@aztec/noir-contracts.js/Token'
import { AMMContract } from '@aztec/noir-contracts.js/AMM'
import { jsonParseWithSchema } from '@aztec/foundation/json-rpc'
import { ContractInstanceWithAddressSchema } from '@aztec/stdlib/contract'

const TESTNET_URL = process.env.TESTNET_URL ?? 'https://rpc.testnet.aztec-labs.com'
const __dirname = dirname(fileURLToPath(import.meta.url))
const stateFile = resolve(__dirname, '..', 'public', 'testnet-state.json')

function log(...a: unknown[]) {
  // eslint-disable-next-line no-console
  console.log('[smoke]', ...a)
}
function deser(raw: unknown) {
  return jsonParseWithSchema(JSON.stringify(raw), ContractInstanceWithAddressSchema)
}

async function main() {
  const state = JSON.parse(readFileSync(stateFile, 'utf8'))
  const node = createAztecNodeClient(TESTNET_URL)
  const info = await node.getNodeInfo()
  log('node', info.nodeVersion, '· reading from', TESTNET_URL)

  const wallet = await EmbeddedWallet.create(node, { ephemeral: true, pxe: { proverEnabled: false } })
  const deployer = AztecAddress.fromString(state.deployer)

  // The class-id checks: these throw if the 4.3.1 artifact != deployed class.
  log('registering deployed token0/token1/amm with current artifacts…')
  await wallet.registerContract(deser(state.token0.instance), TokenContract.artifact)
  await wallet.registerContract(deser(state.token1.instance), TokenContract.artifact)
  if (state.amm?.instance) {
    await wallet.registerContract(deser(state.amm.instance), AMMContract.artifact)
  }
  log('✓ registerContract accepted all artifacts — class ids match the deployment')

  // Bonus: exercise the read path. A fresh PXE can't see the deployer's notes,
  // so the value may be 0 — we only care that the simulate runs without error
  // under the new SDK (utility-fn ABI + node round-trip still line up).
  const token0 = await TokenContract.at(AztecAddress.fromString(state.token0.address), wallet)
  try {
    const { result: bal } = await token0.methods.balance_of_private(deployer).simulate({ from: deployer })
    log('token0 balance_of_private(deployer) simulate =', (bal as bigint).toString(), '(0 expected: no keys in this PXE)')
  } catch (e) {
    log('read path note:', (e as Error).message?.slice(0, 140))
  }

  log('✅ SMOKE PASS — deployed testnet contracts register cleanly under', info.nodeVersion)
  await wallet.stop?.()
}

main().then(
  () => process.exit(0),
  (e) => {
    console.error('[smoke] FAILED:', e)
    process.exit(1)
  },
)
