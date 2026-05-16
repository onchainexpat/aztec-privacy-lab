/**
 * End-to-end PRIVATE Uniswap-from-L2 swap on Aztec testnet -> Sepolia -> back.
 *
 * Same flow as scripts/run-uniswap-swap-private.ts but talks to:
 *   - Aztec testnet L2 (https://rpc.testnet.aztec-labs.com), fees via SponsoredFPC
 *   - Sepolia L1 (env SEPOLIA_RPC), fees from env SEPOLIA_PRIVATE_KEY
 *
 * Pre-reqs:
 *   - `npm run testnet:setup` (deploys AZA + AZB + admin account)
 *   - `npm run testnet:deploy-l1-portals` (deploys L1 portals on Sepolia)
 *   - `npm run testnet:wire-uniswap` (deploys L2 bridges + Uniswap, initialises L1 portals)
 *   - Admin has at least 500 private AZA
 *
 *   TESTNET_SECRET=... TESTNET_SALT=... TESTNET_SIGNING=... \
 *   SEPOLIA_RPC=... SEPOLIA_PRIVATE_KEY=... \
 *     npm run testnet:swap-l1-private
 *
 * Quirks of testnet vs. sandbox:
 *   - SponsoredFPC paymaster needed for every L2 send.
 *   - L2 outbox cadence is ~1 min; longer retries on the L1 swapPrivate call.
 *   - The output claim secret is held by THIS script; the demo claims to the
 *     same account (the testnet has only one funded admin). Privacy of the
 *     depositor->recipient link is preserved as long as the secret stays off
 *     public state, even when both are the same address.
 */
