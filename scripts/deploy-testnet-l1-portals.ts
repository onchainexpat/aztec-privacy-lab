/**
 * Deploy the L1 half of variant h on Sepolia (Aztec Alpha v4 testnet's L1).
 *
 *   1. Deploy TestERC20-A and TestERC20-B (mirrors of L2 AZA + AZB) — these are
 *      throwaway demo tokens, NOT real WETH/USDC.
 *   2. Deploy two TokenPortal instances (input + output).
 *   3. Deploy UniswapPortalSepolia (modified version that accepts the V3 router
 *      as an init param so it works on Sepolia, not just mainnet).
 *   4. Mint a starting supply of TestERC20-A into the L1 deployer + the input
 *      portal so withdrawals have something to release.
 *
 * The L2 (Aztec testnet) bridges + L2 Uniswap contract get deployed by
 * `npm run testnet:wire-uniswap` AFTER this script finishes, so we know the
 * portal addresses up front.
 *
 *   SEPOLIA_RPC=https://... SEPOLIA_PRIVATE_KEY=0x... \
 *   SEPOLIA_V3_SWAPROUTER=0x3bFA4769FB09eefC5a80d6E87c3B9C650f7Ae48E \
 *     npm run testnet:deploy-l1-portals
 *
 * Pre-reqs: Sepolia ETH on the deployer account (~0.1 ETH covers it), and a
 * deployed Aztec testnet account from `npm run testnet:setup`. Reads the
 * Aztec L1 registry address from the Aztec testnet node.
 */
import { readFileSync, writeFileSync } from 'node:fs'
import { resolve, dirname } from 'node:path'
import { fileURLToPath } from 'node:url'

import { createAztecNodeClient } from '@aztec/aztec.js/node'
import { deployL1Contract } from '@aztec/ethereum/deploy-l1-contract'
import { TestERC20Abi } from '@aztec/l1-artifacts/TestERC20Abi'
import { TestERC20Bytecode } from '@aztec/l1-artifacts/TestERC20Bytecode'
import { TokenPortalAbi } from '@aztec/l1-artifacts/TokenPortalAbi'
import { TokenPortalBytecode } from '@aztec/l1-artifacts/TokenPortalBytecode'
import { sepolia } from 'viem/chains'
import { createPublicClient, getContract, http, parseAbi } from 'viem'
import { privateKeyToAccount } from 'viem/accounts'
import { createExtendedL1Client } from '@aztec/ethereum/client'

const TESTNET_URL = process.env.TESTNET_URL ?? 'https://rpc.testnet.aztec-labs.com'
const SEPOLIA_RPC = process.env.SEPOLIA_RPC
const SEPOLIA_PRIVATE_KEY = process.env.SEPOLIA_PRIVATE_KEY as `0x${string}` | undefined
// Sepolia V3 SwapRouter02 per Uniswap docs; override if Uniswap drifts.
const SEPOLIA_V3_SWAPROUTER =
  (process.env.SEPOLIA_V3_SWAPROUTER as `0x${string}` | undefined) ??
  '0x3bFA4769FB09eefC5a80d6E87c3B9C650f7Ae48E'

const __dirname = dirname(fileURLToPath(import.meta.url))
const stateFile = resolve(__dirname, '..', 'public', 'testnet-state.json')
const portalArtifactPath = resolve(
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
  console.log('[testnet-deploy-l1]', ...args)
}

