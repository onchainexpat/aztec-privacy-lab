/**
 * One-off: seed the AMM on Aztec testnet with admin's pre-minted azETH/
 * azUSDC, so visitors clicking "swap" actually have reserves to swap against.
 *
 *   TESTNET_SECRET=... TESTNET_SALT=... TESTNET_SIGNING=... \
 *     npm run testnet:seed-amm
 *
 * Adds 50k azETH + 100k azUSDC (initial price 1 azETH = 2 azUSDC). Mints LP
 * tokens to admin. Real proofs, ~5 min wall clock (add_liquidity is a private
 * call → ~1 min proof + ~36 s block + a few rounds of authwits).
 */
import { readFileSync, writeFileSync } from 'node:fs'
import { resolve, dirname } from 'node:path'
import { fileURLToPath } from 'node:url'

import { EmbeddedWallet } from '@aztec/wallets/embedded'
import { createAztecNodeClient } from '@aztec/aztec.js/node'
import { Fr, Fq } from '@aztec/aztec.js/fields'
import { AztecAddress } from '@aztec/aztec.js/addresses'
import { NO_FROM } from '@aztec/aztec.js/account'
import { getContractInstanceFromInstantiationParams } from '@aztec/aztec.js/contracts'
import { SponsoredFeePaymentMethod } from '@aztec/aztec.js/fee'
import { TokenContract } from '@aztec/noir-contracts.js/Token'
import { AMMContract } from '@aztec/noir-contracts.js/AMM'
import { SponsoredFPCContract } from '@aztec/noir-contracts.js/SponsoredFPC'
import { SPONSORED_FPC_SALT } from '@aztec/constants'
import { jsonParseWithSchema } from '@aztec/foundation/json-rpc'
import { ContractInstanceWithAddressSchema } from '@aztec/stdlib/contract'

const TESTNET_URL = process.env.TESTNET_URL ?? 'https://rpc.testnet.aztec-labs.com'

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
  console.log('[seed-amm]', ...a)
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

  function deserialize(raw: unknown) {
    return jsonParseWithSchema(JSON.stringify(raw), ContractInstanceWithAddressSchema)
  }
  await wallet.registerContract(deserialize(state.token0.instance), TokenContract.artifact)
  await wallet.registerContract(deserialize(state.token1.instance), TokenContract.artifact)
  await wallet.registerContract(deserialize(state.lpToken.instance), TokenContract.artifact)
  await wallet.registerContract(deserialize(state.amm.instance), AMMContract.artifact)

  const token0 = await TokenContract.at(AztecAddress.fromString(state.token0.address), wallet)
  const token1 = await TokenContract.at(AztecAddress.fromString(state.token1.address), wallet)
  const amm = await AMMContract.at(AztecAddress.fromString(state.amm.address), wallet)

  // Check existing reserves — skip if already seeded.
  const r0 = (await token0.methods.balance_of_public(amm.address).simulate({ from: admin }))
    .result as bigint
  const r1 = (await token1.methods.balance_of_public(amm.address).simulate({ from: admin }))
    .result as bigint
  log(`current AMM reserves: ${r0} ${state.token0.symbol} / ${r1} ${state.token1.symbol}`)
  if (r0 > 0n && r1 > 0n) {
    log('pool already seeded — exiting without doing anything')
    return
  }

  // Check admin's private balances; need enough for liquidity.
  const adminBal0 = (await token0.methods.balance_of_private(admin).simulate({ from: admin }))
    .result as bigint
  const adminBal1 = (await token1.methods.balance_of_private(admin).simulate({ from: admin }))
    .result as bigint
  log(`admin private balances: ${adminBal0} ${state.token0.symbol} / ${adminBal1} ${state.token1.symbol}`)

  const AMOUNT0 = 50_000n
  const AMOUNT1 = 100_000n
  if (adminBal0 < AMOUNT0 || adminBal1 < AMOUNT1) {
    throw new Error(
      `admin lacks private liquidity (need ${AMOUNT0} + ${AMOUNT1}, has ${adminBal0} + ${adminBal1})`,
    )
  }

  log(`seeding pool with ${AMOUNT0} ${state.token0.symbol} + ${AMOUNT1} ${state.token1.symbol}`)
  log('this will take ~5 min — three real proofs for the authwits + add_liquidity call')

  const lqNonce = Fr.random()
  const t0Authwit = await wallet.createAuthWit(admin, {
    caller: amm.address,
    call: await token0.methods
      .transfer_to_public_and_prepare_private_balance_increase(admin, amm.address, AMOUNT0, lqNonce)
      .getFunctionCall(),
  })
  const t1Authwit = await wallet.createAuthWit(admin, {
    caller: amm.address,
    call: await token1.methods
      .transfer_to_public_and_prepare_private_balance_increase(admin, amm.address, AMOUNT1, lqNonce)
      .getFunctionCall(),
  })

  await amm.methods
    .add_liquidity(AMOUNT0, AMOUNT1, AMOUNT0, AMOUNT1, lqNonce)
    .send({ from: admin, fee: feeOpts, authWitnesses: [t0Authwit, t1Authwit] })
  log('add_liquidity sent')

  const r0After = (await token0.methods.balance_of_public(amm.address).simulate({ from: admin }))
    .result as bigint
  const r1After = (await token1.methods.balance_of_public(amm.address).simulate({ from: admin }))
    .result as bigint
  log(`pool reserves after seed: ${r0After} / ${r1After}`)

  state.reserves = { AZA: r0After.toString(), AZB: r1After.toString() }
  writeFileSync(stateFile, JSON.stringify(state, null, 2))
  log('updated testnet-state.json with reserves')

  // Silence unused warning — NO_FROM exported here is documentation for the
  // future deploy path, not used in this script.
  void NO_FROM
  await wallet.stop()
}

main().then(
  () => process.exit(0),
  (err) => {
    console.error('[seed-amm] FAILED:', err)
    process.exit(1)
  },
)
