/**
 * Deploy ONLY the Rewards contract to Aztec testnet and merge it into the
 * existing testnet-state.json (does NOT touch the other variants).
 *
 *   TESTNET_SECRET=0x... TESTNET_SALT=0x... TESTNET_SIGNING=0x... \
 *     npm run testnet:deploy-rewards
 *
 * Publishes a Merkle root over a small campaign (entry 0 = the deployer) for
 * period 0 and best-effort funds the pool with 100000 AZA. The testnet rewards
 * panel is a read-only live register view (claims are address-gated).
 */
import { readFileSync, writeFileSync } from 'node:fs'
import { dirname, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

import { EmbeddedWallet } from '@aztec/wallets/embedded'
import { createAztecNodeClient } from '@aztec/aztec.js/node'
import { Fr, Fq } from '@aztec/aztec.js/fields'
import { AztecAddress } from '@aztec/stdlib/aztec-address'
import { SponsoredFPCContract } from '@aztec/noir-contracts.js/SponsoredFPC'
import { SponsoredFeePaymentMethod } from '@aztec/aztec.js/fee'
import { getContractInstanceFromInstantiationParams } from '@aztec/aztec.js/contracts'
import { SPONSORED_FPC_SALT } from '@aztec/constants'
import { jsonStringify, jsonParseWithSchema } from '@aztec/foundation/json-rpc'
import { ContractInstanceWithAddressSchema } from '@aztec/stdlib/contract'
import { TokenContract } from '@aztec/noir-contracts.js/Token'

import { RewardsContract } from '../src/contracts/Rewards'
import { buildRewardsTree, type RewardEntry } from '../src/lib/rewards-merkle'

const TESTNET_URL = process.env.TESTNET_URL ?? 'https://rpc.testnet.aztec-labs.com'
const __dirname = dirname(fileURLToPath(import.meta.url))
const stateFile = resolve(__dirname, '..', 'public', 'testnet-state.json')

function log(...args: unknown[]) {
  // eslint-disable-next-line no-console
  console.log('[testnet-rewards]', ...args)
}
function fr(name: string, hex: string | undefined): Fr {
  if (!hex) throw new Error(`missing env ${name}`)
  return Fr.fromString(hex.startsWith('0x') ? hex : `0x${hex}`)
}
function fq(name: string, hex: string | undefined): Fq {
  if (!hex) throw new Error(`missing env ${name}`)
  return Fq.fromString(hex.startsWith('0x') ? hex : `0x${hex}`)
}
function deserializeInstance(raw: unknown) {
  return jsonParseWithSchema(JSON.stringify(raw), ContractInstanceWithAddressSchema)
}
async function getSponsoredFPCAddress() {
  const inst = await getContractInstanceFromInstantiationParams(SponsoredFPCContract.artifact, {
    salt: new Fr(SPONSORED_FPC_SALT),
  })
  return { address: inst.address, instance: inst }
}

async function main() {
  const state = JSON.parse(readFileSync(stateFile, 'utf8'))
  const azaAddress = state.token0?.address
  if (!azaAddress) throw new Error('testnet-state.json missing token0 (run testnet:setup first)')

  log('connecting to', TESTNET_URL)
  const node = createAztecNodeClient(TESTNET_URL)
  const info = await node.getNodeInfo()
  log('node version', info.nodeVersion, '· l1ChainId', info.l1ChainId)

  const wallet = await EmbeddedWallet.create(node, { ephemeral: true, pxe: { proverEnabled: true } })
  const sponsoredFpc = await getSponsoredFPCAddress()
  await wallet.registerContract(sponsoredFpc.instance, SponsoredFPCContract.artifact)
  const feeOpts = { paymentMethod: new SponsoredFeePaymentMethod(sponsoredFpc.address) }

  const secret = fr('TESTNET_SECRET', process.env.TESTNET_SECRET)
  const salt = fr('TESTNET_SALT', process.env.TESTNET_SALT)
  const signing = fq('TESTNET_SIGNING', process.env.TESTNET_SIGNING)
  await wallet.createSchnorrAccount(secret, salt, signing)
  const admin = AztecAddress.fromString(state.deployer)
  const aza = AztecAddress.fromString(azaAddress)
  log('admin', admin.toString())

  async function instanceJSON(address: AztecAddress) {
    const meta = await wallet.getContractMetadata(address)
    if (!meta.instance) throw new Error('instance missing for ' + address.toString())
    return JSON.parse(jsonStringify(meta.instance))
  }

  log('deploying Rewards…')
  const { contract: rewards } = await RewardsContract.deploy(wallet, aza, admin).send({
    from: admin,
    fee: feeOpts,
    contractAddressSalt: Fr.random(),
  })
  log('  at', rewards.address.toString())

  const rewardsPeriod = 0n
  const entries: RewardEntry[] = [
    { address: admin.toString(), amount: '5000' },
    { address: Fr.random().toString(), amount: '3000' },
    { address: Fr.random().toString(), amount: '7000' },
    { address: Fr.random().toString(), amount: '1500' },
  ]
  const { root } = buildRewardsTree(entries, rewardsPeriod)
  await rewards.methods.publish_root(Fr.fromString(root).toBigInt()).send({ from: admin, fee: feeOpts })
  log('  published root for', entries.length, 'leaves')

  try {
    await wallet.registerContract(deserializeInstance(state.token0.instance), TokenContract.artifact)
    const azaToken = await TokenContract.at(aza, wallet)
    await azaToken.methods.mint_to_public(rewards.address, 100_000n).send({ from: admin, fee: feeOpts })
    log('  funded pool 100000 AZA')
  } catch (e) {
    log('  (skipped pool funding:', (e as Error).message, ')')
  }

  state.rewards = {
    address: rewards.address.toString(),
    instance: await instanceJSON(rewards.address),
    paymentToken: 'AZA',
    operator: admin.toString(),
    period: rewardsPeriod.toString(),
    root,
    entries,
  }

  writeFileSync(stateFile, JSON.stringify(state, null, 2))
  log('done — merged rewards into testnet-state.json')

  await wallet.stop()
}

main().then(
  () => process.exit(0),
  (err) => {
    console.error('[testnet-rewards] FAILED:', err)
    process.exit(1)
  },
)
