/**
 * Deploy the newer privacy variants to Aztec testnet (merges into the existing
 * testnet-state.json): IdentityAttestation, BattleshipPvP, SealedBidAuction,
 * Wordle, Lottery, GoodsEscrow, BatchPay.
 *
 * Reuses the existing AZA token0 (USDC stand-in) + the deployer account from
 * testnet-state.json. All fees paid by SponsoredFPC; no Sepolia ETH needed for
 * these pure-L2 contracts.
 *
 *   TESTNET_SECRET=0x... TESTNET_SALT=0x... TESTNET_SIGNING=0x... \
 *     npm run testnet:deploy-extras
 *
 * Time-windowed contracts (auction, wordle) use the latest L2 testnet block
 * timestamp + a generous buffer so the windows are open for the demo.
 */
import { readFileSync, writeFileSync } from 'node:fs'
import { dirname, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

import { EmbeddedWallet } from '@aztec/wallets/embedded'
import { createAztecNodeClient } from '@aztec/aztec.js/node'
import { Fr, Fq } from '@aztec/aztec.js/fields'
import { AztecAddress } from '@aztec/stdlib/aztec-address'
import { EthAddress } from '@aztec/aztec.js/addresses'
import { SponsoredFPCContract } from '@aztec/noir-contracts.js/SponsoredFPC'
import { SponsoredFeePaymentMethod } from '@aztec/aztec.js/fee'
import { getContractInstanceFromInstantiationParams } from '@aztec/aztec.js/contracts'
import { SPONSORED_FPC_SALT } from '@aztec/constants'
import { jsonStringify } from '@aztec/foundation/json-rpc'
import { pedersenHash } from '@aztec/foundation/crypto/sync'

import { IdentityAttestationContract } from '../src/contracts/IdentityAttestation'
import { BattleshipPvPContract } from '../src/contracts/BattleshipPvP'
import { SealedBidAuctionContract } from '../src/contracts/SealedBidAuction'
import { WordleContract } from '../src/contracts/Wordle'
import { LotteryContract } from '../src/contracts/Lottery'
import { GoodsEscrowContract } from '../src/contracts/GoodsEscrow'
import { BatchPayContract } from '../src/contracts/BatchPay'

const TESTNET_URL = process.env.TESTNET_URL ?? 'https://rpc.testnet.aztec-labs.com'
const __dirname = dirname(fileURLToPath(import.meta.url))
const stateFile = resolve(__dirname, '..', 'public', 'testnet-state.json')

function log(...args: unknown[]) {
  // eslint-disable-next-line no-console
  console.log('[testnet-extras]', ...args)
}
function fr(name: string, hex: string | undefined): Fr {
  if (!hex) throw new Error(`missing env ${name}`)
  return Fr.fromString(hex.startsWith('0x') ? hex : `0x${hex}`)
}
function fq(name: string, hex: string | undefined): Fq {
  if (!hex) throw new Error(`missing env ${name}`)
  return Fq.fromString(hex.startsWith('0x') ? hex : `0x${hex}`)
}
async function getSponsoredFPCAddress() {
  const inst = await getContractInstanceFromInstantiationParams(SponsoredFPCContract.artifact, {
    salt: new Fr(SPONSORED_FPC_SALT),
  })
  return { address: inst.address, instance: inst }
}
function packWord(word: string): bigint {
  let p = 0n
  for (let i = 0; i < 5; i++) p = p * 256n + BigInt(word.charCodeAt(i))
  return p
}

async function main() {
  const state = JSON.parse(readFileSync(stateFile, 'utf8'))
  const azaAddress = state.token0?.address
  if (!azaAddress) throw new Error('testnet-state.json missing token0 (run testnet:setup first)')

  log('connecting to', TESTNET_URL)
  const node = createAztecNodeClient(TESTNET_URL)
  const info = await node.getNodeInfo()
  log('node version', info.nodeVersion, '· l1ChainId', info.l1ChainId)

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
  const admin = AztecAddress.fromString(state.deployer)
  const aza = AztecAddress.fromString(azaAddress)
  log('admin', admin.toString())

  // L2 timestamp baseline for time-windowed contracts.
  const header = await node.getBlockHeader()
  const l2Now =
    header && header.globalVariables
      ? Number((header.globalVariables as { timestamp: bigint }).timestamp)
      : Math.floor(Date.now() / 1000)
  log('L2 now', l2Now)

  async function instanceJSON(address: AztecAddress) {
    const meta = await wallet.getContractMetadata(address)
    if (!meta.instance) throw new Error('instance missing for ' + address.toString())
    return JSON.parse(jsonStringify(meta.instance))
  }

  // --- IdentityAttestation ---
  log('deploying IdentityAttestation…')
  const { contract: attestation } = await IdentityAttestationContract.deploy(wallet, admin).send({
    from: admin,
    fee: feeOpts,
  })
  log('  at', attestation.address.toString())
  const attestationSecrets: { secret: string; commitment: string }[] = []
  for (let i = 0; i < 3; i++) {
    const s = Fr.random()
    const c = pedersenHash([s])
    await attestation.methods.add_credential(c.toBigInt()).send({ from: admin, fee: feeOpts })
    attestationSecrets.push({ secret: s.toString(), commitment: c.toString() })
  }
  log('  pre-issued 3 credentials')

  // --- BattleshipPvP ---
  log('deploying BattleshipPvP…')
  const { contract: battleshipPvp } = await BattleshipPvPContract.deploy(wallet).send({
    from: admin,
    fee: feeOpts,
  })
  log('  at', battleshipPvp.address.toString())

  // --- SealedBidAuction ---
  log('deploying SealedBidAuction…')
  const aucBid = BigInt(l2Now + 60 * 60 * 24) // 24h window on testnet L2 time
  const aucReveal = aucBid + 60n * 60n * 24n
  const { contract: auction } = await SealedBidAuctionContract.deploy(
    wallet,
    admin,
    1n,
    aucBid,
    aucReveal,
  ).send({ from: admin, fee: feeOpts })
  log('  at', auction.address.toString())

  // --- Wordle ---
  log('deploying Wordle…')
  const wTarget = 'aztec'
  const wPacked = packWord(wTarget)
  const wSalt = Fr.random()
  const wCommit = pedersenHash([wPacked, wSalt])
  const wGuess = BigInt(l2Now + 60 * 60 * 24)
  const wReveal = wGuess + 60n * 60n * 24n
  const { contract: wordle } = await WordleContract.deploy(
    wallet,
    admin,
    wCommit.toBigInt(),
    wGuess,
    wReveal,
  ).send({ from: admin, fee: feeOpts })
  log('  at', wordle.address.toString())

  // --- Lottery ---
  log('deploying Lottery…')
  const lSeed = Fr.random()
  const lSalt = Fr.random()
  const lCommit = pedersenHash([lSeed, lSalt])
  const { contract: lottery } = await LotteryContract.deploy(
    wallet,
    aza,
    admin,
    EthAddress.ZERO,
    lCommit.toBigInt(),
  ).send({ from: admin, fee: feeOpts })
  log('  at', lottery.address.toString())

  // --- GoodsEscrow ---
  log('deploying GoodsEscrow…')
  const { contract: goodsEscrow } = await GoodsEscrowContract.deploy(wallet, aza, admin).send({
    from: admin,
    fee: feeOpts,
  })
  log('  at', goodsEscrow.address.toString())

  // --- BatchPay ---
  log('deploying BatchPay…')
  const { contract: batchPay } = await BatchPayContract.deploy(wallet, aza).send({
    from: admin,
    fee: feeOpts,
  })
  log('  at', batchPay.address.toString())

  // --- persist ---
  state.attestation = {
    address: attestation.address.toString(),
    instance: await instanceJSON(attestation.address),
    issuer: admin.toString(),
    credentials: attestationSecrets,
  }
  state.battleshipPvp = {
    address: battleshipPvp.address.toString(),
    instance: await instanceJSON(battleshipPvp.address),
  }
  state.sealedBidAuction = {
    address: auction.address.toString(),
    instance: await instanceJSON(auction.address),
    operator: admin.toString(),
    itemHash: '1',
    bidDeadline: aucBid.toString(),
    revealDeadline: aucReveal.toString(),
  }
  state.wordle = {
    address: wordle.address.toString(),
    instance: await instanceJSON(wordle.address),
    operator: admin.toString(),
    targetWord: wTarget,
    targetPacked: wPacked.toString(),
    targetSalt: wSalt.toString(),
    guessDeadline: wGuess.toString(),
    revealDeadline: wReveal.toString(),
  }
  state.lottery = {
    address: lottery.address.toString(),
    instance: await instanceJSON(lottery.address),
    operator: admin.toString(),
    seed: lSeed.toString(),
    salt: lSalt.toString(),
    seedCommitment: lCommit.toString(),
    maxNumber: '100',
  }
  state.goodsEscrow = {
    address: goodsEscrow.address.toString(),
    instance: await instanceJSON(goodsEscrow.address),
    paymentToken: 'AZA',
    attestor: admin.toString(),
  }
  state.batchPay = {
    address: batchPay.address.toString(),
    instance: await instanceJSON(batchPay.address),
    paymentToken: 'AZA',
  }

  writeFileSync(stateFile, JSON.stringify(state, null, 2))
  log('done — wrote testnet-state.json with 7 new variants')

  await wallet.stop()
}

main().then(
  () => process.exit(0),
  (err) => {
    console.error('[testnet-extras] FAILED:', err)
    process.exit(1)
  },
)
