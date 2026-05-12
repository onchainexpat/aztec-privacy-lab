/**
 * Re-seed the testnet AMM pool to match $2500/azETH + $1/azUSDC. The first
 * seed used a placeholder 1:2 ratio that made the AMM's implied price wildly
 * disagree with the global reference shown in the wallet panel.
 *
 *   TESTNET_SECRET=... TESTNET_SALT=... TESTNET_SIGNING=... \
 *     npm run testnet:reseed-amm
 *
 * Steps (each is a real ClientIVC proof, ~30-60 s wall clock):
 *   1. remove_liquidity of admin's entire LP position
 *   2. mint_to_private extra azUSDC so admin has at least 500 k
 *   3. add_liquidity 200 azETH + 500 000 azUSDC (the "medium" target —
 *      $1 M total at the reference price)
 *
 * Idempotent-ish: skips remove if admin has no LP, skips mint if admin
 * already has 500 k, errors loudly if amounts are off after the run.
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
import { TokenContract } from '@aztec/noir-contracts.js/Token'
import { AMMContract } from '@aztec/noir-contracts.js/AMM'
import { SponsoredFPCContract } from '@aztec/noir-contracts.js/SponsoredFPC'
import { SPONSORED_FPC_SALT } from '@aztec/constants'
import { jsonParseWithSchema } from '@aztec/foundation/json-rpc'
import { ContractInstanceWithAddressSchema } from '@aztec/stdlib/contract'

const TESTNET_URL = process.env.TESTNET_URL ?? 'https://rpc.testnet.aztec-labs.com'
const TARGET_ETH = 200n
const TARGET_USDC = 500_000n

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
  console.log('[reseed-amm]', ...a)
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
  const lpToken = await TokenContract.at(AztecAddress.fromString(state.lpToken.address), wallet)
  const amm = await AMMContract.at(AztecAddress.fromString(state.amm.address), wallet)

  async function bigintBal(contract: TokenContract, fn: 'balance_of_private' | 'balance_of_public', who: AztecAddress) {
    return (await contract.methods[fn](who).simulate({ from: admin })).result as bigint
  }

  log('reading current state…')
  const r0 = await bigintBal(token0, 'balance_of_public', amm.address)
  const r1 = await bigintBal(token1, 'balance_of_public', amm.address)
  log(`pool reserves: ${r0} ${state.token0.symbol} / ${r1} ${state.token1.symbol}`)

  const lpBal = await bigintBal(lpToken, 'balance_of_private', admin)
  log(`admin LP balance (private): ${lpBal}`)

  // -------- 1. remove_liquidity --------
  if (lpBal > 0n) {
    log(`removing all ${lpBal} LP — admin gets ~${r0}/${r1} back (modulo MIN_LIQ permanently locked)`)
    const nonce = Fr.random()
    const lpAuthwit = await wallet.createAuthWit(admin, {
      caller: amm.address,
      call: await lpToken.methods
        .transfer_to_public(admin, amm.address, lpBal, nonce)
        .getFunctionCall(),
    })
    // amount_min set to 0 — we're the only LP, no sandwich risk on testnet
    await amm.methods
      .remove_liquidity(lpBal, 0n, 0n, nonce)
      .send({ from: admin, fee: feeOpts, authWitnesses: [lpAuthwit] })
    log('remove_liquidity confirmed')
  } else {
    log('admin has no LP — skipping remove')
  }

  // -------- 2. ensure admin has TARGET_USDC + headroom of azUSDC --------
  let azUSDC = await bigintBal(token1, 'balance_of_private', admin)
  log(`admin private ${state.token1.symbol}: ${azUSDC}`)
  if (azUSDC < TARGET_USDC) {
    const toMint = TARGET_USDC - azUSDC
    log(`minting an extra ${toMint} private ${state.token1.symbol} to admin (real proof, ~40 s)`)
    await token1.methods.mint_to_private(admin, toMint).send({ from: admin, fee: feeOpts })
    azUSDC = await bigintBal(token1, 'balance_of_private', admin)
    log(`admin private ${state.token1.symbol} after mint: ${azUSDC}`)
  } else {
    log(`admin already has ≥${TARGET_USDC} ${state.token1.symbol} — skipping mint`)
  }

  const azETH = await bigintBal(token0, 'balance_of_private', admin)
  log(`admin private ${state.token0.symbol}: ${azETH}`)
  if (azETH < TARGET_ETH) {
    throw new Error(
      `admin lacks ${state.token0.symbol} for re-seed (need ${TARGET_ETH}, has ${azETH})`,
    )
  }

  // -------- 3. add_liquidity 200 azETH + 500k azUSDC --------
  log(
    `seeding new pool: ${TARGET_ETH} ${state.token0.symbol} + ${TARGET_USDC} ${state.token1.symbol} ` +
      `(price 1 ${state.token0.symbol} = ${Number(TARGET_USDC) / Number(TARGET_ETH)} ${state.token1.symbol})`,
  )
  const lqNonce = Fr.random()
  const t0Authwit = await wallet.createAuthWit(admin, {
    caller: amm.address,
    call: await token0.methods
      .transfer_to_public_and_prepare_private_balance_increase(admin, amm.address, TARGET_ETH, lqNonce)
      .getFunctionCall(),
  })
  const t1Authwit = await wallet.createAuthWit(admin, {
    caller: amm.address,
    call: await token1.methods
      .transfer_to_public_and_prepare_private_balance_increase(admin, amm.address, TARGET_USDC, lqNonce)
      .getFunctionCall(),
  })
  await amm.methods
    .add_liquidity(TARGET_ETH, TARGET_USDC, TARGET_ETH, TARGET_USDC, lqNonce)
    .send({ from: admin, fee: feeOpts, authWitnesses: [t0Authwit, t1Authwit] })
  log('add_liquidity confirmed')

  const r0After = await bigintBal(token0, 'balance_of_public', amm.address)
  const r1After = await bigintBal(token1, 'balance_of_public', amm.address)
  log(`pool reserves after re-seed: ${r0After} / ${r1After}`)

  state.reserves = { AZA: r0After.toString(), AZB: r1After.toString() }
  writeFileSync(stateFile, JSON.stringify(state, null, 2))
  log('updated testnet-state.json — done')

  await wallet.stop()
}

main().then(
  () => process.exit(0),
  (err) => {
    console.error('[reseed-amm] FAILED:', err)
    process.exit(1)
  },
)