async function main() {
  if (!SEPOLIA_RPC || !SEPOLIA_PRIVATE_KEY) {
    throw new Error(
      'Set SEPOLIA_RPC and SEPOLIA_PRIVATE_KEY env vars. Deployer needs ~0.1 Sepolia ETH.',
    )
  }
  const state = JSON.parse(readFileSync(stateFile, 'utf8'))

  // Pull the Aztec testnet L1 registry from the node — never hardcode an L1
  // address into a script; the node is the source of truth.
  log('connecting to Aztec testnet', TESTNET_URL)
  const node = createAztecNodeClient(TESTNET_URL)
  const info = await node.getNodeInfo()
  const registryAddr = info.l1ContractAddresses.registryAddress.toString()
  log('Aztec L1 registry on Sepolia:', registryAddr)

  log('loading UniswapPortalSepolia artifact…')
  const portalArtifact = JSON.parse(readFileSync(portalArtifactPath, 'utf8'))

  log('connecting to Sepolia L1', SEPOLIA_RPC)
  const account = privateKeyToAccount(SEPOLIA_PRIVATE_KEY)
  // Use Aztec's extended L1 client — it wires gas estimation, retries, and the
  // viem `account` field the way `deployL1Contract` expects.
  const l1Client = createExtendedL1Client([SEPOLIA_RPC], SEPOLIA_PRIVATE_KEY, sepolia)
  const publicClient = createPublicClient({ transport: http(SEPOLIA_RPC), chain: sepolia })
  log('L1 deployer =', account.address)
  const bal = await publicClient.getBalance({ address: account.address })
  log('L1 deployer balance:', bal.toString(), 'wei')
  if (bal < 50_000_000_000_000_000n) {
    log('WARNING: deployer balance is below 0.05 ETH — may run out mid-deploy.')
  }

  // ---- L1 ERC20s ----
  log('1. deploying L1 TestERC20-A (mirror of AZA)…')
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const erc20A = await deployL1Contract(l1Client as any, TestERC20Abi, TestERC20Bytecode, [
    'AztecA-L1',
    'AZA1',
    account.address,
  ])
  log('   TestERC20-A at', erc20A.address.toString())

  log('2. deploying L1 TestERC20-B (mirror of AZB)…')
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const erc20B = await deployL1Contract(l1Client as any, TestERC20Abi, TestERC20Bytecode, [
    'AztecB-L1',
    'AZB1',
    account.address,
  ])
  log('   TestERC20-B at', erc20B.address.toString())

  // ---- L1 portals ----
  log('3. deploying L1 input TokenPortal…')
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const inputPortal = await deployL1Contract(l1Client as any, TokenPortalAbi, TokenPortalBytecode, [])
  log('   input TokenPortal at', inputPortal.address.toString())

  log('4. deploying L1 output TokenPortal…')
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const outputPortal = await deployL1Contract(l1Client as any, TokenPortalAbi, TokenPortalBytecode, [])
  log('   output TokenPortal at', outputPortal.address.toString())

  log('5. deploying UniswapPortalSepolia…')
  const uniPortalDeploy = await deployL1Contract(
    l1Client,
    portalArtifact.abi,
    portalArtifact.bytecode.object as `0x${string}`,
    [],
  )
  log('   UniswapPortalSepolia at', uniPortalDeploy.address.toString())

  // Pre-mint a supply into the input portal so L2->L1 withdrawals have tokens
  // to release. The output portal gets minted when the L2 bridge mints AZB on
  // claim — no L1 supply needed.
  log('6. minting 1,000,000 TestERC20-A into the input portal…')
  const erc20AContract = getContract({
    abi: parseAbi([
      'function mint(address to, uint256 amount) external',
      'function balanceOf(address) view returns (uint256)',
    ]),
    address: erc20A.address.toString() as `0x${string}`,
    client: l1Client,
  })
  const mintTx = await erc20AContract.write.mint([
    inputPortal.address.toString() as `0x${string}`,
    1_000_000n,
  ])
  log('   mint tx', mintTx)

  // ---- Persist state — note: portals not initialized yet; that happens in
  // wire-testnet-uniswap.ts AFTER we know the L2 bridge addresses.
  state.crossChain = {
    ...(state.crossChain ?? {}),
    l1Rpc: SEPOLIA_RPC,
    l1ChainId: sepolia.id,
    l1Deployer: account.address,
    l1Token: erc20A.address.toString(),
    l1TokenB: erc20B.address.toString(),
    l1Portal: inputPortal.address.toString(),
    l1OutputPortal: outputPortal.address.toString(),
    l1UniswapPortal: uniPortalDeploy.address.toString(),
    l1Router: SEPOLIA_V3_SWAPROUTER,
    registryAddress: registryAddr,
    // Mark portals as not-yet-initialized so wire-testnet-uniswap.ts knows to
    // run initialize() after deploying the L2 side.
    portalsInitialized: false,
  }
  writeFileSync(stateFile, JSON.stringify(state, null, 2))
  log('done — L1 side ready. Run npm run testnet:wire-uniswap to wire the L2 contracts.')
}

main().then(
  () => process.exit(0),
  (err) => {
    console.error('[testnet-deploy-l1] FAILED:', err)
    process.exit(1)
  },
)
