/**
 * Wire the Aztec → L1 Uniswap stack against a MAINNET-FORKED Anvil so swaps
 * route through the real Uniswap V3 SwapRouter (0xE592...1564) at real
 * mainnet pool liquidity. Mock router is bypassed entirely.
 *
 * Pre-reqs:
 *   1. Anvil running on http://localhost:8546 in fork mode:
 *        ./scripts/start-fork-anvil.sh
 *   2. Aztec sandbox running on http://localhost:8090 pointed at that Anvil:
 *        ETHEREUM_HOSTS=http://localhost:8546 aztec start --local-network --port 8090
 *   3. L2 base deployed (Token AZA + AZB, AMM, etc.):
 *        npm run sandbox:setup
 *
 * What this script does:
 *   1. Acquires WETH for the L1 deployer via WETH.deposit{value: ...}().
 *   2. Deploys L1 input TokenPortal pointing at real WETH.
 *   3. Deploys L1 output TokenPortal pointing at real USDC.
 *   4. Deploys L1 UniswapPortal.
 *   5. Re-deploys L2 BridgeA (mirrors WETH as the L2 AZA token).
 *   6. Re-deploys L2 BridgeB (mirrors USDC as the L2 AZB token).
 *   7. Re-deploys L2 Uniswap with the real UniswapPortal address.
 *   8. Initialises all three L1 portals (registry, ERC20, L2 counterpart).
 *   9. Grants bridge minter rights on AZA + AZB.
 *  10. Pre-funds the input portal with WETH so the L2 swap_private's
 *      withdrawal message has something to release.
 *  11. Persists state to public/sandbox-state.json under crossChain with
 *      realUniswapForked=true so the UI can switch labels.
 *
 *   npm run sandbox:fork-uniswap
 */
import { readFileSync, writeFileSync } from 'node:fs'
import { resolve, dirname } from 'node:path'
import { fileURLToPath } from 'node:url'

import { EmbeddedWallet } from '@aztec/wallets/embedded'
import { getInitialTestAccountsData } from '@aztec/accounts/testing/lazy'
import { createAztecNodeClient } from '@aztec/aztec.js/node'
import { AztecAddress } from '@aztec/stdlib/aztec-address'
import { TokenContract } from '@aztec/noir-contracts.js/Token'
import { TokenBridgeContract } from '@aztec/noir-contracts.js/TokenBridge'
import { UniswapContract } from '@aztec/noir-contracts.js/Uniswap'
import { createExtendedL1Client } from '@aztec/ethereum/client'
import { deployL1Contract } from '@aztec/ethereum/deploy-l1-contract'
import { TokenPortalAbi } from '@aztec/l1-artifacts/TokenPortalAbi'
import { TokenPortalBytecode } from '@aztec/l1-artifacts/TokenPortalBytecode'
import { UniswapPortalAbi } from '@aztec/l1-artifacts/UniswapPortalAbi'
import { UniswapPortalBytecode } from '@aztec/l1-artifacts/UniswapPortalBytecode'
import { foundry } from 'viem/chains'
import { getContract, parseAbi, parseEther } from 'viem'
import { jsonStringify, jsonParseWithSchema } from '@aztec/foundation/json-rpc'
import { ContractInstanceWithAddressSchema } from '@aztec/stdlib/contract'

const SANDBOX_URL = process.env.SANDBOX_URL ?? 'http://localhost:8090'
const L1_RPC = process.env.L1_RPC ?? 'http://localhost:8546'
const ANVIL_MNEMONIC = 'test test test test test test test test test test test junk'

// Canonical mainnet addresses — present in the forked Anvil because we forked
// mainnet state. The Aztec UniswapPortal has the V3 SwapRouter hardcoded.
const WETH = '0xC02aaA39b223FE8D0A0e5C4F27eAD9083C756Cc2'
const USDC = '0xA0b86991c6218b36c1d19D4a2e9Eb0cE3606eB48'
const V3_ROUTER = '0xE592427A0AEce92De3Edee1F18E0157C05861564'

// Pre-fund denominations on real Uniswap V3.
// 0.1 WETH gives plenty of headroom for the 0.01 WETH demo swap.
const PORTAL_PREFUND_WETH = parseEther('0.1')
const DEPLOYER_WETH_TOPUP = parseEther('0.2')

