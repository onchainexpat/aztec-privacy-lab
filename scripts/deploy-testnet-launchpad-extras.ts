/**
 * Deploy ONLY the launchpad-extras contracts (PublicTotalCrowdfunding = lp2 and
 * PerDonorReceipts = lp3) to Aztec testnet and merge them into the existing
 * testnet-state.json (does NOT touch the other variants).
 *
 *   TESTNET_SECRET=0x... TESTNET_SALT=0x... TESTNET_SIGNING=0x... \
 *     npm run testnet:deploy-launchpad-extras
 *
 * Both contracts take (donation_token, operator). donation_token = AZA (token0),
 * operator = the deployer. The testnet panels let a visitor donate their own
 * per-tab private AZA via an authwit-gated transfer_to_public pull.
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

import { PublicTotalCrowdfundingContract } from '../src/contracts/PublicTotalCrowdfunding'
import { PerDonorReceiptsContract } from '../src/contracts/PerDonorReceipts'

const TESTNET_URL = process.env.TESTNET_URL ?? 'https://v5.testnet.rpc.aztec-labs.com'
const __dirname = dirname(fileURLToPath(import.meta.url))
const stateFile = resolve(__dirname, '..', 'public', 'testnet-state.json')

function log(...args: unknown[]) {
  // eslint-disable-next-line no-console
  console.log('[testnet-launchpad-extras]', ...args)
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
  const admin = AztecAddress.fromStringUnsafe(state.deployer)
  const aza = AztecAddress.fromStringUnsafe(azaAddress)
  log('admin', admin.toString())

  async function instanceJSON(address: AztecAddress) {
    const meta = await wallet.getContractMetadata(address)
    if (!meta.instance) throw new Error('instance missing for ' + address.toString())
    const _inst = JSON.parse(jsonStringify(meta.instance)); if (_inst.currentContractClassId == null && _inst.originalContractClassId != null) _inst.currentContractClassId = _inst.originalContractClassId; return _inst
  }

  log('deploying PublicTotalCrowdfunding (lp2)…')
  const { contract: publicCrowdfunding } = await PublicTotalCrowdfundingContract.deploy(
    wallet,
    aza,
    admin,
  ).send({ from: admin, fee: feeOpts, contractAddressSalt: Fr.random() })
  log('  at', publicCrowdfunding.address.toString())

  log('deploying PerDonorReceipts (lp3)…')
  const { contract: perDonorReceipts } = await PerDonorReceiptsContract.deploy(
    wallet,
    aza,
    admin,
  ).send({ from: admin, fee: feeOpts, contractAddressSalt: Fr.random() })
  log('  at', perDonorReceipts.address.toString())

  state.publicCrowdfunding = {
    address: publicCrowdfunding.address.toString(),
    instance: await instanceJSON(publicCrowdfunding.address),
    donationToken: 'AZA',
    operator: admin.toString(),
  }
  state.perDonorReceipts = {
    address: perDonorReceipts.address.toString(),
    instance: await instanceJSON(perDonorReceipts.address),
    donationToken: 'AZA',
    operator: admin.toString(),
  }

  writeFileSync(stateFile, JSON.stringify(state, null, 2))
  log('done — merged publicCrowdfunding + perDonorReceipts into testnet-state.json')

  await wallet.stop()
}

main().then(
  () => process.exit(0),
  (err) => {
    console.error('[testnet-launchpad-extras] FAILED:', err)
    process.exit(1)
  },
)
