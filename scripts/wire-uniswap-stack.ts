/**
 * Wire the full Uniswap-from-L2 stack:
 *
 *   1. Deploy L1 TestERC20-B (output token).
 *   2. Deploy L1 OutputTokenPortal.
 *   3. Deploy L1 UniswapPortal (no init yet — needs the L2 Uniswap addr first).
 *   4. Redeploy L2 TokenBridge for AZB pointing at the L1 OutputTokenPortal.
 *   5. Initialize OutputTokenPortal with registry + TestERC20-B + L2 BridgeB.
 *   6. Redeploy L2 Uniswap with the real L1 UniswapPortal address.
 *   7. Initialize L1 UniswapPortal with registry + L2 Uniswap.
 *   8. Grant L2 BridgeB minter rights on AZB.
 *   9. Pre-fund the mock router with TestERC20-B so swaps can pay out.
 *
 * Pre-reqs: `npm run sandbox:setup` + `sandbox:seed` + `sandbox:l1-portal` + `sandbox:mock-router`.
 *
 *   npm run sandbox:uniswap
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
import { TestERC20Abi } from '@aztec/l1-artifacts/TestERC20Abi'
import { TestERC20Bytecode } from '@aztec/l1-artifacts/TestERC20Bytecode'
import { TokenPortalAbi } from '@aztec/l1-artifacts/TokenPortalAbi'
import { TokenPortalBytecode } from '@aztec/l1-artifacts/TokenPortalBytecode'
import { UniswapPortalAbi } from '@aztec/l1-artifacts/UniswapPortalAbi'
import { UniswapPortalBytecode } from '@aztec/l1-artifacts/UniswapPortalBytecode'
import { foundry } from 'viem/chains'
import { getContract, parseAbi } from 'viem'
import { jsonStringify, jsonParseWithSchema } from '@aztec/foundation/json-rpc'
import { ContractInstanceWithAddressSchema } from '@aztec/stdlib/contract'

const SANDBOX_URL = process.env.SANDBOX_URL ?? 'http://localhost:8090'
const L1_RPC = process.env.L1_RPC ?? 'http://localhost:8545'
const ANVIL_MNEMONIC = 'test test test test test test test test test test test junk'

const __dirname = dirname(fileURLToPath(import.meta.url))
const stateFile = resolve(__dirname, '..', 'public', 'sandbox-state.json')

function log(...args: unknown[]) {
  // eslint-disable-next-line no-console
  console.log('[wire-uniswap]', ...args)
}

async function main() {
  const state = JSON.parse(readFileSync(stateFile, 'utf8'))
  if (!state.crossChain?.mockSwapRouter) {
    throw new Error('Mock router not planted yet. Run npm run sandbox:mock-router first.')
  }

  log('connecting to L1 + L2…')
  const l1Client = createExtendedL1Client([L1_RPC], ANVIL_MNEMONIC, foundry)
  const node = createAztecNodeClient(SANDBOX_URL)
  const wallet = await EmbeddedWallet.create(node, { ephemeral: true })
  const [testAccount] = await getInitialTestAccountsData()
  await wallet.createSchnorrAccount(testAccount.secret, testAccount.salt, testAccount.signingKey)
  const admin = testAccount.address

  // Rehydrate L2 contracts we'll touch
  const tokenAzbInstance = jsonParseWithSchema(
    JSON.stringify(state.token1.instance),
    ContractInstanceWithAddressSchema,
  )
  await wallet.registerContract(tokenAzbInstance, TokenContract.artifact)
  const azbAddr = AztecAddress.fromString(state.token1.address)
  const tokenAzb = await TokenContract.at(azbAddr, wallet)

  // ----- L1: TestERC20-B + portals -----
  log('1. deploying L1 TestERC20-B (output token mirror of AZB)…')
  const erc20B = await deployL1Contract(
    l1Client,
    TestERC20Abi,
    TestERC20Bytecode,
    ['AztecB-L1', 'AZB1', l1Client.account.address],
  )
  log('   L1 TestERC20-B at', erc20B.address.toString())

  log('2. deploying L1 OutputTokenPortal…')
  const outputPortal = await deployL1Contract(l1Client, TokenPortalAbi, TokenPortalBytecode, [])
  log('   L1 OutputTokenPortal at', outputPortal.address.toString())

  log('3. deploying L1 UniswapPortal…')
  const uniswapPortal = await deployL1Contract(
    l1Client,
    UniswapPortalAbi,
    UniswapPortalBytecode,
    [],
  )
  log('   L1 UniswapPortal at', uniswapPortal.address.toString())

  // ----- L2: AZB bridge + redeployed Uniswap -----
  log('4. deploying L2 TokenBridge for AZB pointing at OutputTokenPortal…')
  const { contract: l2BridgeB } = await TokenBridgeContract.deploy(
    wallet,
    azbAddr,
    outputPortal.address,
  ).send({ from: admin })
  log('   L2 BridgeB at', l2BridgeB.address.toString())

  log('5. redeploying L2 Uniswap with real UniswapPortal address…')
  const { contract: l2Uniswap } = await UniswapContract.deploy(
    wallet,
    uniswapPortal.address,
  ).send({ from: admin })
  log('   L2 Uniswap (real portal) at', l2Uniswap.address.toString())

  // ----- L1 initializations -----
  const registry = await readRegistry()
  log('6. initialising OutputTokenPortal…')
  const opCtr = getContract({
    abi: TokenPortalAbi,
    address: outputPortal.address.toString() as `0x${string}`,
    client: l1Client,
  })
  await opCtr.write.initialize([
    registry as `0x${string}`,
    erc20B.address.toString() as `0x${string}`,
    l2BridgeB.address.toString() as `0x${string}`,
  ])

  log('7. initialising UniswapPortal…')
  const upCtr = getContract({
    abi: UniswapPortalAbi,
    address: uniswapPortal.address.toString() as `0x${string}`,
    client: l1Client,
  })
  await upCtr.write.initialize([
    registry as `0x${string}`,
    l2Uniswap.address.toString() as `0x${string}`,
  ])

  log('8. granting L2 BridgeB minter rights on AZB…')
  await tokenAzb.methods.set_minter(l2BridgeB.address, true).send({ from: admin })

  // ----- Pre-fund the mock router so it can pay out swaps -----
  log('9. pre-funding mock router with 1,000,000 TestERC20-B…')
  const mintHash = await getContract({
    abi: parseAbi(['function mint(address to, uint256 amount) external']),
    address: erc20B.address.toString() as `0x${string}`,
    client: l1Client,
  }).write.mint([state.crossChain.mockSwapRouter as `0x${string}`, 1_000_000n])
  log('   mint tx', mintHash)

  log('10. pre-funding input portal with 100,000 TestERC20-A (so L2 swap withdrawals have something to release)…')
  const fundInputHash = await getContract({
    abi: parseAbi(['function mint(address to, uint256 amount) external']),
    address: state.crossChain.l1Token as `0x${string}`,
    client: l1Client,
  }).write.mint([state.crossChain.l1Portal as `0x${string}`, 100_000n])
  log('   mint tx', fundInputHash)

  // ----- Persist state -----
  state.crossChain = {
    ...state.crossChain,
    l1TokenB: erc20B.address.toString(),
    l1OutputPortal: outputPortal.address.toString(),
    l1UniswapPortal: uniswapPortal.address.toString(),
    l2BridgeB: l2BridgeB.address.toString(),
    l2BridgeBInstance: JSON.parse(
      jsonStringify((await wallet.getContractMetadata(l2BridgeB.address)).instance!),
    ),
    l2Uniswap: l2Uniswap.address.toString(),
    l2UniswapInstance: JSON.parse(
      jsonStringify((await wallet.getContractMetadata(l2Uniswap.address)).instance!),
    ),
  }
  writeFileSync(stateFile, JSON.stringify(state, null, 2))
  log('done — full Uniswap-from-L2 stack wired. State updated.')

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
    console.error('[wire-uniswap] FAILED:', err)
    process.exit(1)
  },
)
