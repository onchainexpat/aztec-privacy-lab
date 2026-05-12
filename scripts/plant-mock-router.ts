/**
 * Plant a mock Uniswap V3 SwapRouter at the hardcoded mainnet address
 * (0xE592...1564) on the sandbox anvil chain, so the bundled UniswapPortal
 * can complete a swap without forking mainnet.
 *
 *   npm run sandbox:mock-router
 */
import { readFileSync, writeFileSync } from 'node:fs'
import { resolve, dirname } from 'node:path'
import { fileURLToPath } from 'node:url'

import { createPublicClient, getContract, http, parseAbi } from 'viem'
import { foundry } from 'viem/chains'
import { createExtendedL1Client } from '@aztec/ethereum/client'
import { deployL1Contract } from '@aztec/ethereum/deploy-l1-contract'

const L1_RPC = process.env.L1_RPC ?? 'http://localhost:8545'
const ANVIL_MNEMONIC = 'test test test test test test test test test test test junk'
// The hardcoded Uniswap V3 SwapRouter address that bundled UniswapPortal.sol expects.
const MAINNET_ROUTER = '0xE592427A0AEce92De3Edee1F18E0157C05861564' as const

const __dirname = dirname(fileURLToPath(import.meta.url))
const artifactPath = resolve(
  __dirname,
  '..',
  'contracts-l1',
  'MockSwapRouter',
  'out',
  'MockSwapRouter.sol',
  'MockSwapRouter.json',
)
const stateFile = resolve(__dirname, '..', 'public', 'sandbox-state.json')

function log(...args: unknown[]) {
  // eslint-disable-next-line no-console
  console.log('[mock-router]', ...args)
}

async function main() {
  const artifact = JSON.parse(readFileSync(artifactPath, 'utf8'))
  const abi = artifact.abi
  const bytecode = artifact.bytecode.object as `0x${string}`

  log('connecting to L1', L1_RPC)
  const wallet = createExtendedL1Client([L1_RPC], ANVIL_MNEMONIC, foundry)
  const pub = createPublicClient({ transport: http(L1_RPC) })

  log('deploying MockSwapRouter normally to extract runtime bytecode…')
  const deploy = await deployL1Contract(wallet, abi, bytecode, [])
  const deployedAt = deploy.address.toString() as `0x${string}`
  log('mock router deployed at', deployedAt)

  const runtime = (await pub.getCode({ address: deployedAt })) as `0x${string}` | undefined
  if (!runtime || runtime === '0x') throw new Error('no runtime code at deployed address')
  log('runtime size:', (runtime.length - 2) / 2, 'bytes')

  log('anvil_setCode → planting runtime at hardcoded mainnet router address', MAINNET_ROUTER)
  await pub.request({
    method: 'anvil_setCode' as 'eth_sendTransaction',
    params: [MAINNET_ROUTER, runtime] as never,
  })

  const planted = (await pub.getCode({ address: MAINNET_ROUTER })) as `0x${string}` | undefined
  if (!planted || planted === '0x' || planted.length < 100) {
    throw new Error(`anvil_setCode failed — code at ${MAINNET_ROUTER} = ${planted}`)
  }
  log('planted code size at router address:', (planted.length - 2) / 2, 'bytes')

  // Read the state file and append the router info.
  const state = JSON.parse(readFileSync(stateFile, 'utf8'))
  state.crossChain = {
    ...(state.crossChain ?? {}),
    mockSwapRouter: MAINNET_ROUTER,
    mockSwapRouterRuntimeAt: deployedAt,
  }
  writeFileSync(stateFile, JSON.stringify(state, null, 2))
  log('updated', stateFile)

  // Sanity-check: probe the router via a view call (no-op — just confirm code shape).
  const probe = getContract({ abi: parseAbi(['function transferFrom(address,address,uint256) external returns (bool)']), address: MAINNET_ROUTER, client: pub })
  log('router contract handle resolved at', probe.address)
  log('done — UniswapPortal swap calls can now reach this mock.')
}

main().then(
  () => process.exit(0),
  (err) => {
    console.error('[mock-router] FAILED:', err)
    process.exit(1)
  },
)