const __dirname = dirname(fileURLToPath(import.meta.url))
const stateFile = resolve(__dirname, '..', 'public', 'sandbox-state.json')

function log(...args: unknown[]) {
  // eslint-disable-next-line no-console
  console.log('[fork-uniswap]', ...args)
}

const WETH_ABI = parseAbi([
  'function deposit() payable',
  'function balanceOf(address) view returns (uint256)',
  'function transfer(address to, uint256 amount) returns (bool)',
])

async function main() {
  const state = JSON.parse(readFileSync(stateFile, 'utf8'))
  if (!state.token0?.instance || !state.token1?.instance) {
    throw new Error('L2 tokens not deployed. Run npm run sandbox:setup first.')
  }

  log('connecting to L1', L1_RPC)
  const l1Client = createExtendedL1Client([L1_RPC], ANVIL_MNEMONIC, foundry)

  log('checking forked Anvil has real Uniswap V3 SwapRouter at', V3_ROUTER)
  const routerCode = await l1Client.getCode({ address: V3_ROUTER as `0x${string}` })
  if (!routerCode || routerCode === '0x' || routerCode.length < 100) {
    throw new Error(
      'No SwapRouter code at the mainnet address — is Anvil running with --fork-url <mainnet>?',
    )
  }
  log('   router runtime bytes:', (routerCode.length - 2) / 2)

  const weth = getContract({ abi: WETH_ABI, address: WETH as `0x${string}`, client: l1Client })

  log('1. acquiring WETH for L1 deployer via WETH.deposit…')
  await weth.write.deposit({ value: DEPLOYER_WETH_TOPUP })
  const deployerWethBal = (await weth.read.balanceOf([l1Client.account.address])) as bigint
  log('   deployer WETH balance:', deployerWethBal.toString())

  log('connecting to L2', SANDBOX_URL)
  const node = createAztecNodeClient(SANDBOX_URL)
  const wallet = await EmbeddedWallet.create(node, { ephemeral: true })
  const [testAccount] = await getInitialTestAccountsData()
  await wallet.createSchnorrAccount(testAccount.secret, testAccount.salt, testAccount.signingKey)
  const admin = testAccount.address

  function deser(raw: unknown) {
    return jsonParseWithSchema(JSON.stringify(raw), ContractInstanceWithAddressSchema)
  }
  await wallet.registerContract(deser(state.token0.instance), TokenContract.artifact)
  await wallet.registerContract(deser(state.token1.instance), TokenContract.artifact)
  const tokenA = await TokenContract.at(AztecAddress.fromString(state.token0.address), wallet)
  const tokenB = await TokenContract.at(AztecAddress.fromString(state.token1.address), wallet)

  log('2. deploying L1 input TokenPortal (WETH)…')
  const inputPortal = await deployL1Contract(l1Client, TokenPortalAbi, TokenPortalBytecode, [])
  log('   input portal at', inputPortal.address.toString())

  log('3. deploying L1 output TokenPortal (USDC)…')
  const outputPortal = await deployL1Contract(l1Client, TokenPortalAbi, TokenPortalBytecode, [])
  log('   output portal at', outputPortal.address.toString())

  log('4. deploying L1 UniswapPortal…')
  const uniswapPortal = await deployL1Contract(
    l1Client,
    UniswapPortalAbi,
    UniswapPortalBytecode,
    [],
  )
  log('   uniswap portal at', uniswapPortal.address.toString())

  log('5. deploying L2 TokenBridge for AZA → input portal…')
  const { contract: l2BridgeA } = await TokenBridgeContract.deploy(
    wallet,
    tokenA.address,
    inputPortal.address,
  ).send({ from: admin })
  log('   L2 BridgeA at', l2BridgeA.address.toString())

  log('6. deploying L2 TokenBridge for AZB → output portal…')
  const { contract: l2BridgeB } = await TokenBridgeContract.deploy(
    wallet,
    tokenB.address,
    outputPortal.address,
  ).send({ from: admin })
  log('   L2 BridgeB at', l2BridgeB.address.toString())

  log('7. deploying L2 Uniswap → real UniswapPortal address…')
  const { contract: l2Uniswap } = await UniswapContract.deploy(
    wallet,
    uniswapPortal.address,
  ).send({ from: admin })
  log('   L2 Uniswap at', l2Uniswap.address.toString())

  const registry = await readRegistry()
  log('8. initialising input portal (registry + WETH + L2 BridgeA)…')
  await getContract({
    abi: TokenPortalAbi,
    address: inputPortal.address.toString() as `0x${string}`,
    client: l1Client,
  }).write.initialize([
    registry as `0x${string}`,
    WETH as `0x${string}`,
    l2BridgeA.address.toString() as `0x${string}`,
  ])

  log('9. initialising output portal (registry + USDC + L2 BridgeB)…')
  await getContract({
    abi: TokenPortalAbi,
    address: outputPortal.address.toString() as `0x${string}`,
    client: l1Client,
  }).write.initialize([
    registry as `0x${string}`,
    USDC as `0x${string}`,
    l2BridgeB.address.toString() as `0x${string}`,
  ])

  log('10. initialising UniswapPortal (registry + L2 Uniswap)…')
  await getContract({
    abi: UniswapPortalAbi,
    address: uniswapPortal.address.toString() as `0x${string}`,
    client: l1Client,
  }).write.initialize([registry as `0x${string}`, l2Uniswap.address.toString() as `0x${string}`])

  log('11. granting bridge minter rights on AZA + AZB…')
  await tokenA.methods.set_minter(l2BridgeA.address, true).send({ from: admin })
  await tokenB.methods.set_minter(l2BridgeB.address, true).send({ from: admin })

  log('12. pre-funding input portal with', PORTAL_PREFUND_WETH.toString(), 'wei WETH…')
  await weth.write.transfer([inputPortal.address.toString() as `0x${string}`, PORTAL_PREFUND_WETH])
  const portalBal = (await weth.read.balanceOf([
    inputPortal.address.toString() as `0x${string}`,
  ])) as bigint
  log('   input portal WETH balance:', portalBal.toString())

  log('persisting state…')
  state.crossChain = {
    ...(state.crossChain ?? {}),
    realUniswapForked: true,
    l1Rpc: L1_RPC,
    l1Deployer: l1Client.account.address,
    registryAddress: registry,
    l1Token: WETH,
    l1Portal: inputPortal.address.toString(),
    l1TokenB: USDC,
    l1OutputPortal: outputPortal.address.toString(),
    l1UniswapPortal: uniswapPortal.address.toString(),
    l1Router: V3_ROUTER,
    bridge0: l2BridgeA.address.toString(),
    bridge0Instance: JSON.parse(
      jsonStringify((await wallet.getContractMetadata(l2BridgeA.address)).instance!),
    ),
    l2BridgeB: l2BridgeB.address.toString(),
    l2BridgeBInstance: JSON.parse(
      jsonStringify((await wallet.getContractMetadata(l2BridgeB.address)).instance!),
    ),
    l2Uniswap: l2Uniswap.address.toString(),
    l2UniswapInstance: JSON.parse(
      jsonStringify((await wallet.getContractMetadata(l2Uniswap.address)).instance!),
    ),
    // Forked mode swap defaults — real V3 needs meaningful denominations or
    // the pool returns < amountOutMinimum. Demos use 0.01 WETH.
    forkedSwapAmountInWei: '10000000000000000', // 0.01 WETH
    forkedSwapFeeTier: 3000, // 0.3%
    forkedSwapMinOut: '1', // accept any non-zero output
  }
  writeFileSync(stateFile, JSON.stringify(state, null, 2))

  log('done — real Uniswap V3 stack wired against mainnet-forked Anvil.')
  log('       try: npm run sandbox:swap-l1-private-forked')

  await wallet.stop()
}

async function readRegistry(): Promise<string> {
  const res = await fetch(SANDBOX_URL, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'node_getNodeInfo', params: [] }),
  })
  const json = (await res.json()) as {
    result: { l1ContractAddresses: { registryAddress: string } }
  }
  return json.result.l1ContractAddresses.registryAddress
}

main().then(
  () => process.exit(0),
  (err) => {
    console.error('[fork-uniswap] FAILED:', err)
    process.exit(1)
  },
)
