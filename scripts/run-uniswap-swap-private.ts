/**
 * End-to-end PRIVATE Uniswap-from-L2 swap (mirror of run-uniswap-swap.ts).
 *
 * Privacy difference vs. swap_public:
 *   - Input side: the depositor's L2 address never appears in public state.
 *     swap_private burns private notes via transfer_to_public (the embedded
 *     wallet auto-injects the inner authwit for that call) — observers see
 *     the L2 Uniswap contract's public balance increase, but cannot tell who
 *     funded it.
 *   - Output side: the claim is consumed by claim_private with a recipient
 *     chosen at claim time. The recipient address is in the call args but
 *     is *not bound* to the depositor — anyone who knows the claim secret
 *     could have claimed. So observers see "address X received N AZB" but
 *     cannot link X back to the original depositor.
 *
 * The L1 leg is identical to the public version except for calling swapPrivate
 * instead of swapPublic (no recipient arg — the secret is the only handle).
 *
 *   npm run sandbox:swap-l1-private
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
import { UniswapContract } from '@aztec/noir-contracts.js/Uniswap'
import { jsonParseWithSchema } from '@aztec/foundation/json-rpc'
import { ContractInstanceWithAddressSchema } from '@aztec/stdlib/contract'
import { computeSecretHash } from '@aztec/stdlib/hash'

const SANDBOX_URL = process.env.SANDBOX_URL ?? 'http://localhost:8090'

const __dirname = dirname(fileURLToPath(import.meta.url))
const stateFile = resolve(__dirname, '..', 'public', 'sandbox-state.json')

function log(...args: unknown[]) {
  // eslint-disable-next-line no-console
  console.log('[swap-l1-private]', ...args)
}

async function main() {
  const state = JSON.parse(readFileSync(stateFile, 'utf8'))
  if (!state.crossChain?.l1UniswapPortal || !state.crossChain?.l2BridgeB) {
    throw new Error('Uniswap stack not wired yet. Run npm run sandbox:uniswap first.')
  }

  log('connecting to L2', SANDBOX_URL)
  const node = createAztecNodeClient(SANDBOX_URL)
  const wallet = await EmbeddedWallet.create(node, { ephemeral: true })
  const accounts = await getInitialTestAccountsData()
  const depositor = accounts[0]
  const recipient = accounts[1] ?? accounts[0]
  await wallet.createSchnorrAccount(depositor.secret, depositor.salt, depositor.signingKey)
  const depositorAddr = depositor.address
  // Recipient is a *second* account so the privacy property is visually obvious:
  // depositor never receives the output; an unrelated address does.
  const recipientAddr = recipient.address
  log('depositor =', depositorAddr.toString())
  log('recipient =', recipientAddr.toString())

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

  // Make sure the depositor has enough *private* AZA. The seed script mints
  // some private balance during sandbox setup; top up if needed.
  const SWAP_IN = 500n
  const { result: privateBal } = await tokenA.methods
    .balance_of_private(depositorAddr)
    .simulate({ from: depositorAddr })
  log('depositor private AZA =', (privateBal as bigint).toString())
  if ((privateBal as bigint) < SWAP_IN) {
    throw new Error(
      `depositor has only ${(privateBal as bigint).toString()} private AZA; need ${SWAP_IN}. ` +
        `Re-seed with npm run sandbox:seed.`,
    )
  }

  const transferNonce = Fr.random()
  const claimSecret = Fr.random()
  const claimSecretHash = await computeSecretHash(claimSecret)

  log('1. calling L2 Uniswap.swap_private…')
  log('   (the embedded wallet auto-injects the private authwit for transfer_to_public)')
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
    .send({ from: depositorAddr })
  const txHash = (sendResult as unknown as { receipt: { txHash: { toString(): string } } }).receipt
    .txHash.toString()
  log('   L2 swap_private tx', txHash)
  log('   claim_secret =', claimSecret.toString())
  log('   claim_secret_hash =', claimSecretHash.toString())

  // Read the two L2→L1 messages this tx emitted.
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
    throw new Error(`expected 2 L2→L1 msgs in tx effect, got ${effect?.data.l2ToL1Msgs.length}`)
  }
  log('2. txEffect has', effect.data.l2ToL1Msgs.length, 'L2→L1 messages')

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
  // swap_private emits the SWAP msg from the private context and the WITHDRAW
  // msg from an enqueued public function. In tx effects, the private-phase
  // msg lands at index 0 and the public-phase msg at index 1. The L1
  // UniswapPortal.swapPrivate expects the inverse: metadata[0] = withdraw,
  // metadata[1] = swap. Swap them so the L1 contract picks up the right leaf
  // for each consume call.
  const [swapWitness, withdrawWitness] = witnesses
  const orderedWitnesses = [withdrawWitness, swapWitness]

  log('4. calling UniswapPortal.swapPrivate on L1…')
  const { createExtendedL1Client } = await import('@aztec/ethereum/client')
  const { UniswapPortalAbi } = await import('@aztec/l1-artifacts/UniswapPortalAbi')
  const { getContract } = await import('viem')
  const { foundry } = await import('viem/chains')
  const ANVIL_MNEMONIC = 'test test test test test test test test test test test junk'
  const l1Client = createExtendedL1Client(
    [process.env.L1_RPC ?? 'http://localhost:8545'],
    ANVIL_MNEMONIC,
    foundry,
  )
  const portal = getContract({
    abi: UniswapPortalAbi,
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
  for (let i = 0; i < 30; i++) {
    try {
      swapTx = await portal.write.swapPrivate(swapArgs)
      break
    } catch (e) {
      const msg = e instanceof Error ? `${e.message}\n${(e as { cause?: { data?: string } }).cause?.data ?? ''}` : String(e)
      if (msg.includes('5e3d32ce') || msg.toLowerCase().includes('reverted')) {
        log(`   attempt ${i}: outbox not ready (msg target epoch ${witnesses[0].epochNumber}); sleeping 12s…`)
        await new Promise((r) => setTimeout(r, 12_000))
      } else {
        throw e
      }
    }
  }
  if (!swapTx) throw new Error('swapPrivate still reverts after retries — outbox cadence too slow')
  log('   L1 swapPrivate tx', swapTx)

  log('5. waiting for output-mint message to land on L2 inbox…')
  const { decodeEventLog } = await import('viem')
  const { InboxAbi } = await import('@aztec/l1-artifacts/InboxAbi')
  const receipt = await l1Client.waitForTransactionReceipt({ hash: swapTx })
  const inboxAddr = (await node.getNodeInfo()).l1ContractAddresses.inboxAddress.toString().toLowerCase()
  const inboxLog = receipt.logs.find((l) => l.address.toLowerCase() === inboxAddr)
  if (!inboxLog) throw new Error('no inbox log in L1 swap receipt')
  const decoded = decodeEventLog({ abi: InboxAbi, data: inboxLog.data, topics: inboxLog.topics })
  const mintLeafIndex = (decoded.args as unknown as { index: bigint }).index
  log('   output-mint L1→L2 message at leaf index', mintLeafIndex.toString())

  log('6. claiming output AZB on L2 (claim_private to recipient, NOT depositor)…')
  // Privacy boundary: the original depositor's L2 identity never touched the
  // output side. claim_private here mints private AZB notes to `recipientAddr`,
  // an account observers cannot link back to the deposit.
  const bridgeBTyped = bridgeB as unknown as {
    methods: {
      claim_private: (
        recipient: AztecAddress,
        amount: bigint,
        secret: Fr,
        leafIdx: Fr,
      ) => { send: (opts: { from: AztecAddress }) => Promise<unknown> }
    }
  }
  for (let i = 0; i < 30; i++) {
    try {
      await bridgeBTyped.methods
        .claim_private(recipientAddr, SWAP_IN, claimSecret, new Fr(mintLeafIndex))
        .send({ from: depositorAddr })
      break
    } catch (e) {
      const msg = e instanceof Error ? e.message : String(e)
      // Public path errors with "nonexistent L1-to-L2 message" but the private
      // path's process_l1_to_l2_message uses "No L1 to L2 message found".
      if (
        msg.includes('nonexistent L1-to-L2 message') ||
        msg.includes('No L1 to L2 message found')
      ) {
        log(`   attempt ${i}: L2 inbox doesn't have message yet, sleeping 6s…`)
        await new Promise((r) => setTimeout(r, 6_000))
      } else {
        throw e
      }
    }
  }
  log('done — recipient', recipientAddr.toString(), 'has', SWAP_IN.toString(), 'private AZB notes.')
  log('       depositor', depositorAddr.toString(), 'has 500 fewer private AZA notes.')
  log('       observers cannot link the two — both private balances are encrypted.')

  await wallet.stop()
}

main().then(
  () => process.exit(0),
  (err) => {
    console.error('[swap-l1-private] FAILED:', err)
    process.exit(1)
  },
)
