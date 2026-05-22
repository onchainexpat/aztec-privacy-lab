/**
 * Deploy ONLY the Payroll contract to Aztec testnet and merge it into the
 * existing testnet-state.json (does NOT touch the other variants).
 *
 *   TESTNET_SECRET=0x... TESTNET_SALT=0x... TESTNET_SIGNING=0x... \
 *     npm run testnet:deploy-payroll
 *
 * Publishes 3 payslips for period 0 (employee = the deployer/operator in this
 * demo). Best-effort funds the pool with 50000 AZA if the deployer is the AZA
 * minter; non-fatal otherwise. The testnet payroll panel is a read-only live
 * register view, so funding is cosmetic.
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
import { pedersenHash } from '@aztec/foundation/crypto/sync'
import { TokenContract } from '@aztec/noir-contracts.js/Token'

import { PayrollContract } from '../src/contracts/Payroll'

const TESTNET_URL = process.env.TESTNET_URL ?? 'https://rpc.testnet.aztec-labs.com'
const __dirname = dirname(fileURLToPath(import.meta.url))
const stateFile = resolve(__dirname, '..', 'public', 'testnet-state.json')

function log(...args: unknown[]) {
  // eslint-disable-next-line no-console
  console.log('[testnet-payroll]', ...args)
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

  async function instanceJSON(address: AztecAddress) {
    const meta = await wallet.getContractMetadata(address)
    if (!meta.instance) throw new Error('instance missing for ' + address.toString())
    return JSON.parse(jsonStringify(meta.instance))
  }

  log('deploying Payroll…')
  const { contract: payroll } = await PayrollContract.deploy(wallet, aza, admin).send({
    from: admin,
    fee: feeOpts,
  })
  log('  at', payroll.address.toString())

  const payrollPeriod = 0n
  const payrollAmounts = [3200n, 4500n, 2750n]
  const payrollPayslips: { amount: string; period: string; commitment: string }[] = []
  for (const amount of payrollAmounts) {
    const commitment = pedersenHash([admin.toField(), new Fr(amount), new Fr(payrollPeriod)])
    await payroll.methods.add_payslip(commitment.toBigInt()).send({ from: admin, fee: feeOpts })
    payrollPayslips.push({
      amount: amount.toString(),
      period: payrollPeriod.toString(),
      commitment: commitment.toString(),
    })
  }
  log('  published', payrollPayslips.length, 'payslips')

  try {
    await wallet.registerContract(deserializeInstance(state.token0.instance), TokenContract.artifact)
    const azaToken = await TokenContract.at(aza, wallet)
    await azaToken.methods.mint_to_public(payroll.address, 50_000n).send({ from: admin, fee: feeOpts })
    log('  funded pool 50000 AZA')
  } catch (e) {
    log('  (skipped pool funding:', (e as Error).message, ')')
  }

  state.payroll = {
    address: payroll.address.toString(),
    instance: await instanceJSON(payroll.address),
    paymentToken: 'AZA',
    operator: admin.toString(),
    employee: admin.toString(),
    period: payrollPeriod.toString(),
    payslips: payrollPayslips,
  }

  writeFileSync(stateFile, JSON.stringify(state, null, 2))
  log('done — merged payroll into testnet-state.json')

  await wallet.stop()
}

main().then(
  () => process.exit(0),
  (err) => {
    console.error('[testnet-payroll] FAILED:', err)
    process.exit(1)
  },
)
