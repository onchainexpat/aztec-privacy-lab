/**
 * End-to-end PRIVATE Aztec L2 -> Base L2 bridge (variant i).
 *
 * Privacy property: the L2 depositor's identity never appears in public state.
 * They call bridge_private which burns their private AZA notes via
 * transfer_to_public (the embedded wallet auto-injects the inner authwit).
 * Observers see "L2 BaseBridge contract transferred funds out" but cannot
 * tell which Aztec account funded the bridge.
 *
 * On the L1 side, the BaseBridgePortal consumes both L2->L1 messages (the
 * withdrawal from the AZA portal + the bridge intent) and forwards the
 * released ERC20 to MockBaseL1StandardBridge. The depositor <-> recipient
 * link is broken at this hop because only the portal contract is on the
 * receiving side of the withdrawal.
 *
 *   npm run sandbox:base-bridge-private
 */
import { readFileSync } from 'node:fs'
import { resolve, dirname } from 'node:path'
import { fileURLToPath } from 'node:url'

import { EmbeddedWallet } from '@aztec/wallets/embedded'
import { getInitialTestAccountsData } from '@aztec/accounts/testing/lazy'
import { createAztecNodeClient } from '@aztec/aztec.js/node'
import { AztecAddress } from '@aztec/stdlib/aztec-address'
import { EthAddress } from '@aztec/aztec.js/addresses'
import { Fr } from '@aztec/aztec.js/fields'
import { TokenContract } from '@aztec/noir-contracts.js/Token'
import { TokenBridgeContract } from '@aztec/noir-contracts.js/TokenBridge'
import { jsonParseWithSchema } from '@aztec/foundation/json-rpc'
import { ContractInstanceWithAddressSchema } from '@aztec/stdlib/contract'

import { BaseBridgeContract } from '../src/contracts/BaseBridge'

const SANDBOX_URL = process.env.SANDBOX_URL ?? 'http://localhost:8090'

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

const BRIDGE_AMOUNT = 500n
// Pretend Base L2 recipient. On real Base this is the address that ultimately
// receives the deposit ~3 minutes after the L1 bridgeERC20To call.
const BASE_RECIPIENT = '0x000000000000000000000000000000000000babe' as `0x${string}`
const BASE_MIN_GAS_LIMIT = 200_000

function log(...args: unknown[]) {
  // eslint-disable-next-line no-console
  console.log('[base-bridge-private]', ...args)
}

