/**
 * EXPERIMENTAL — currently blocked on RPC availability.
 *
 * The aztec.drpc.org Aztec endpoint is a pruned full node: it serves recent
 * blocks but NOT genesis state. EmbeddedWallet's PXE startup hard-requires
 * `node_getBlockHeader(0)` (see block_synchronizer.js — flagged for refactor
 * upstream). So this script fails as soon as the first .send() triggers a
 * sync, with `Unknown state. First available state is 1`. The structure is
 * preserved here for the day an archive RPC for Alpha v4 appears.
 *
 *   TESTNET_SECRET=0x... TESTNET_SALT=0x... TESTNET_SIGNING=0x... npm run testnet:setup
 *
 * Real-world path: use Azguard's PXE in the browser instead.
 *
 * The minimal set this would deploy: Tokens AZA + AZB + AZLP, AMM, the custom
 * PublicCollateralPrivateDebt (ld2), and PrivateVoting. SponsoredFPC pays the
 * fees, so the deployer doesn't need fee juice.
 */
import { mkdirSync, writeFileSync, existsSync, readFileSync } from 'node:fs'
import { dirname, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

import { EmbeddedWallet } from '@aztec/wallets/embedded'
import { createAztecNodeClient } from '@aztec/aztec.js/node'
import { Fr, Fq } from '@aztec/aztec.js/fields'
import { TokenContract } from '@aztec/noir-contracts.js/Token'
import { AMMContract } from '@aztec/noir-contracts.js/AMM'
import { SponsoredFPCContract } from '@aztec/noir-contracts.js/SponsoredFPC'
import { PrivateVotingContract } from '@aztec/noir-contracts.js/PrivateVoting'
import { PublicCollateralPrivateDebtContract } from '../src/contracts/PublicCollateralPrivateDebt'
import { SponsoredFeePaymentMethod } from '@aztec/aztec.js/fee'
import { getContractInstanceFromInstantiationParams } from '@aztec/aztec.js/contracts'
import { SPONSORED_FPC_SALT } from '@aztec/constants'
import { jsonStringify } from '@aztec/foundation/json-rpc'

const TESTNET_URL = process.env.TESTNET_URL ?? 'https://aztec.drpc.org'

const __dirname = dirname(fileURLToPath(import.meta.url))
const stateFile = resolve(__dirname, '..', 'public', 'testnet-state.json')

function log(...args: unknown[]) {
  // eslint-disable-next-line no-console
  console.log('[setup-testnet]', ...args)
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
  log('connecting to', TESTNET_URL)
  const node = createAztecNodeClient(TESTNET_URL)
  const info = await node.getNodeInfo()
  log('node version', info.nodeVersion, '· l1ChainId', info.l1ChainId, '· rollupVersion', info.rollupVersion)

  const wallet = await EmbeddedWallet.create(node, { ephemeral: true })

  log('resolving canonical SponsoredFPC…')
  const sponsoredFpc = await getSponsoredFPCAddress()
  log('SponsoredFPC at', sponsoredFpc.address.toString())
  await wallet.registerContract(sponsoredFpc.instance, SponsoredFPCContract.artifact)

  const paymentMethod = new SponsoredFeePaymentMethod(sponsoredFpc.address)
  const feeOpts = { paymentMethod }

  log('creating Schnorr account from env (TESTNET_SECRET/SALT/SIGNING)…')
  const secret = fr('TESTNET_SECRET', process.env.TESTNET_SECRET)
  const salt = fr('TESTNET_SALT', process.env.TESTNET_SALT)
  const signing = fq('TESTNET_SIGNING', process.env.TESTNET_SIGNING)
  const accountManager = await wallet.createSchnorrAccount(secret, salt, signing)
  const admin = accountManager.address
  log('account address', admin.toString())

  // existing-state passthrough: if state already exists, we'll merge into it.
  const previous = existsSync(stateFile)
    ? (JSON.parse(readFileSync(stateFile, 'utf8')) as Record<string, unknown>)
    : null
  if (previous) log('found previous testnet-state.json — will merge')

  log('deploying account contract (fee paid via SponsoredFPC)…')
  const deployAccount = await accountManager.getDeployMethod()
  await deployAccount.send({ from: admin, fee: feeOpts })
  log('account deployed')

  async function deployToken(name: string, symbol: string) {
    log(`deploying Token ${symbol}…`)
    const { contract } = await TokenContract.deploy(wallet, admin, name, symbol, 18).send({
      from: admin,
      fee: feeOpts,
    })
    log(`${symbol} at`, contract.address.toString())
    return contract
  }

  const token0 = await deployToken('AztecA', 'AZA')
  const token1 = await deployToken('AztecB', 'AZB')
  const lpToken = await deployToken('AztecLP', 'AZLP')

  log('deploying AMM…')
  const { contract: amm } = await AMMContract.deploy(
    wallet,
    token0.address,
    token1.address,
    lpToken.address,
  ).send({ from: admin, fee: feeOpts })
  log('AMM at', amm.address.toString())

  log('granting AMM minter rights on LP token…')
  await lpToken.methods
    .set_minter(amm.address, true)
    .send({ from: admin, fee: feeOpts })

  log('deploying PublicCollateralPrivateDebt (ld2)…')
  const { contract: ld2 } = await PublicCollateralPrivateDebtContract.deploy(
    wallet,
    token0.address,
    token1.address,
    admin,
  ).send({ from: admin, fee: feeOpts })
  log('ld2 at', ld2.address.toString())
  await token1.methods
    .set_minter(ld2.address, true)
    .send({ from: admin, fee: feeOpts })

  log('deploying PrivateVoting + opening election…')
  const { contract: voting } = await PrivateVotingContract.deploy(wallet, admin).send({
    from: admin,
    fee: feeOpts,
  })
  log('PrivateVoting at', voting.address.toString())
  const electionId = 1n
  await voting.methods.start_vote({ id: electionId }).send({ from: admin, fee: feeOpts })

  log('minting starter balances to admin…')
  const MINT = 100_000n
  await token0.methods.mint_to_private(admin, MINT).send({ from: admin, fee: feeOpts })
  await token1.methods.mint_to_private(admin, MINT).send({ from: admin, fee: feeOpts })
  await token0.methods.mint_to_public(admin, MINT).send({ from: admin, fee: feeOpts })
  log('minted', MINT.toString(), 'each (private), +', MINT.toString(), 'public AZA')

  async function instanceJSON(address: typeof admin) {
    const meta = await wallet.getContractMetadata(address)
    if (!meta.instance) throw new Error('instance missing for ' + address.toString())
    return JSON.parse(jsonStringify(meta.instance))
  }

  const state = {
    sandboxUrl: TESTNET_URL,
    deployer: admin.toString(),
    sponsoredFpc: sponsoredFpc.address.toString(),
    token0: {
      address: token0.address.toString(),
      name: 'AztecA',
      symbol: 'AZA',
      instance: await instanceJSON(token0.address),
    },
    token1: {
      address: token1.address.toString(),
      name: 'AztecB',
      symbol: 'AZB',
      instance: await instanceJSON(token1.address),
    },
    lpToken: {
      address: lpToken.address.toString(),
      name: 'AztecLP',
      symbol: 'AZLP',
      instance: await instanceJSON(lpToken.address),
    },
    amm: {
      address: amm.address.toString(),
      instance: await instanceJSON(amm.address),
    },
    publicCollateralPrivateDebt: {
      address: ld2.address.toString(),
      instance: await instanceJSON(ld2.address),
      collateralAsset: 'AZA',
      debtAsset: 'AZB',
      ltvNumerator: '50',
      ltvDenominator: '100',
    },
    voting: {
      address: voting.address.toString(),
      instance: await instanceJSON(voting.address),
      admin: admin.toString(),
      electionId: electionId.toString(),
    },
    initialPrivateBalances: { AZA: MINT.toString(), AZB: MINT.toString() },
    network: 'testnet',
    deployedAt: new Date().toISOString(),
  }

  mkdirSync(dirname(stateFile), { recursive: true })
  writeFileSync(stateFile, JSON.stringify(state, null, 2))
  log('wrote', stateFile)
  log('done. Browse the dashboard with the Testnet toggle to use these contracts.')

  await wallet.stop()
}

main().then(
  () => process.exit(0),
  (err) => {
    console.error('[setup-testnet] FAILED:', err)
    process.exit(1)
  },
)
