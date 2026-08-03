/**
 * Deploy ONLY the AnonymousVoting contract to Aztec testnet and merge it into
 * testnet-state.json. Eligible voters = holders of the existing testnet
 * attestation credentials (same secrets), so voting composes with attestation.
 *
 *   TESTNET_SECRET=0x... TESTNET_SALT=0x... TESTNET_SIGNING=0x... \
 *     npm run testnet:deploy-anonymous-voting
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

import { AnonymousVotingContract } from '../src/contracts/AnonymousVoting'
import { buildEligibleTree } from '../src/lib/voting-merkle'

const TESTNET_URL = process.env.TESTNET_URL ?? 'https://v5.testnet.rpc.aztec-labs.com'
const __dirname = dirname(fileURLToPath(import.meta.url))
const stateFile = resolve(__dirname, '..', 'public', 'testnet-state.json')
const CANDIDATES = ['Raise the quorum', 'Keep as-is', 'Abstain']

function log(...a: unknown[]) {
  // eslint-disable-next-line no-console
  console.log('[testnet-voting]', ...a)
}
function fr(n: string, h: string | undefined): Fr {
  if (!h) throw new Error(`missing env ${n}`)
  return Fr.fromString(h.startsWith('0x') ? h : `0x${h}`)
}
function fq(n: string, h: string | undefined): Fq {
  if (!h) throw new Error(`missing env ${n}`)
  return Fq.fromString(h.startsWith('0x') ? h : `0x${h}`)
}

async function main() {
  const state = JSON.parse(readFileSync(stateFile, 'utf8'))
  const credentials: { secret: string }[] = state.attestation?.credentials ?? []
  if (credentials.length === 0) throw new Error('no testnet attestation credentials to seed eligibility')

  const node = createAztecNodeClient(TESTNET_URL)
  log('node', (await node.getNodeInfo()).nodeVersion)
  const wallet = await EmbeddedWallet.create(node, { ephemeral: true, pxe: { proverEnabled: true } })
  const fpc = await getContractInstanceFromInstantiationParams(SponsoredFPCContract.artifact, {
    salt: new Fr(SPONSORED_FPC_SALT),
  })
  await wallet.registerContract(fpc, SponsoredFPCContract.artifact)
  const feeOpts = { paymentMethod: new SponsoredFeePaymentMethod(fpc.address) }
  await wallet.createSchnorrAccount(
    fr('TESTNET_SECRET', process.env.TESTNET_SECRET),
    fr('TESTNET_SALT', process.env.TESTNET_SALT),
    fq('TESTNET_SIGNING', process.env.TESTNET_SIGNING),
  )
  const admin = AztecAddress.fromStringUnsafe(state.deployer)
  log('admin', admin.toString())

  log('deploying AnonymousVoting…')
  const { contract: voting } = await AnonymousVotingContract.deploy(wallet, admin, CANDIDATES.length).send({
    from: admin,
    fee: feeOpts,
    contractAddressSalt: Fr.random(),
  })
  log('  at', voting.address.toString())

  const eligibleSecrets = credentials.map((c) => c.secret)
  const { root: eligibleRoot } = buildEligibleTree(eligibleSecrets)
  await voting.methods
    .publish_eligible_root(Fr.fromString(eligibleRoot).toBigInt())
    .send({ from: admin, fee: feeOpts })
  log('  published eligible root for', eligibleSecrets.length, 'voters')

  const meta = await wallet.getContractMetadata(voting.address)
  if (!meta.instance) throw new Error('instance missing')
  state.anonymousVoting = {
    address: voting.address.toString(),
    instance: JSON.parse(jsonStringify(meta.instance)),
    operator: admin.toString(),
    numCandidates: CANDIDATES.length,
    candidates: CANDIDATES,
    eligibleRoot,
    eligibleSecrets,
  }
  writeFileSync(stateFile, JSON.stringify(state, null, 2))
  log('done — merged anonymousVoting into testnet-state.json')
  await wallet.stop()
}

main().then(
  () => process.exit(0),
  (err) => {
    console.error('[testnet-voting] FAILED:', err)
    process.exit(1)
  },
)
