/**
 * One-shot: deploy MockSwapRouter on Sepolia, pre-fund it with TestERC20-B,
 * then re-initialize UniswapPortalSepolia to point at the mock instead of the
 * real Uniswap V3 router (which doesn't have a pool for our test pair).
 *
 *   SEPOLIA_RPC=... SEPOLIA_PRIVATE_KEY=... npm run testnet:plant-mock-router
 */
import { readFileSync, writeFileSync } from 'node:fs'
import { resolve, dirname } from 'node:path'
import { fileURLToPath } from 'node:url'

import { createExtendedL1Client } from '@aztec/ethereum/client'
import { deployL1Contract } from '@aztec/ethereum/deploy-l1-contract'
import { sepolia } from 'viem/chains'
import { createPublicClient, getContract, http, parseAbi } from 'viem'

const SEPOLIA_RPC = process.env.SEPOLIA_RPC
const SEPOLIA_PRIVATE_KEY = process.env.SEPOLIA_PRIVATE_KEY as `0x${string}` | undefined

const __dirname = dirname(fileURLToPath(import.meta.url))
const stateFile = resolve(__dirname, '..', 'public', 'testnet-state.json')
const mockArtifactPath = resolve(
  __dirname,
  '..',
  'contracts-l1',
  'MockSwapRouter',
  'out',
  'MockSwapRouter.sol',
  'MockSwapRouter.json',
)
const uniPortalArtifactPath = resolve(
  __dirname,
  '..',
  'contracts-l1',
  'UniswapPortalSepolia',
  'out',
  'UniswapPortalSepolia.sol',
  'UniswapPortalSepolia.json',
)

function log(...args: unknown[]) {
  // eslint-disable-next-line no-console
  console.log('[testnet-mock-router]', ...args)
}

async function main() {
  if (!SEPOLIA_RPC || !SEPOLIA_PRIVATE_KEY) {
    throw new Error('Set SEPOLIA_RPC and SEPOLIA_PRIVATE_KEY env vars.')
  }
  const state = JSON.parse(readFileSync(stateFile, 'utf8'))
  if (!state.crossChain?.l1UniswapPortal) {
    throw new Error('L1 portals not deployed. Run testnet:deploy-l1-portals first.')
  }

  const mockArtifact = JSON.parse(readFileSync(mockArtifactPath, 'utf8'))
  const uniArtifact = JSON.parse(readFileSync(uniPortalArtifactPath, 'utf8'))

  log('connecting to Sepolia', SEPOLIA_RPC)
  const l1Client = createExtendedL1Client([SEPOLIA_RPC], SEPOLIA_PRIVATE_KEY, sepolia)
  const publicClient = createPublicClient({ transport: http(SEPOLIA_RPC), chain: sepolia })

  log('1. deploying MockSwapRouter…')
  const deploy = await deployL1Contract(
    l1Client,
    mockArtifact.abi,
    mockArtifact.bytecode.object as `0x${string}`,
    [],
  )
  const mockAddr = deploy.address.toString()
  log('   MockSwapRouter at', mockAddr)

  log('2. pre-funding mock router with 1,000,000 TestERC20-B…')
  const erc20B = getContract({
    abi: parseAbi(['function mint(address to, uint256 amount) external']),
    address: state.crossChain.l1TokenB as `0x${string}`,
    client: l1Client,
  })
  const mintTx = await erc20B.write.mint([mockAddr as `0x${string}`, 1_000_000n])
  log('   mint tx', mintTx)
  await publicClient.waitForTransactionReceipt({ hash: mintTx })

  log('3. re-initializing UniswapPortalSepolia with mock router…')
  const uniPortal = getContract({
    abi: uniArtifact.abi,
    address: state.crossChain.l1UniswapPortal as `0x${string}`,
    client: l1Client,
  })
  const reinitTx = await uniPortal.write.initialize([
    state.crossChain.registryAddress as `0x${string}`,
    state.crossChain.l2Uniswap as `0x${string}`,
    mockAddr as `0x${string}`,
  ])
  log('   reinit tx', reinitTx)
  await publicClient.waitForTransactionReceipt({ hash: reinitTx })

  state.crossChain = {
    ...state.crossChain,
    l1Router: mockAddr,
    mockSwapRouter: mockAddr,
  }
  writeFileSync(stateFile, JSON.stringify(state, null, 2))
  log('done — router replaced with mock; testnet:swap-l1-private should now complete E2E.')
}

main().then(
  () => process.exit(0),
  (err) => {
    console.error('[testnet-mock-router] FAILED:', err)
    process.exit(1)
  },
)
