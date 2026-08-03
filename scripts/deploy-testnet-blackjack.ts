/**
 * Deploy ONLY the Blackjack contract to Aztec testnet and merge it into the
 * existing testnet-state.json (does NOT touch the other variants).
 *
 *   TESTNET_SECRET=0x... TESTNET_SALT=0x... TESTNET_SIGNING=0x... \
 *     npm run testnet:deploy-blackjack
 *
 * Just deploys the contract (dealer = deployer). The interactive game runs on
 * sandbox (it needs the dealer operator online to deal each hand); this makes
 * the "contract is live on testnet" claim true.
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
import { jsonStringify } from '@aztec/foundation/json-rpc'

import { BlackjackContract } from '../src/contracts/Blackjack'

const TESTNET_URL = process.env.TESTNET_URL ?? 'https://v5.testnet.rpc.aztec-labs.com'
const __dirname = dirname(fileURLToPath(import.meta.url))
const stateFile = resolve(__dirname, '..', 'public', 'testnet-state.json')

function log(...args: unknown[]) {
  // eslint-disable-next-line no-console
  console.log('[testnet-blackjack]', ...args)
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

async function main() {
  const state = JSON.parse(readFileSync(stateFile, 'utf8'))

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
  const admin = AztecAddress.fromStringUnsafe(state.deployer)
  log('admin', admin.toString())

  log('deploying Blackjack…')
  const { contract: blackjack } = await BlackjackContract.deploy(wallet, admin).send({
    from: admin,
    fee: feeOpts,
  })
  log('  at', blackjack.address.toString())

  const meta = await wallet.getContractMetadata(blackjack.address)
  if (!meta.instance) throw new Error('instance missing')
  state.blackjack = {
    address: blackjack.address.toString(),
    instance: JSON.parse(jsonStringify(meta.instance)),
    dealer: admin.toString(),
  }

  writeFileSync(stateFile, JSON.stringify(state, null, 2))
  log('done — merged blackjack into testnet-state.json')

  await wallet.stop()
}

main().then(
  () => process.exit(0),
  (err) => {
    console.error('[testnet-blackjack] FAILED:', err)
    process.exit(1)
  },
)
