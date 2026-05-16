/**
 * Wire the L2 (Aztec testnet) half of variant h.
 *
 *   1. Deploy two L2 TokenBridge contracts pointing at the L1 input/output
 *      portals from `npm run testnet:deploy-l1-portals`.
 *   2. Deploy L2 Uniswap pointing at the L1 UniswapPortalSepolia.
 *   3. Initialize the L1 input portal (registry + L1 ERC20 + L2 bridge).
 *   4. Initialize the L1 output portal (registry + L1 ERC20-B + L2 bridge-B).
 *   5. Initialize UniswapPortalSepolia (registry + L2 Uniswap addr + Sepolia
 *      V3 SwapRouter).
 *   6. Grant L2 BridgeB minter rights on AZB.
 *
 * Pre-reqs: `npm run testnet:setup` + `npm run testnet:deploy-l1-portals`.
 * Fees on L2 paid by SponsoredFPC; L1 init txs paid by SEPOLIA_PRIVATE_KEY.
 *
 *   TESTNET_SECRET=... TESTNET_SALT=... TESTNET_SIGNING=... \
 *   SEPOLIA_RPC=... SEPOLIA_PRIVATE_KEY=... \
 *     npm run testnet:wire-uniswap
 */
import { readFileSync, writeFileSync } from 'node:fs'
import { resolve, dirname } from 'node:path'
import { fileURLToPath } from 'node:url'

import { EmbeddedWallet } from '@aztec/wallets/embedded'
import { createAztecNodeClient } from '@aztec/aztec.js/node'
import { AztecAddress } from '@aztec/stdlib/aztec-address'
import { EthAddress } from '@aztec/aztec.js/addresses'
import { Fr, Fq } from '@aztec/aztec.js/fields'
import { TokenContract } from '@aztec/noir-contracts.js/Token'
import { TokenBridgeContract } from '@aztec/noir-contracts.js/TokenBridge'
import { UniswapContract } from '@aztec/noir-contracts.js/Uniswap'
import { SponsoredFPCContract } from '@aztec/noir-contracts.js/SponsoredFPC'
import { SponsoredFeePaymentMethod } from '@aztec/aztec.js/fee'
import { getContractInstanceFromInstantiationParams } from '@aztec/aztec.js/contracts'
import { SPONSORED_FPC_SALT } from '@aztec/constants'
import { jsonStringify, jsonParseWithSchema } from '@aztec/foundation/json-rpc'
import { ContractInstanceWithAddressSchema } from '@aztec/stdlib/contract'
import { TokenPortalAbi } from '@aztec/l1-artifacts/TokenPortalAbi'
import { sepolia } from 'viem/chains'
import { createPublicClient, getContract, http } from 'viem'
import { privateKeyToAccount } from 'viem/accounts'
import { createExtendedL1Client } from '@aztec/ethereum/client'

const TESTNET_URL = process.env.TESTNET_URL ?? 'https://rpc.testnet.aztec-labs.com'
const SEPOLIA_RPC = process.env.SEPOLIA_RPC
const SEPOLIA_PRIVATE_KEY = process.env.SEPOLIA_PRIVATE_KEY as `0x${string}` | undefined

const __dirname = dirname(fileURLToPath(import.meta.url))
const stateFile = resolve(__dirname, '..', 'public', 'testnet-state.json')
const uniPortalArtifactPath = resolve(
  __dirname,
  '..',
  'contracts-l1',
  'UniswapPortalSepolia',
  'out',
  'UniswapPortalSepolia.sol',
  'UniswapPortalSepolia.json',
)

function fr(name: string, hex: string | undefined): Fr {
  if (!hex) throw new Error(`missing env ${name}`)
  return Fr.fromString(hex.startsWith('0x') ? hex : `0x${hex}`)
}
function fq(name: string, hex: string | undefined): Fq {
  if (!hex) throw new Error(`missing env ${name}`)
  return Fq.fromString(hex.startsWith('0x') ? hex : `0x${hex}`)
}

function log(...args: unknown[]) {
  // eslint-disable-next-line no-console
  console.log('[testnet-wire-uniswap]', ...args)
}

async function getSponsoredFPCAddress() {
  const inst = await getContractInstanceFromInstantiationParams(SponsoredFPCContract.artifact, {
    salt: new Fr(SPONSORED_FPC_SALT),
  })
  return { address: inst.address, instance: inst }
}

