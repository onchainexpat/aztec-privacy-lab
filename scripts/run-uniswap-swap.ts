/**
 * End-to-end Uniswap-from-L2 swap:
 *
 *   1. Pick a claim secret (Fr); compute its secretHash for the L2 claim.
 *   2. Set public authwit so the L2 Uniswap can pull AZA from admin's public balance.
 *   3. Call L2 Uniswap.swap_public — burns AZA, emits two L2→L1 messages
 *      (one for the input withdrawal, one for the swap request).
 *   4. Compute membership witnesses for both messages once the epoch settles.
 *   5. Call L1 UniswapPortal.swapPublic — consumes the input message via the
 *      input portal, runs exactInputSingle on the (mock) V3 router, hands the
 *      output tokens to the output portal which queues an L1→L2 message.
 *   6. Wait for the L1→L2 message to land in the L2 inbox.
 *   7. Call L2 outputBridge.claim_public — admin's AZB public balance grows.
 *
 *   npm run sandbox:swap-l1
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
import { SetPublicAuthwitContractInteraction } from '@aztec/aztec.js/authorization'
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
  console.log('[swap-l1]', ...args)
}

async function main() {
  const state = JSON.parse(readFileSync(stateFile, 'utf8'))
  if (!state.crossChain?.l1UniswapPortal || !state.crossChain?.l2BridgeB) {
    throw new Error('Uniswap stack not wired yet. Run npm run sandbox:uniswap first.')
  }

  log('connecting to L2', SANDBOX_URL)
  const node = createAztecNodeClient(SANDBOX_URL)
  const wallet = await EmbeddedWallet.create(node, { ephemeral: true })
  const [testAccount] = await getInitialTestAccountsData()
  await wallet.createSchnorrAccount(testAccount.secret, testAccount.salt, testAccount.signingKey)
  const admin = testAccount.address

  // Rehydrate L2 contracts (Token AZA, Token AZB, both bridges, Uniswap).
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
  const transferNonce = Fr.random()
  const swapNonce = Fr.random()
  const claimSecret = Fr.random()
  const claimSecretHash = await computeSecretHash(claimSecret)

  log('1. setting public authwit so L2 Uniswap can pull AZA from admin…')
  const intent = {
    caller: l2Uniswap.address,
    call: await tokenA.methods
      .transfer_in_public(admin, l2Uniswap.address, SWAP_IN, transferNonce)
      .getFunctionCall(),
  }
  const auth = await SetPublicAuthwitContractInteraction.create(wallet, admin, intent, true)
  await auth.send()

  log('2. calling L2 Uniswap.swap_public…')
  const UNISWAP_FEE_TIER = new Fr(3000n)
  const sendResult = await l2Uniswap.methods
    .swap_public(
      admin,
      bridgeA.address,
      SWAP_IN,
      bridgeB.address,
      transferNonce,
      UNISWAP_FEE_TIER,
      1n,
      admin,
      claimSecretHash,
      EthAddress.ZERO,
      swapNonce,
    )
    .send({ from: admin })
  const txHash = (sendResult as unknown as { receipt: { txHash: { toString(): string } } }).receipt
    .txHash.toString()
  log('   L2 swap_public tx', txHash)

  log('   claim_secret =', claimSecret.toString())
  log('   claim_secret_hash =', claimSecretHash.toString())

  // 3. Read the two L2→L1 messages this tx emitted.
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
  log('3. txEffect has', effect.data.l2ToL1Msgs.length, 'L2→L1 messages')

  log('4. computing membership witnesses for both messages…')
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

  // 5. Call UniswapPortal.swapPublic on L1 with both witnesses.
  log('5. calling UniswapPortal.swapPublic on L1…')
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
  const metadataArr = witnesses.map((w) => {
    type SibPath = { toBufferArray: () => Buffer[] }
    const sp = (w.siblingPath as unknown as SibPath).toBufferArray()
    return {
      _epoch: BigInt(w.epochNumber),
      _leafIndex: w.leafIndex,
      _path: sp.map((b) => `0x${b.toString('hex')}` as `0x${string}`),
    }
  })
  log('   metadata[0] epoch=' + metadataArr[0]._epoch + ' leaf=' + metadataArr[0]._leafIndex)
  log('   metadata[1] epoch=' + metadataArr[1]._epoch + ' leaf=' + metadataArr[1]._leafIndex)
  // The L1 outbox needs to have advanced past witnesses[].epochNumber. The
  // sandbox advances the outbox roughly once per minute via cheat-codes — so
  // retry with backoff if the call reverts with Outbox__NothingToConsumeAtEpoch.
  const swapArgs = [
    state.crossChain.l1Portal as `0x${string}`,
    SWAP_IN,
    3000,
    state.crossChain.l1OutputPortal as `0x${string}`,
    1n,
    admin.toString() as `0x${string}`,
    claimSecretHash.toString() as `0x${string}`,
    false,
    [metadataArr[0], metadataArr[1]],
  ] as const
  let swapTx: `0x${string}` | undefined
  for (let i = 0; i < 30; i++) {
    try {
      swapTx = await portal.write.swapPublic(swapArgs)
      break
    } catch (e) {
      const msg = e instanceof Error ? `${e.message}\n${(e as { cause?: { data?: string } }).cause?.data ?? ''}` : String(e)
      // Outbox__NothingToConsumeAtEpoch selector is 0x5e3d32ce.
      if (msg.includes('5e3d32ce') || msg.toLowerCase().includes('reverted')) {
        const before = await portal.read.outbox().catch(() => null)
        log(`   attempt ${i}: outbox not ready (msg target epoch ${witnesses[0].epochNumber}) outbox=${before}; sleeping 12s…`)
        await new Promise((r) => setTimeout(r, 12_000))
      } else {
        throw e
      }
    }
  }
  if (!swapTx) throw new Error('swapPublic still reverts after retries — outbox cadence too slow')
  log('   L1 swapPublic tx', swapTx)

  // 6. The output portal queued an L1→L2 message to mint AZB to admin. We need the
  //    leaf index of that message to call claim_public on the output bridge.
  log('6. waiting for output-mint message to land on L2 inbox…')
  const { decodeEventLog } = await import('viem')
  const { InboxAbi } = await import('@aztec/l1-artifacts/InboxAbi')
  const receipt = await l1Client.waitForTransactionReceipt({ hash: swapTx })
  const inboxAddr = (await node.getNodeInfo()).l1ContractAddresses.inboxAddress.toString().toLowerCase()
  const inboxLog = receipt.logs.find((l) => l.address.toLowerCase() === inboxAddr)
  if (!inboxLog) throw new Error('no inbox log in L1 swap receipt')
  const decoded = decodeEventLog({ abi: InboxAbi, data: inboxLog.data, topics: inboxLog.topics })
  const mintLeafIndex = (decoded.args as unknown as { index: bigint }).index
  log('   output-mint L1→L2 message at leaf index', mintLeafIndex.toString())

  // 7. Wait for L2 to ingest the message, then claim_public on the output bridge.
  log('7. claiming output AZB on L2…')
  const bridgeBTyped = bridgeB as unknown as {
    methods: {
      claim_public: (recipient: AztecAddress, amount: bigint, secret: Fr, leafIdx: Fr) => {
        send: (opts: { from: AztecAddress }) => Promise<unknown>
      }
    }
  }
  for (let i = 0; i < 30; i++) {
    try {
      await bridgeBTyped.methods
        .claim_public(admin, SWAP_IN, claimSecret, new Fr(mintLeafIndex))
        .send({ from: admin })
      break
    } catch (e) {
      const msg = e instanceof Error ? e.message : String(e)
      if (msg.includes('nonexistent L1-to-L2 message')) {
        log(`   attempt ${i}: L2 inbox doesn't have message yet, sleeping 6s…`)
        await new Promise((r) => setTimeout(r, 6_000))
      } else {
        throw e
      }
    }
  }
  log('done — admin AZB public balance just grew by', SWAP_IN.toString(), 'on L2')

  await wallet.stop()
}

main().then(
  () => process.exit(0),
  (err) => {
    console.error('[swap-l1] FAILED:', err)
    process.exit(1)
  },
)
