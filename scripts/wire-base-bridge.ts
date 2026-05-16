/**
 * Wire the Aztec L2 -> Base L2 bridge stack (privacy matrix variant i):
 *
 *   1. Deploy MockBaseL1StandardBridge on the local L1 anvil.
 *   2. Deploy BaseBridgePortal on the local L1 anvil.
 *   3. Redeploy L2 BaseBridge with the real portal address.
 *   4. Initialize the L1 portal with registry + L2 bridge addr + Base bridge addr.
 *
 * Pre-reqs: `npm run sandbox:setup` + `sandbox:seed` + `sandbox:l1-portal`.
 *
 *   npm run sandbox:base-bridge
 */
import { readFileSync, writeFileSync } from 'node:fs'
import { resolve, dirname } from 'node:path'
import { fileURLToPath } from 'node:url'

import { EmbeddedWallet } from '@aztec/wallets/embedded'
import { getInitialTestAccountsData } from '@aztec/accounts/testing/lazy'
import { createAztecNodeClient } from '@aztec/aztec.js/node'
import { jsonStringify } from '@aztec/foundation/json-rpc'
import { createExtendedL1Client } from '@aztec/ethereum/client'
import { deployL1Contract } from '@aztec/ethereum/deploy-l1-contract'
import { foundry } from 'viem/chains'
import { getContract } from 'viem'

import { BaseBridgeContract } from '../src/contracts/BaseBridge'

const SANDBOX_URL = process.env.SANDBOX_URL ?? 'http://localhost:8090'
const L1_RPC = process.env.L1_RPC ?? 'http://localhost:8545'
const ANVIL_MNEMONIC = 'test test test test test test test test test test test junk'

const __dirname = dirname(fileURLToPath(import.meta.url))
const stateFile = resolve(__dirname, '..', 'public', 'sandbox-state.json')
const portalArtifactPath = resolve(
  __dirname,
  '..',
  'contracts-l1',
  'BaseBridge',
  'out',
  'BaseBridgePortal.sol',
  'BaseBridgePortal.json',
)
const mockBridgeArtifactPath = resolve(
  __dirname,
  '..',
  'contracts-l1',
  'BaseBridge',
  'out',
  'MockBaseL1StandardBridge.sol',
  'MockBaseL1StandardBridge.json',
)

function log(...args: unknown[]) {
  // eslint-disable-next-line no-console
  console.log('[wire-base-bridge]', ...args)
}

async function main() {
  const state = JSON.parse(readFileSync(stateFile, 'utf8'))
  if (!state.crossChain?.l1Portal) {
    throw new Error('L1 token portal not deployed yet. Run npm run sandbox:l1-portal first.')
  }

  log('loading Solidity artifacts…')
  const portalArtifact = JSON.parse(readFileSync(portalArtifactPath, 'utf8'))
  const mockArtifact = JSON.parse(readFileSync(mockBridgeArtifactPath, 'utf8'))

  log('connecting to L1', L1_RPC)
  const l1Client = createExtendedL1Client([L1_RPC], ANVIL_MNEMONIC, foundry)

  log('connecting to L2', SANDBOX_URL)
  const node = createAztecNodeClient(SANDBOX_URL)
  const wallet = await EmbeddedWallet.create(node, { ephemeral: true })
  const [testAccount] = await getInitialTestAccountsData()
  await wallet.createSchnorrAccount(testAccount.secret, testAccount.salt, testAccount.signingKey)
  const admin = testAccount.address

  // ---- L1 deployments ----
  log('1. deploying MockBaseL1StandardBridge…')
  const mockBridgeDeploy = await deployL1Contract(
    l1Client,
    mockArtifact.abi,
    mockArtifact.bytecode.object as `0x${string}`,
    [],
  )
  const mockBridgeAddr = mockBridgeDeploy.address.toString()
  log('   MockBaseL1StandardBridge at', mockBridgeAddr)

  log('2. deploying BaseBridgePortal…')
  const portalDeploy = await deployL1Contract(
    l1Client,
    portalArtifact.abi,
    portalArtifact.bytecode.object as `0x${string}`,
    [],
  )
  const portalAddr = portalDeploy.address.toString()
  log('   BaseBridgePortal at', portalAddr)

  // ---- L2 redeploy with real portal address ----
  log('3. redeploying L2 BaseBridge with real portal address…')
  const { contract: l2BaseBridge } = await BaseBridgeContract.deploy(
    wallet,
    portalDeploy.address,
  ).send({ from: admin })
  log('   L2 BaseBridge at', l2BaseBridge.address.toString())

  // ---- L1 portal init ----
  const registry = await readRegistry()
  log('4. initialising BaseBridgePortal (registry, l2BaseBridge, mockBridge)…')
  const portal = getContract({
    abi: portalArtifact.abi,
    address: portalAddr as `0x${string}`,
    client: l1Client,
  })
  await portal.write.initialize([
    registry as `0x${string}`,
    l2BaseBridge.address.toString() as `0x${string}`,
    mockBridgeAddr as `0x${string}`,
  ])

  // ---- Persist state ----
  state.baseBridge = {
    l2Address: l2BaseBridge.address.toString(),
    l2Instance: JSON.parse(
      jsonStringify((await wallet.getContractMetadata(l2BaseBridge.address)).instance!),
    ),
    l1Portal: portalAddr,
    mockBaseStandardBridge: mockBridgeAddr,
    // The L2 input asset routes through the existing AZA bridge wired by
    // npm run sandbox:l1-portal.
    inputToken: 'AZA',
    inputBridge: state.crossChain.bridge0,
    inputTokenPortal: state.crossChain.l1Portal,
  }
  writeFileSync(stateFile, JSON.stringify(state, null, 2))
  log('done — L2 BaseBridge + L1 portal + Mock Base bridge all wired.')

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
    console.error('[wire-base-bridge] FAILED:', err)
    process.exit(1)
  },
)