async function main() {
  const state = JSON.parse(readFileSync(stateFile, 'utf8'))
  if (!state.baseBridge?.l1Portal) {
    throw new Error('Base bridge stack not wired. Run npm run sandbox:base-bridge first.')
  }

  const portalArtifact = JSON.parse(readFileSync(portalArtifactPath, 'utf8'))

  log('connecting to L2', SANDBOX_URL)
  const node = createAztecNodeClient(SANDBOX_URL)
  const wallet = await EmbeddedWallet.create(node, { ephemeral: true })
  const [depositor] = await getInitialTestAccountsData()
  await wallet.createSchnorrAccount(depositor.secret, depositor.salt, depositor.signingKey)
  const depositorAddr = depositor.address
  log('depositor =', depositorAddr.toString())
  log('base recipient =', BASE_RECIPIENT)

  function deser(raw: unknown) {
    return jsonParseWithSchema(JSON.stringify(raw), ContractInstanceWithAddressSchema)
  }
  await wallet.registerContract(deser(state.token0.instance), TokenContract.artifact)
  await wallet.registerContract(deser(state.crossChain.bridge0Instance), TokenBridgeContract.artifact)
  await wallet.registerContract(deser(state.baseBridge.l2Instance), BaseBridgeContract.artifact)

  const tokenA = await TokenContract.at(AztecAddress.fromString(state.token0.address), wallet)
  const bridgeA = await TokenBridgeContract.at(
    AztecAddress.fromString(state.baseBridge.inputBridge),
    wallet,
  )
  const l2BaseBridge = await BaseBridgeContract.at(
    AztecAddress.fromString(state.baseBridge.l2Address),
    wallet,
  )

  const { result: privateBal } = await tokenA.methods
    .balance_of_private(depositorAddr)
    .simulate({ from: depositorAddr })
  log('depositor private AZA =', (privateBal as bigint).toString())
  if ((privateBal as bigint) < BRIDGE_AMOUNT) {
    throw new Error(
      `depositor has only ${(privateBal as bigint).toString()} private AZA; need ${BRIDGE_AMOUNT}.`,
    )
  }

  log('1. calling L2 BaseBridge.bridge_private…')
  const transferNonce = Fr.random()
  const sendResult = await l2BaseBridge.methods
    .bridge_private(
      tokenA.address,
      bridgeA.address,
      BRIDGE_AMOUNT,
      EthAddress.fromString(BASE_RECIPIENT),
      new Fr(BigInt(BASE_MIN_GAS_LIMIT)),
      transferNonce,
      EthAddress.ZERO,
    )
    .send({ from: depositorAddr })
  const txHash = (sendResult as unknown as { receipt: { txHash: { toString(): string } } }).receipt
    .txHash.toString()
  log('   bridge_private tx', txHash)

  // ---- Read the two L2->L1 messages ----
  const { TxHash } = await import('@aztec/stdlib/tx')
  const { computeL2ToL1MembershipWitness } = await import('@aztec/stdlib/messaging')
  const txhash = TxHash.fromString(txHash)
  let effect: Awaited<ReturnType<typeof node.getTxEffect>>
  for (let i = 0; i < 30; i++) {
    effect = await node.getTxEffect(txhash)
    if (effect?.data.l2ToL1Msgs.length === 2) break
    await new Promise((r) => setTimeout(r, 2000))
  }
  if (!effect || effect.data.l2ToL1Msgs.length !== 2) {
    throw new Error(`expected 2 L2->L1 msgs, got ${effect?.data.l2ToL1Msgs.length}`)
  }
  log('2. txEffect has', effect.data.l2ToL1Msgs.length, 'L2->L1 messages')

  log('3. computing membership witnesses for both messages…')
  const witnesses: { epochNumber: number; leafIndex: bigint; siblingPath: unknown }[] = []
  for (const msg of effect.data.l2ToL1Msgs) {
    let w: Awaited<ReturnType<typeof computeL2ToL1MembershipWitness>>
    for (let i = 0; i < 30; i++) {
      w = await computeL2ToL1MembershipWitness(node, msg, txhash)
      if (w) break
      await new Promise((r) => setTimeout(r, 3000))
    }
    if (!w) throw new Error(`no witness for message ${msg.toString()}`)
    witnesses.push({
      epochNumber: w.epochNumber,
      leafIndex: w.leafIndex,
      siblingPath: w.siblingPath,
    })
    log('   witness epoch', w.epochNumber, 'leaf', w.leafIndex.toString())
  }
  // bridge_private emits the BRIDGE message from the private context (index 0
  // in tx effects) and the WITHDRAW message from the enqueued public function
  // (index 1). The L1 portal expects metadata[0] = withdraw, metadata[1] = bridge.
  const [bridgeWitness, withdrawWitness] = witnesses
  const orderedWitnesses = [withdrawWitness, bridgeWitness]

  log('4. calling BaseBridgePortal.bridgeToBase on L1…')
  const { createExtendedL1Client } = await import('@aztec/ethereum/client')
  const { getContract } = await import('viem')
  const { foundry } = await import('viem/chains')
  const ANVIL_MNEMONIC = 'test test test test test test test test test test test junk'
  const l1Client = createExtendedL1Client(
    [process.env.L1_RPC ?? 'http://localhost:8545'],
    ANVIL_MNEMONIC,
    foundry,
  )
  const portal = getContract({
    abi: portalArtifact.abi,
    address: state.baseBridge.l1Portal as `0x${string}`,
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

  let bridgeTx: `0x${string}` | undefined
  for (let i = 0; i < 30; i++) {
    try {
      bridgeTx = (await portal.write.bridgeToBase([
        state.baseBridge.inputTokenPortal as `0x${string}`,
        BRIDGE_AMOUNT,
        BASE_RECIPIENT,
        BASE_MIN_GAS_LIMIT,
        false,
        [metadataArr[0], metadataArr[1]],
      ])) as `0x${string}`
      break
    } catch (e) {
      const msg = e instanceof Error
        ? `${e.message}\n${(e as { cause?: { data?: string } }).cause?.data ?? ''}`
        : String(e)
      if (msg.includes('5e3d32ce') || msg.toLowerCase().includes('reverted')) {
        log(`   attempt ${i}: outbox not ready, sleeping 12s…`)
        await new Promise((r) => setTimeout(r, 12_000))
      } else {
        throw e
      }
    }
  }
  if (!bridgeTx) throw new Error('bridgeToBase still reverts after retries')
  log('   L1 bridgeToBase tx', bridgeTx)

  // ---- Decode the Base bridge event so the demo prints the recipient ----
  const { decodeEventLog, parseAbi } = await import('viem')
  const receipt = await l1Client.waitForTransactionReceipt({ hash: bridgeTx })
  const baseBridgeAddr = (state.baseBridge.mockBaseStandardBridge as string).toLowerCase()
  const baseLog = receipt.logs.find((l) => l.address.toLowerCase() === baseBridgeAddr)
  if (baseLog) {
    const decoded = decodeEventLog({
      abi: parseAbi([
        'event ERC20BridgeInitiated(address indexed l1Token, address indexed l2Token, address indexed from, address to, uint256 amount, bytes extraData)',
      ]),
      data: baseLog.data,
      topics: baseLog.topics,
    })
    const args = decoded.args as unknown as {
      l1Token: string
      from: string
      to: string
      amount: bigint
    }
    log('5. MockBaseL1StandardBridge.ERC20BridgeInitiated:')
    log('     l1Token =', args.l1Token)
    log('     from    =', args.from, '(the portal — depositor L2 identity NOT here)')
    log('     to      =', args.to, '(public Base recipient)')
    log('     amount  =', args.amount.toString())
  }

  log('done — privacy properties:')
  log('  - L2 depositor', depositorAddr.toString(), 'is in the private kernel, not in any L1 log.')
  log('  - Only entity touching both sides is BaseBridgePortal at', state.baseBridge.l1Portal)
  log('  - Anonymity set: other Aztec accounts that bridge through this portal.')

  await wallet.stop()
}

main().then(
  () => process.exit(0),
  (err) => {
    console.error('[base-bridge-private] FAILED:', err)
    process.exit(1)
  },
)
