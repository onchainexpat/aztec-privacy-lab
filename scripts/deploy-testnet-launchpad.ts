/**
 * Deploy the bundled Crowdfunding contract (variant lp1 — fully private raise)
 * to Aztec testnet. Donation token is the existing token0 (azETH); operator is
 * the admin account. SponsoredFPC pays fees.
 *
 *   TESTNET_SECRET=... TESTNET_SALT=... TESTNET_SIGNING=... \
 *     npm run testnet:deploy-launchpad
 *
 * Merges into public/testnet-state.json under the existing `crowdfunding`
 * field, preserving the schema the dashboard already consumes.
 */
import { readFileSync, writeFileSync } from 'node:fs'
import { resolve, dirname } from 'node:path'
import { fileURLToPath } from 'node:url'

import { EmbeddedWallet } from '@aztec/wallets/embedded'
import { createAztecNodeClient } from '@aztec/aztec.js/node'
import { Fr, Fq } from '@aztec/aztec.js/fields'
import { AztecAddress } from '@aztec/aztec.js/addresses'
import { getContractInstanceFromInstantiationParams } from '@aztec/aztec.js/contracts'
import { SponsoredFeePaymentMethod } from '@aztec/aztec.js/fee'
import { SponsoredFPCContract } from '@aztec/noir-contracts.js/SponsoredFPC'
import { CrowdfundingContract } from '@aztec/noir-contracts.js/Crowdfunding'
import { SPONSORED_FPC_SALT } from '@aztec/constants'
import { jsonStringify } from '@aztec/foundation/json-rpc'

const TESTNET_URL = process.env.TESTNET_URL ?? 'https://rpc.testnet.aztec-labs.com'
const DEADLINE_DAYS = 30n

const __dirname = dirname(fileURLToPath(import.meta.url))
const stateFile = resolve(__dirname, '..', 'public', 'testnet-state.json')

function fr(name: string, hex: string | undefined): Fr {
  if (!hex) throw new Error(`missing env ${name}`)
  return Fr.fromString(hex.startsWith('0x') ? hex : `0x${hex}`)
}
function fq(name: string, hex: string | undefined): Fq {
  if (!hex) throw new Error(`missing env ${name}`)
  return Fq.fromString(hex.startsWith('0x') ? hex : `0x${hex}`)
}
function log(...a: unknown[]) {
  // eslint-disable-next-line no-console
  console.log('[deploy-launchpad]', ...a)
}

async function main() {
  log('connecting to', TESTNET_URL)
  const state = JSON.parse(readFileSync(stateFile, 'utf8'))
  const node = createAztecNodeClient(TESTNET_URL)
  const wallet = await EmbeddedWallet.create(node, {
    ephemeral: true,
    pxe: { proverEnabled: true },
  })

  const sponsoredFpc = await getContractInstanceFromInstantiationParams(
    SponsoredFPCContract.artifact,
    { salt: new Fr(SPONSORED_FPC_SALT) },
  )
  await wallet.registerContract(sponsoredFpc, SponsoredFPCContract.artifact)
  const feeOpts = { paymentMethod: new SponsoredFeePaymentMethod(sponsoredFpc.address) }

  const secret = fr('TESTNET_SECRET', process.env.TESTNET_SECRET)
  const salt = fr('TESTNET_SALT', process.env.TESTNET_SALT)
  const signing = fq('TESTNET_SIGNING', process.env.TESTNET_SIGNING)
  const accountManager = await (
    wallet as unknown as {
      createSchnorrAccount: (s: Fr, sl: Fr, k: Fq) => Promise<{ address: AztecAddress }>
    }
  ).createSchnorrAccount(secret, salt, signing)
  const admin = accountManager.address
  log('admin', admin.toString())

  const donationToken = AztecAddress.fromString(state.token0.address)
  const deadlineSec = BigInt(Math.floor(Date.now() / 1000)) + DEADLINE_DAYS * 24n * 60n * 60n

  log(
    `deploying Crowdfunding (donation=${state.token0.symbol}, operator=admin, ` +
      `deadline=+${DEADLINE_DAYS}d)…`,
  )
  const { contract: crowdfunding } = await CrowdfundingContract.deploy(
    wallet,
    donationToken,
    admin,
    deadlineSec,
  ).send({ from: admin, fee: feeOpts })
  log('Crowdfunding at', crowdfunding.address.toString())

  async function instanceJSON(address: AztecAddress) {
    const meta = await wallet.getContractMetadata(address)
    if (!meta.instance) throw new Error('instance missing for ' + address.toString())
    return JSON.parse(jsonStringify(meta.instance))
  }

  state.crowdfunding = {
    address: crowdfunding.address.toString(),
    instance: await instanceJSON(crowdfunding.address),
    donationToken: state.token0.symbol,
    operator: admin.toString(),
    deadline: deadlineSec.toString(),
  }

  writeFileSync(stateFile, JSON.stringify(state, null, 2))
  log('updated public/testnet-state.json with crowdfunding field — done')

  await wallet.stop()
}

main().then(
  () => process.exit(0),
  (err) => {
    console.error('[deploy-launchpad] FAILED:', err)
    process.exit(1)
  },
)
