/**
 * Deploy real L1 portal infrastructure paired with the L2 TokenBridge for AZA:
 *   1. Deploy a TestERC20 on anvil (the L1 mirror of AZA).
 *   2. Deploy TokenPortal.sol on anvil.
 *   3. Re-deploy the L2 TokenBridge with the real portal address.
 *   4. Initialize the L1 portal with the registry + ERC20 + L2 bridge address.
 *   5. Mint TestERC20 to the deployer.
 *
 * This closes the L1 half of Phase 2 (token bridge, not the Uniswap swap).
 * Patches public/sandbox-state.json with the new bridge address + L1 portal +
 * ERC20 addresses so the dashboard can surface them.
 */
import { readFileSync, writeFileSync } from 'node:fs'
import { resolve, dirname } from 'node:path'
import { fileURLToPath } from 'node:url'

import { EmbeddedWallet } from '@aztec/wallets/embedded'
import { getInitialTestAccountsData } from '@aztec/accounts/testing/lazy'
import { createAztecNodeClient } from '@aztec/aztec.js/node'
import { EthAddress } from '@aztec/aztec.js/addresses'
import { TokenBridgeContract } from '@aztec/noir-contracts.js/TokenBridge'
import { jsonStringify, jsonParseWithSchema } from '@aztec/foundation/json-rpc'
import { ContractInstanceWithAddressSchema } from '@aztec/stdlib/contract'
import { AztecAddress } from '@aztec/stdlib/aztec-address'
import { createExtendedL1Client } from '@aztec/ethereum/client'
import { deployL1Contract } from '@aztec/ethereum/deploy-l1-contract'
import { TestERC20Abi, TestERC20Bytecode } from '@aztec/l1-artifacts/TestERC20Abi'
import { TestERC20Bytecode as TestERC20Code } from '@aztec/l1-artifacts/TestERC20Bytecode'
import { TokenPortalAbi } from '@aztec/l1-artifacts/TokenPortalAbi'
import { TokenPortalBytecode } from '@aztec/l1-artifacts/TokenPortalBytecode'
import { foundry } from 'viem/chains'
import { getContract, parseAbi } from 'viem'

const SANDBOX_URL = process.env.SANDBOX_URL ?? 'http://localhost:8090'
const L1_RPC = process.env.L1_RPC ?? 'http://localhost:8545'
// Anvil default mnemonic — first account is index 0.
const ANVIL_MNEMONIC = 'test test test test test test test test test test test junk'

const __dirname = dirname(fileURLToPath(import.meta.url))
const stateFile = resolve(__dirname, '..', 'public', 'sandbox-state.json')

function log(...args: unknown[]) {
  // eslint-disable-next-line no-console
  console.log('[deploy-l1-portal]', ...args)
}

async function main() {
  const state = JSON.parse(readFileSync(stateFile, 'utf8'))
  log('loaded state from', stateFile)

  log('connecting to L1', L1_RPC)
  const l1Client = createExtendedL1Client([L1_RPC], ANVIL_MNEMONIC, foundry)
  log('L1 deployer =', l1Client.account.address)

  log('connecting to L2', SANDBOX_URL)
  const node = createAztecNodeClient(SANDBOX_URL)
  const wallet = await EmbeddedWallet.create(node, { ephemeral: true })
  const [testAccount] = await getInitialTestAccountsData()
  await wallet.createSchnorrAccount(testAccount.secret, testAccount.salt, testAccount.signingKey)
  const admin = testAccount.address

  // Rehydrate AZA Token instance on the L2 side
  const { TokenContract } = await import('@aztec/noir-contracts.js/Token')
  const tokenInstance = jsonParseWithSchema(
    JSON.stringify(state.token0.instance),
    ContractInstanceWithAddressSchema,
  )
  await wallet.registerContract(tokenInstance, TokenContract.artifact)

  log('deploying L1 TestERC20 (mirror of AZA)…')
  const erc20Deploy = await deployL1Contract(
    l1Client,
    TestERC20Abi,
    TestERC20Code,
    ['AztecA-L1', 'AZA1', l1Client.account.address],
  )
  const l1Token = erc20Deploy.address.toString()
  log('L1 TestERC20 at', l1Token)

  log('deploying L1 TokenPortal…')
  const portalDeploy = await deployL1Contract(l1Client, TokenPortalAbi, TokenPortalBytecode, [])
  const l1Portal = portalDeploy.address.toString()
  log('L1 TokenPortal at', l1Portal)

  log('re-deploying L2 TokenBridge with real portal address…')
  const { contract: l2Bridge } = await TokenBridgeContract.deploy(
    wallet,
    AztecAddress.fromString(state.token0.address),
    portalDeploy.address,
  ).send({ from: admin })
  log('L2 TokenBridge(real portal) at', l2Bridge.address.toString())

  // L2 bridge needs to be a minter of AZA so it can mint tokens for users on claim.
  log('granting bridge minter rights on AZA…')
  const token0 = await TokenContract.at(AztecAddress.fromString(state.token0.address), wallet)
  await token0.methods.set_minter(l2Bridge.address, true).send({ from: admin })

  const registry = state.crossChain?.registryAddress
    ? state.crossChain.registryAddress
    : await readRegistry(state)

  log('initializing portal with registry=', registry, ' bridge=', l2Bridge.address.toString())
  const portal = getContract({
    abi: TokenPortalAbi,
    address: l1Portal,
    client: l1Client,
  })
  const initHash = await portal.write.initialize([
    registry as `0x${string}`,
    l1Token as `0x${string}`,
    l2Bridge.address.toString() as `0x${string}`,
  ])
  log('initialize tx', initHash)

  log('minting 1,000,000 TestERC20 to the deployer…')
  const erc20 = getContract({
    abi: parseAbi([
      'function mint(address to, uint256 amount) external',
      'function balanceOf(address) view returns (uint256)',
    ]),
    address: l1Token,
    client: l1Client,
  })
  const mintHash = await erc20.write.mint([l1Client.account.address, 1_000_000n])
  log('mint tx', mintHash)
  const bal = await erc20.read.balanceOf([l1Client.account.address])
  log('L1 deployer balance:', bal.toString())

  state.crossChain = {
    ...(state.crossChain ?? {}),
    l1Rpc: L1_RPC,
    l1Token,
    l1Portal,
    l1Deployer: l1Client.account.address,
    bridge0: l2Bridge.address.toString(),
    bridge0Instance: JSON.parse(
      jsonStringify((await wallet.getContractMetadata(l2Bridge.address)).instance!),
    ),
    placeholderPortal: undefined,
  }
  writeFileSync(stateFile, JSON.stringify(state, null, 2))
  log('updated', stateFile)

  await wallet.stop()
}

// Fallback: read registry address from the Aztec node info.
async function readRegistry(_state: Record<string, unknown>): Promise<string> {
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
    console.error('[deploy-l1-portal] FAILED:', err)
    process.exit(1)
  },
)