async function main() {
  if (!SEPOLIA_RPC || !SEPOLIA_PRIVATE_KEY) {
    throw new Error('Set SEPOLIA_RPC and SEPOLIA_PRIVATE_KEY env vars.')
  }
  const state = JSON.parse(readFileSync(stateFile, 'utf8'))
  if (!state.crossChain?.l1UniswapPortal) {
    throw new Error('L1 portals not deployed. Run npm run testnet:deploy-l1-portals first.')
  }

  log('connecting to Aztec testnet', TESTNET_URL)
  const node = createAztecNodeClient(TESTNET_URL)
  const wallet = await EmbeddedWallet.create(node, {
    ephemeral: true,
    pxe: { proverEnabled: true },
  })

  const sponsoredFpc = await getSponsoredFPCAddress()
  await wallet.registerContract(sponsoredFpc.instance, SponsoredFPCContract.artifact)
  const paymentMethod = new SponsoredFeePaymentMethod(sponsoredFpc.address)
  const feeOpts = { paymentMethod }

  const secret = fr('TESTNET_SECRET', process.env.TESTNET_SECRET)
  const salt = fr('TESTNET_SALT', process.env.TESTNET_SALT)
  const signing = fq('TESTNET_SIGNING', process.env.TESTNET_SIGNING)
  await wallet.createSchnorrAccount(secret, salt, signing)
  // The same admin that ran testnet:setup must be deployer here, so the L2
  // bridges + Uniswap contract land under the same operator that minted AZA/AZB.
  const admin = AztecAddress.fromString(state.deployer)
  log('admin =', admin.toString())

  // Rehydrate the L2 token contracts (AZA + AZB).
  function deser(raw: unknown) {
    return jsonParseWithSchema(JSON.stringify(raw), ContractInstanceWithAddressSchema)
  }
  await wallet.registerContract(deser(state.token0.instance), TokenContract.artifact)
  await wallet.registerContract(deser(state.token1.instance), TokenContract.artifact)
  const tokenAzb = await TokenContract.at(AztecAddress.fromString(state.token1.address), wallet)

  // ---- 1 + 2: L2 TokenBridges + L2 Uniswap ----
  log('1. deploying L2 TokenBridge for AZA pointing at input portal…')
  const inputPortalEth = EthAddress.fromString(state.crossChain.l1Portal)
  const { contract: l2BridgeA } = await TokenBridgeContract.deploy(
    wallet,
    AztecAddress.fromString(state.token0.address),
    inputPortalEth,
  ).send({ from: admin, fee: feeOpts })
  log('   L2 BridgeA at', l2BridgeA.address.toString())

  log('2. deploying L2 TokenBridge for AZB pointing at output portal…')
  const outputPortalEth = EthAddress.fromString(state.crossChain.l1OutputPortal)
  const { contract: l2BridgeB } = await TokenBridgeContract.deploy(
    wallet,
    AztecAddress.fromString(state.token1.address),
    outputPortalEth,
  ).send({ from: admin, fee: feeOpts })
  log('   L2 BridgeB at', l2BridgeB.address.toString())

  log('3. deploying L2 Uniswap pointing at L1 UniswapPortalSepolia…')
  const uniPortalEth = EthAddress.fromString(state.crossChain.l1UniswapPortal)
  const { contract: l2Uniswap } = await UniswapContract.deploy(wallet, uniPortalEth).send({
    from: admin,
    fee: feeOpts,
  })
  log('   L2 Uniswap at', l2Uniswap.address.toString())

  log('4. granting L2 BridgeB minter rights on AZB…')
  await tokenAzb.methods.set_minter(l2BridgeB.address, true).send({ from: admin, fee: feeOpts })

  // ---- L1 init txs ----
  log('5. initializing L1 portals from Sepolia deployer…')
  const account = privateKeyToAccount(SEPOLIA_PRIVATE_KEY)
  void account
  const l1Client = createExtendedL1Client([SEPOLIA_RPC], SEPOLIA_PRIVATE_KEY, sepolia)
  // Public client for waiting on receipts — without this, back-to-back writes
  // share the same nonce and the mempool rejects the second as "replacement
  // transaction underpriced".
  const publicClient = createPublicClient({ transport: http(SEPOLIA_RPC), chain: sepolia })

  async function sendAndWait(label: string, txPromise: Promise<`0x${string}`>) {
    const tx = await txPromise
    log(`   ${label} tx`, tx)
    await publicClient.waitForTransactionReceipt({ hash: tx })
  }

  const inputPortalCtr = getContract({
    abi: TokenPortalAbi,
    address: state.crossChain.l1Portal as `0x${string}`,
    client: l1Client,
  })
  await sendAndWait(
    'input portal initialize',
    inputPortalCtr.write.initialize([
      state.crossChain.registryAddress as `0x${string}`,
      state.crossChain.l1Token as `0x${string}`,
      l2BridgeA.address.toString() as `0x${string}`,
    ]),
  )

  const outputPortalCtr = getContract({
    abi: TokenPortalAbi,
    address: state.crossChain.l1OutputPortal as `0x${string}`,
    client: l1Client,
  })
  await sendAndWait(
    'output portal initialize',
    outputPortalCtr.write.initialize([
      state.crossChain.registryAddress as `0x${string}`,
      state.crossChain.l1TokenB as `0x${string}`,
      l2BridgeB.address.toString() as `0x${string}`,
    ]),
  )

  const uniArtifact = JSON.parse(readFileSync(uniPortalArtifactPath, 'utf8'))
  const uniPortalCtr = getContract({
    abi: uniArtifact.abi,
    address: state.crossChain.l1UniswapPortal as `0x${string}`,
    client: l1Client,
  })
  await sendAndWait(
    'UniswapPortalSepolia initialize',
    uniPortalCtr.write.initialize([
      state.crossChain.registryAddress as `0x${string}`,
      l2Uniswap.address.toString() as `0x${string}`,
      state.crossChain.l1Router as `0x${string}`,
    ]),
  )

  // ---- Persist state ----
  async function instanceJSON(address: typeof admin) {
    const meta = await wallet.getContractMetadata(address)
    if (!meta.instance) throw new Error('instance missing for ' + address.toString())
    return JSON.parse(jsonStringify(meta.instance))
  }

  state.crossChain = {
    ...state.crossChain,
    bridge0: l2BridgeA.address.toString(),
    bridge0Instance: await instanceJSON(l2BridgeA.address),
    l2BridgeB: l2BridgeB.address.toString(),
    l2BridgeBInstance: await instanceJSON(l2BridgeB.address),
    l2Uniswap: l2Uniswap.address.toString(),
    l2UniswapInstance: await instanceJSON(l2Uniswap.address),
    portalsInitialized: true,
  }
  writeFileSync(stateFile, JSON.stringify(state, null, 2))
  log('done — testnet variant h fully wired.')

  await wallet.stop()
}

main().then(
  () => process.exit(0),
  (err) => {
    console.error('[testnet-wire-uniswap] FAILED:', err)
    process.exit(1)
  },
)