import { readFileSync } from 'node:fs'
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
import { jsonParseWithSchema } from '@aztec/foundation/json-rpc'
import { ContractInstanceWithAddressSchema } from '@aztec/stdlib/contract'
import { computeSecretHash } from '@aztec/stdlib/hash'
import { sepolia } from 'viem/chains'
import { createPublicClient, decodeEventLog, getContract, http } from 'viem'
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
  console.log('[testnet-swap-private]', ...args)
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
  if (!state.crossChain?.portalsInitialized) {
    throw new Error('Testnet portals not wired. Run npm run testnet:wire-uniswap first.')
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
  const depositorAddr = AztecAddress.fromString(state.deployer)
  // Testnet has only one funded admin in our setup. The privacy property still
  // holds: the depositor->recipient link is sealed by the claim secret, even
  // though both addresses happen to be the same here.
  const recipientAddr = depositorAddr
  log('depositor =', depositorAddr.toString())
  log('recipient =', recipientAddr.toString(), '(same admin; privacy via claim secret)')

  function deser(raw: unknown) {
    return jsonParseWithSchema(JSON.stringify(raw), ContractInstanceWithAddressSchema)
  }
  await wallet.registerContract(deser(state.token0.instance), TokenContract.artifact)
  await wallet.registerContract(deser(state.token1.instance), TokenContract.artifact)
  await wallet.registerContract(deser(state.crossChain.bridge0Instance), TokenBridgeContract.artifact)
  await wallet.registerContract(deser(state.crossChain.l2BridgeBInstance), TokenBridgeContract.artifact)
  await wallet.registerContract(deser(state.crossChain.l2UniswapInstance), UniswapContract.artifact)

  const tokenA = await TokenContract.at(AztecAddress.fromString(state.token0.address), wallet)
  const bridgeA = await TokenBridgeContract.at(
    AztecAddress.fromString(state.crossChain.bridge0),
    wallet,
  )
  const bridgeB = await TokenBridgeContract.at(
    AztecAddress.fromString(state.crossChain.l2BridgeB),
    wallet,
  )
  const l2Uniswap = await UniswapContract.at(
    AztecAddress.fromString(state.crossChain.l2Uniswap),
    wallet,
  )

  const SWAP_IN = 500n
  const { result: privateBal } = await tokenA.methods
    .balance_of_private(depositorAddr)
    .simulate({ from: depositorAddr })
  log('depositor private AZA =', (privateBal as bigint).toString())
  if ((privateBal as bigint) < SWAP_IN) {
    throw new Error(
      `depositor has only ${(privateBal as bigint).toString()} private AZA; need ${SWAP_IN}.`,
    )
  }

  const transferNonce = Fr.random()
  const claimSecret = Fr.random()
  const claimSecretHash = await computeSecretHash(claimSecret)

  log('1. calling L2 Uniswap.swap_private on testnet…')
  const UNISWAP_FEE_TIER = new Fr(3000n)
  const sendResult = await l2Uniswap.methods
    .swap_private(
      tokenA.address,
      bridgeA.address,
      SWAP_IN,
      bridgeB.address,
      transferNonce,
      UNISWAP_FEE_TIER,
      1n,
      claimSecretHash,
      EthAddress.ZERO,
    )
    .send({ from: depositorAddr, fee: feeOpts })
  const txHash = (sendResult as unknown as { receipt: { txHash: { toString(): string } } }).receipt
    .txHash.toString()
  log('   L2 swap_private tx', txHash)
  log('   claim_secret =', claimSecret.toString())

  // ---- Read the two L2->L1 messages emitted by swap_private ----
  const { TxHash } = await import('@aztec/stdlib/tx')
  const { computeL2ToL1MembershipWitness } = await import('@aztec/stdlib/messaging')
  const txhash = TxHash.fromString(txHash)
  let effect: Awaited<ReturnType<typeof node.getTxEffect>>
  for (let i = 0; i < 60; i++) {
    effect = await node.getTxEffect(txhash)
    if (effect?.data.l2ToL1Msgs.length === 2) break
    await new Promise((r) => setTimeout(r, 3000))
  }
  if (!effect || effect.data.l2ToL1Msgs.length !== 2) {
    throw new Error(`expected 2 L2->L1 msgs, got ${effect?.data.l2ToL1Msgs.length}`)
  }
  log('2. txEffect has', effect.data.l2ToL1Msgs.length, 'L2->L1 messages')

  log('3. computing membership witnesses (testnet cadence ~1 min/leaf)…')
  const witnesses: { epochNumber: number; leafIndex: bigint; siblingPath: unknown }[] = []
  for (const msg of effect.data.l2ToL1Msgs) {
    let w: Awaited<ReturnType<typeof computeL2ToL1MembershipWitness>>
    for (let i = 0; i < 60; i++) {
      w = await computeL2ToL1MembershipWitness(node, msg, txhash)
      if (w) break
      await new Promise((r) => setTimeout(r, 5000))
    }
    if (!w) throw new Error(`no witness for message ${msg.toString()}`)
    witnesses.push({
      epochNumber: w.epochNumber,
      leafIndex: w.leafIndex,
      siblingPath: w.siblingPath,
    })
    log('   witness epoch', w.epochNumber, 'leaf', w.leafIndex.toString())
  }
  // L2 emits [SWAP from private, WITHDRAW from enqueued public]; L1 portal
  // expects [WITHDRAW, SWAP]. Swap to match.
  const [swapWitness, withdrawWitness] = witnesses
  const orderedWitnesses = [withdrawWitness, swapWitness]

  log('4. calling UniswapPortalSepolia.swapPrivate on Sepolia…')
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
  for (let i = 0; i < 60; i++) {
    try {
      swapTx = (await portal.write.swapPrivate(swapArgs)) as `0x${string}`
      break
    } catch (e) {
      const msg = e instanceof Error
        ? `${e.message}\n${(e as { cause?: { data?: string } }).cause?.data ?? ''}`
        : String(e)
      if (msg.includes('5e3d32ce') || msg.toLowerCase().includes('reverted')) {
        log(`   attempt ${i}: outbox not ready, sleeping 30s…`)
        await new Promise((r) => setTimeout(r, 30_000))
      } else {
        throw e
      }
    }
  }
  if (!swapTx) throw new Error('swapPrivate still reverts after retries')
  log('   L1 swapPrivate tx', swapTx)

  log('5. waiting for L1 mint message to land on L2 inbox…')
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

  log('6. claiming AZB output privately on L2 (separate from depositor on-chain footprint)…')
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
  for (let i = 0; i < 60; i++) {
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
        log(`   attempt ${i}: L2 inbox doesn't have message yet, sleeping 10s…`)
        await new Promise((r) => setTimeout(r, 10_000))
      } else {
        throw e
      }
    }
  }
  log('done — full E2E private swap on Aztec testnet completed.')

  await wallet.stop()
}

main().then(
  () => process.exit(0),
  (err) => {
    console.error('[testnet-swap-private] FAILED:', err)
    process.exit(1)
  },
)
