/**
 * End-to-end PRIVATE Uniswap-from-L2 swap against REAL Uniswap V3 on a
 * mainnet-forked Anvil. This is the forked-mode counterpart to
 * run-uniswap-swap-private.ts (which targets the mock router).
 *
 * Pre-reqs:
 *   ./scripts/start-fork-anvil.sh
 *   ETHEREUM_HOSTS=http://localhost:8546 aztec start --local-network --port 8090
 *   npm run sandbox:setup
 *   npm run sandbox:seed         (gives depositor private AZA balance)
 *   npm run sandbox:fork-uniswap (wires WETH/USDC portals)
 *
 *   npm run sandbox:swap-l1-private-forked
 *
 * The L1 leg uses real Uniswap V3 0.3% pool WETH/USDC. Amounts are in real
 * mainnet wei because the router enforces minimum-output bounds against the
 * pool's live state.
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
  console.log('[forked-swap]', ...args)
}

async function main() {
  const state = JSON.parse(readFileSync(stateFile, 'utf8'))
  if (!state.crossChain?.realUniswapForked) {
    throw new Error(
      'Forked-mode Uniswap stack not wired. Run npm run sandbox:fork-uniswap first.',
    )
  }
  const SWAP_IN = BigInt(state.crossChain.forkedSwapAmountInWei)
  const FEE_TIER = BigInt(state.crossChain.forkedSwapFeeTier)
  const MIN_OUT = BigInt(state.crossChain.forkedSwapMinOut)
  log(
    `swap inputs: amountIn=${SWAP_IN} wei (${Number(SWAP_IN) / 1e18} WETH), feeTier=${FEE_TIER}, minOut=${MIN_OUT}`,
  )

  log('connecting to L2', SANDBOX_URL)
  const node = createAztecNodeClient(SANDBOX_URL)
  const wallet = await EmbeddedWallet.create(node, { ephemeral: true })
  const accounts = await getInitialTestAccountsData()
  const depositor = accounts[0]
  const recipient = accounts[1] ?? accounts[0]
  await wallet.createSchnorrAccount(depositor.secret, depositor.salt, depositor.signingKey)
  const depositorAddr = depositor.address
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

  let privateBal = (
    await tokenA.methods.balance_of_private(depositorAddr).simulate({ from: depositorAddr })
  ).result as bigint
  log('depositor private AZA =', privateBal.toString())
  if (privateBal < SWAP_IN) {
    log(
      `depositor only has ${privateBal} private AZA, need ${SWAP_IN}. Topping up via mint_to_private…`,
    )
    const topUp = SWAP_IN * 10n
    await tokenA.methods.mint_to_private(depositorAddr, topUp).send({ from: depositorAddr })
    privateBal = (
      await tokenA.methods.balance_of_private(depositorAddr).simulate({ from: depositorAddr })
    ).result as bigint
    log('   topped-up private AZA =', privateBal.toString())
  }

  const transferNonce = Fr.random()
  const claimSecret = Fr.random()
  const claimSecretHash = await computeSecretHash(claimSecret)

  log('1. calling L2 Uniswap.swap_private…')
  const sendResult = await l2Uniswap.methods
    .swap_private(
      tokenA.address,
      bridgeA.address,
      SWAP_IN,
      bridgeB.address,
      transferNonce,
      new Fr(FEE_TIER),
      MIN_OUT,
      claimSecretHash,
      EthAddress.ZERO,
    )
    .send({ from: depositorAddr })
  const txHash = (sendResult as unknown as { receipt: { txHash: { toString(): string } } }).receipt
    .txHash.toString()
  log('   L2 swap_private tx', txHash)
  log('   claim_secret =', claimSecret.toString())

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
  }
  // tx effect order is [swap, withdraw]; L1 swapPrivate expects [withdraw, swap].
  const [swapWitness, withdrawWitness] = witnesses
  const orderedWitnesses = [withdrawWitness, swapWitness]

  log('4. calling UniswapPortal.swapPrivate on L1 (REAL Uniswap V3)…')
  const { createExtendedL1Client } = await import('@aztec/ethereum/client')
  const { UniswapPortalAbi } = await import('@aztec/l1-artifacts/UniswapPortalAbi')
  const { getContract, parseAbi } = await import('viem')
  const { foundry } = await import('viem/chains')
  const ANVIL_MNEMONIC = 'test test test test test test test test test test test junk'
  const l1Client = createExtendedL1Client(
    [state.crossChain.l1Rpc ?? 'http://localhost:8546'],
    ANVIL_MNEMONIC,
    foundry,
  )
  const portal = getContract({
    abi: UniswapPortalAbi,
    address: state.crossChain.l1UniswapPortal as `0x${string}`,
    client: l1Client,
  })
  const usdcAbi = parseAbi(['function balanceOf(address) view returns (uint256)'])
  const usdcContract = getContract({
    abi: usdcAbi,
    address: state.crossChain.l1TokenB as `0x${string}`,
    client: l1Client,
  })
  const outputPortalUsdcBefore = (await usdcContract.read.balanceOf([
    state.crossChain.l1OutputPortal as `0x${string}`,
  ])) as bigint
  log(`   output portal USDC balance BEFORE swap: ${outputPortalUsdcBefore} (raw, 6 decimals)`)
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
    Number(FEE_TIER),
    state.crossChain.l1OutputPortal as `0x${string}`,
    MIN_OUT,
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
        log(`   attempt ${i}: outbox not ready (epoch ${witnesses[0].epochNumber}); sleeping 12s…`)
        await new Promise((r) => setTimeout(r, 12_000))
      } else {
        throw e
      }
    }
  }
  if (!swapTx) throw new Error('swapPrivate still reverts after retries — outbox cadence too slow')
  log('   L1 swapPrivate tx', swapTx)

  const outputPortalUsdcAfter = (await usdcContract.read.balanceOf([
    state.crossChain.l1OutputPortal as `0x${string}`,
  ])) as bigint
  const swapOutputUsdc = outputPortalUsdcAfter - outputPortalUsdcBefore
  log(`   output portal USDC balance AFTER swap: ${outputPortalUsdcAfter}`)
  log(`   real V3 output (delta): ${swapOutputUsdc} USDC raw (= $${Number(swapOutputUsdc) / 1e6})`)

  log('5. waiting for output-mint message to land on L2 inbox…')
  const { decodeEventLog } = await import('viem')
  const { InboxAbi } = await import('@aztec/l1-artifacts/InboxAbi')
  const receipt = await l1Client.waitForTransactionReceipt({ hash: swapTx })
  const inboxAddr = (await node.getNodeInfo()).l1ContractAddresses.inboxAddress.toString().toLowerCase()
  const inboxLog = receipt.logs.find((l) => l.address.toLowerCase() === inboxAddr)
  if (!inboxLog) throw new Error('no inbox log in L1 swap receipt')
  const decoded = decodeEventLog({ abi: InboxAbi, data: inboxLog.data, topics: inboxLog.topics })
  const mintLeafIndex = (decoded.args as unknown as { index: bigint }).index
  // The mint message encodes the actual USDC amount the router returned —
  // claim_private must use that exact amount, NOT the swap input.
  // The L1→L2 mint message encodes the actual output amount the router
  // returned. We read it via the delta of the output portal's USDC balance.
  const claimAmount = swapOutputUsdc
  log('   output-mint L1→L2 message at leaf index', mintLeafIndex.toString())
  log('   claim amount (USDC raw):', claimAmount.toString())

  log('6. claiming output AZB on L2 (claim_private to recipient ≠ depositor)…')
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
        .claim_private(recipientAddr, claimAmount, claimSecret, new Fr(mintLeafIndex))
        .send({ from: depositorAddr })
      break
    } catch (e) {
      const msg = e instanceof Error ? e.message : String(e)
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
  log('done — recipient', recipientAddr.toString(), 'has', claimAmount.toString(), 'private AZB notes.')
  log(`       (real Uniswap V3 swap: ${SWAP_IN} wei WETH in → ${claimAmount} USDC raw out)`)

  await wallet.stop()
}

main().then(
  () => process.exit(0),
  (err) => {
    console.error('[forked-swap] FAILED:', err)
    process.exit(1)
  },
)
