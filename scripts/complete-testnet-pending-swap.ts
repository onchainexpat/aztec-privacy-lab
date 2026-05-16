/**
 * Continuation script — when a previous `testnet:swap-l1-private` run completed
 * the L2 swap_private (burning 500 AZA) but the L1 portal call kept reverting
 * because the outbox root for that epoch hadn't propagated to Sepolia yet,
 * this script picks up where that one left off without burning more AZA.
 *
 * Inputs come from env:
 *   - L2_TX_HASH      = tx hash from the previous swap_private call
 *   - CLAIM_SECRET    = secret that bound the L1->L2 mint to a claim
 *   - SEPOLIA_RPC, SEPOLIA_PRIVATE_KEY (same as before)
 *   - TESTNET_SECRET / SALT / SIGNING (same as before)
 *
 *   L2_TX_HASH=0x... CLAIM_SECRET=0x... \
 *   SEPOLIA_RPC=... SEPOLIA_PRIVATE_KEY=... \
 *   TESTNET_SECRET=... TESTNET_SALT=... TESTNET_SIGNING=... \
 *     npm run testnet:complete-pending-swap
 *
 * Retries the L1 portal call for ~2 hours (240 × 30s). Aztec testnet epoch
 * finalization to L1 is typically 40-90 minutes.
 */
import { readFileSync } from 'node:fs'
import { resolve, dirname } from 'node:path'
import { fileURLToPath } from 'node:url'

import { EmbeddedWallet } from '@aztec/wallets/embedded'
import { createAztecNodeClient } from '@aztec/aztec.js/node'
import { AztecAddress } from '@aztec/stdlib/aztec-address'
import { Fr, Fq } from '@aztec/aztec.js/fields'
import { TokenContract } from '@aztec/noir-contracts.js/Token'
import { TokenBridgeContract } from '@aztec/noir-contracts.js/TokenBridge'
import { UniswapContract } from '@aztec/noir-contracts.js/Uniswap'
import { SponsoredFPCContract } from '@aztec/noir-contracts.js/SponsoredFPC'
import { SponsoredFeePaymentMethod } from '@aztec/aztec.js/fee'
import { getContractInstanceFromInstantiationParams } from '@aztec/aztec.js/contracts'
import { SPONSORED_FPC_SALT } from '@aztec/constants'
import { jsonParseWithSchema } from '@aztec/foundation/json-rpc'
import { ContractInstanceWithAddressSchema } from '@aztec/stdlib/contract'
import { computeSecretHash } from '@aztec/stdlib/hash'
import { sepolia } from 'viem/chains'
import { createPublicClient, decodeEventLog, getContract, http } from 'viem'
import { createExtendedL1Client } from '@aztec/ethereum/client'

const TESTNET_URL = process.env.TESTNET_URL ?? 'https://rpc.testnet.aztec-labs.com'
const SEPOLIA_RPC = process.env.SEPOLIA_RPC
const SEPOLIA_PRIVATE_KEY = process.env.SEPOLIA_PRIVATE_KEY as `0x${string}` | undefined
const L2_TX_HASH = process.env.L2_TX_HASH
const CLAIM_SECRET = process.env.CLAIM_SECRET

