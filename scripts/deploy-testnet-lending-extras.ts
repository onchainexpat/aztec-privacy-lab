/**
 * Deploy the bundled PriceFeed + Lending contracts to Aztec testnet and wire
 * them per the canonical sandbox sequence, then merge into the existing
 * testnet-state.json (does NOT touch the other variants — ld2 etc. untouched).
 *
 *   TESTNET_SECRET=0x... TESTNET_SALT=0x... TESTNET_SIGNING=0x... \
 *     npm run testnet:deploy-lending-extras
 *
 * Powers the interactive ld1 (private collateral + private debt) and ld3
 * (fully public lending) panels on testnet. Fees paid by the canonical
 * SponsoredFPC paymaster — no fee-juice claim needed.
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
import { LendingContract } from '@aztec/noir-contracts.js/Lending'
import { PriceFeedContract } from '@aztec/noir-contracts.js/PriceFeed'

const TESTNET_URL = process.env.TESTNET_URL ?? 'https://rpc.testnet.aztec-labs.com'
const __dirname = dirname(fileURLToPath(import.meta.url))
const stateFile = resolve(__dirname, '..', 'public', 'testnet-state.json')

const PRICE_1_FOR_1 = 1_000_000_000n
const LTV_BPS = 8_000n

function log(...args: unknown[]) {
  // eslint-disable-next-line no-console
  console.log('[testnet-lending-extras]', ...args)
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
  const token0Address = state.token0?.address
  const token1Address = state.token1?.address
  if (!token0Address || !token1Address)
    throw new Error('testnet-state.json missing token0/token1 (run testnet:setup first)')

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
  const token0 = AztecAddress.fromString(token0Address)
  const token1 = AztecAddress.fromString(token1Address)
  log('admin', admin.toString())

  async function instanceJSON(address: AztecAddress) {
    const meta = await wallet.getContractMetadata(address)
    if (!meta.instance) throw new Error('instance missing for ' + address.toString())
    return JSON.parse(jsonStringify(meta.instance))
  }

  log('deploying PriceFeed…')
  const { contract: priceFeed } = await PriceFeedContract.deploy(wallet).send({
    from: admin,
    fee: feeOpts,
    contractAddressSalt: Fr.random(),
  })
  log('  at', priceFeed.address.toString())
  await priceFeed.methods.set_price(0n, PRICE_1_FOR_1).send({ from: admin, fee: feeOpts })
  log('  set_price(0, 1e9)')

  log('deploying Lending…')
  const { contract: lending } = await LendingContract.deploy(wallet).send({
    from: admin,
    fee: feeOpts,
    contractAddressSalt: Fr.random(),
  })
  log('  at', lending.address.toString())
  await lending.methods
    .init(priceFeed.address, LTV_BPS, token0, token1)
    .send({ from: admin, fee: feeOpts })
  log('  init(priceFeed, 8000, token0, token1)')

  // Lending mints stable_coin (AZB / token1) when borrowers borrow — grant it.
  await wallet.registerContract(deserializeInstance(state.token1.instance), TokenContract.artifact)
  const token1Contract = await TokenContract.at(token1, wallet)
  await token1Contract.methods.set_minter(lending.address, true).send({ from: admin, fee: feeOpts })
  log('  granted Lending minter rights on token1')

  state.priceFeed = {
    address: priceFeed.address.toString(),
    instance: await instanceJSON(priceFeed.address),
    price: PRICE_1_FOR_1.toString(),
  }
  state.lending = {
    address: lending.address.toString(),
    instance: await instanceJSON(lending.address),
    collateralAsset: 'AZA',
    stableCoin: 'AZB',
    loanToValueBps: LTV_BPS.toString(),
  }

  writeFileSync(stateFile, JSON.stringify(state, null, 2))
  log('done — merged priceFeed + lending into testnet-state.json')

  await wallet.stop()
}

main().then(
  () => process.exit(0),
  (err) => {
    console.error('[testnet-lending-extras] FAILED:', err)
    process.exit(1)
  },
)