const SWAP_IN = 500n

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
  console.log('[complete-pending]', ...args)
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
  if (!L2_TX_HASH || !CLAIM_SECRET) {
    throw new Error('Set L2_TX_HASH and CLAIM_SECRET env vars (from the prior swap_private run).')
  }
  const state = JSON.parse(readFileSync(stateFile, 'utf8'))

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
  const depositorAddr = AztecAddress.fromString(state.deployer)
  const recipientAddr = depositorAddr

  function deser(raw: unknown) {
    return jsonParseWithSchema(JSON.stringify(raw), ContractInstanceWithAddressSchema)
  }
  await wallet.registerContract(deser(state.token0.instance), TokenContract.artifact)
  await wallet.registerContract(deser(state.token1.instance), TokenContract.artifact)
  await wallet.registerContract(deser(state.crossChain.bridge0Instance), TokenBridgeContract.artifact)
  await wallet.registerContract(deser(state.crossChain.l2BridgeBInstance), TokenBridgeContract.artifact)
  await wallet.registerContract(deser(state.crossChain.l2UniswapInstance), UniswapContract.artifact)

  const bridgeB = await TokenBridgeContract.at(
    AztecAddress.fromString(state.crossChain.l2BridgeB),
    wallet,
  )

  const claimSecret = fr('CLAIM_SECRET', CLAIM_SECRET)
  const claimSecretHash = await computeSecretHash(claimSecret)
  log('depositor =', depositorAddr.toString())
  log('claim_secret_hash =', claimSecretHash.toString())

  log('1. loading prior L2 tx effect…')
  const { TxHash } = await import('@aztec/stdlib/tx')
  const { computeL2ToL1MembershipWitness } = await import('@aztec/stdlib/messaging')
  const txhash = TxHash.fromString(L2_TX_HASH)
  const effect = await node.getTxEffect(txhash)
  if (!effect || effect.data.l2ToL1Msgs.length !== 2) {
    throw new Error(`prior L2 tx ${L2_TX_HASH} has unexpected message count`)
  }
  log('   prior tx has', effect.data.l2ToL1Msgs.length, 'L2->L1 messages')

  log('2. computing witnesses (this needs the outbox root to be on L1)…')
  const witnesses: { epochNumber: number; leafIndex: bigint; siblingPath: unknown }[] = []
  for (const msg of effect.data.l2ToL1Msgs) {
    let w: Awaited<ReturnType<typeof computeL2ToL1MembershipWitness>>
    for (let i = 0; i < 120; i++) {
      w = await computeL2ToL1MembershipWitness(node, msg, txhash)
      if (w) break
      await new Promise((r) => setTimeout(r, 10_000))
    }
    if (!w) throw new Error(`no witness for message ${msg.toString()}`)
    witnesses.push({
      epochNumber: w.epochNumber,
      leafIndex: w.leafIndex,
      siblingPath: w.siblingPath,
    })
    log('   witness epoch', w.epochNumber, 'leaf', w.leafIndex.toString())
  }
  const [swapWitness, withdrawWitness] = witnesses
  const orderedWitnesses = [withdrawWitness, swapWitness]

  log('3. retrying UniswapPortalSepolia.swapPrivate on Sepolia (up to ~2hr)…')
  const l1Client = createExtendedL1Client([SEPOLIA_RPC], SEPOLIA_PRIVATE_KEY, sepolia)
  const publicClient = createPublicClient({ transport: http(SEPOLIA_RPC), chain: sepolia })
  const uniArtifact = JSON.parse(readFileSync(uniPortalArtifactPath, 'utf8'))
  const portal = getContract({
    abi: uniArtifact.abi,
    address: state.crossChain.l1UniswapPortal as `0x${string}`,
    client: l1Client,
  })
  const metadataArr = orderedWitnesses.map((w) => {
    type SibPath = { toBufferArray: () => Buffer[] }
    const sp = (w.siblingPath as unknown as SibPath).toBufferArray()
    return {
      _epoch: BigInt(w.epochNumber),
      _leafIndex: w.leafIndex,
      _path: sp.map((b) => `0x${b.toString('hex')}` as `0x${string}`),
    }
  })
  const swapArgs = [
    state.crossChain.l1Portal as `0x${string}`,
    SWAP_IN,
    3000,
    state.crossChain.l1OutputPortal as `0x${string}`,
    1n,
    claimSecretHash.toString() as `0x${string}`,
    false,
    [metadataArr[0], metadataArr[1]],
  ] as const

  let swapTx: `0x${string}` | undefined
  for (let i = 0; i < 240; i++) {
    try {
      swapTx = (await portal.write.swapPrivate(swapArgs)) as `0x${string}`
      break
    } catch (e) {
      const msg = e instanceof Error
        ? `${e.message}\n${(e as { cause?: { data?: string } }).cause?.data ?? ''}`
        : String(e)
      if (msg.toLowerCase().includes('reverted') || msg.includes('5e3d32ce')) {
        if (i % 6 === 0) log(`   attempt ${i}: still reverting (likely outbox root not on L1 yet)`)
        await new Promise((r) => setTimeout(r, 30_000))
      } else {
        throw e
      }
    }
  }
  if (!swapTx) throw new Error('swapPrivate kept reverting for 2 hours — outbox propagation may be stalled')
  log('   L1 swapPrivate tx', swapTx)

  log('4. waiting for L1->L2 mint message and claiming AZB…')
  const { InboxAbi } = await import('@aztec/l1-artifacts/InboxAbi')
  const receipt = await publicClient.waitForTransactionReceipt({ hash: swapTx })
  const inboxAddr = (await node.getNodeInfo()).l1ContractAddresses.inboxAddress
    .toString()
    .toLowerCase()
  const inboxLog = receipt.logs.find((l) => l.address.toLowerCase() === inboxAddr)
  if (!inboxLog) throw new Error('no inbox log in L1 swap receipt')
  const decoded = decodeEventLog({ abi: InboxAbi, data: inboxLog.data, topics: inboxLog.topics })
  const mintLeafIndex = (decoded.args as unknown as { index: bigint }).index
  log('   L1->L2 message leaf index', mintLeafIndex.toString())

  const bridgeBTyped = bridgeB as unknown as {
    methods: {
      claim_private: (
        recipient: AztecAddress,
        amount: bigint,
        secret: Fr,
        leafIdx: Fr,
      ) => { send: (opts: { from: AztecAddress; fee?: unknown }) => Promise<unknown> }
    }
  }
  for (let i = 0; i < 120; i++) {
    try {
      await bridgeBTyped.methods
        .claim_private(recipientAddr, SWAP_IN, claimSecret, new Fr(mintLeafIndex))
        .send({ from: depositorAddr, fee: feeOpts })
      break
    } catch (e) {
      const msg = e instanceof Error ? e.message : String(e)
      if (
        msg.includes('nonexistent L1-to-L2 message') ||
        msg.includes('No L1 to L2 message found')
      ) {
        if (i % 6 === 0) log(`   attempt ${i}: L2 inbox doesn't have message yet`)
        await new Promise((r) => setTimeout(r, 10_000))
      } else {
        throw e
      }
    }
  }
  log('done — pending swap completed; AZB minted to recipient.')

  await wallet.stop()
}

main().then(
  () => process.exit(0),
  (err) => {
    console.error('[complete-pending] FAILED:', err)
    process.exit(1)
  },
)
