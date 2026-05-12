/**
 * Deploy a fresh AMM + LP token on testnet and seed it at 1 azETH = 2500
 * azUSDC. The previous AMM (first seed-amm run) is permanently stuck at a
 * 1:2 ratio because Uniswap V2's MIN_LIQUIDITY locks the last few units in
 * the pool, fixing the price ratio. Abandoning that pool is the simplest path
 * to a realistic price.
 *
 *   TESTNET_SECRET=... TESTNET_SALT=... TESTNET_SIGNING=... \
 *     npm run testnet:redeploy-amm
 *
 * Updates public/testnet-state.json with the new lpToken + amm addresses +
 * instances + reserves. Visitors with a cached per-tab client will register
 * the new contracts on next page load — no other migration needed.
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
import { jsonStringify, jsonParseWithSchema } from '@aztec/foundation/json-rpc'
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
  console.log('[redeploy-amm]', ...a)
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

  const token0 = await TokenContract.at(AztecAddress.fromString(state.token0.address), wallet)
  const token1 = await TokenContract.at(AztecAddress.fromString(state.token1.address), wallet)

  async function bigintBal(contract: TokenContract, fn: 'balance_of_private' | 'balance_of_public', who: AztecAddress) {
    return (await contract.methods[fn](who).simulate({ from: admin })).result as bigint
  }

  log('checking admin private balances…')
  const ethBal = await bigintBal(token0, 'balance_of_private', admin)
  const usdcBal = await bigintBal(token1, 'balance_of_private', admin)
  log(`admin private: ${ethBal} ${state.token0.symbol} / ${usdcBal} ${state.token1.symbol}`)
  if (ethBal < TARGET_ETH) {
    throw new Error(`admin lacks ${state.token0.symbol} (need ${TARGET_ETH}, has ${ethBal})`)
  }
  if (usdcBal < TARGET_USDC) {
    const toMint = TARGET_USDC - usdcBal
    log(`minting ${toMint} extra private ${state.token1.symbol} (real proof, ~40 s)`)
    await token1.methods.mint_to_private(admin, toMint).send({ from: admin, fee: feeOpts })
  }

  // -------- 1. fresh LP token --------
  log('deploying new LP token (AZLP v2)…')
  const { contract: lpToken } = await TokenContract.deploy(
    wallet,
    admin,
    'AztecLP v2',
    'AZLPv2',
    18,
  ).send({ from: admin, fee: feeOpts })
  log('LP token at', lpToken.address.toString())

  // -------- 2. fresh AMM --------
  log('deploying new AMM…')
  const { contract: amm } = await AMMContract.deploy(
    wallet,
    token0.address,
    token1.address,
    lpToken.address,
  ).send({ from: admin, fee: feeOpts })
  log('AMM at', amm.address.toString())

  // -------- 3. grant AMM minter rights on LP --------
  log('granting AMM minter rights on LP token…')
  await lpToken.methods
    .set_minter(amm.address, true)
    .send({ from: admin, fee: feeOpts })

  // -------- 4. add liquidity at the realistic 1:2500 ratio --------
  log(
    `seeding pool at 1 ${state.token0.symbol} = ${Number(TARGET_USDC) / Number(TARGET_ETH)} ` +
      `${state.token1.symbol} (${TARGET_ETH} + ${TARGET_USDC})`,
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

  const r0 = await bigintBal(token0, 'balance_of_public', amm.address)
  const r1 = await bigintBal(token1, 'balance_of_public', amm.address)
  log(`new pool reserves: ${r0} / ${r1}`)

  // -------- 5. update state JSON --------
  async function instanceJSON(address: AztecAddress) {
    const meta = await wallet.getContractMetadata(address)
    if (!meta.instance) throw new Error('instance missing for ' + address.toString())
    return JSON.parse(jsonStringify(meta.instance))
  }

  state.lpToken = {
    address: lpToken.address.toString(),
    name: 'AztecLP v2',
    symbol: 'AZLPv2',
    instance: await instanceJSON(lpToken.address),
  }
  state.amm = {
    address: amm.address.toString(),
    instance: await instanceJSON(amm.address),
  }
  state.reserves = { AZA: r0.toString(), AZB: r1.toString() }

  writeFileSync(stateFile, JSON.stringify(state, null, 2))
  log('updated public/testnet-state.json with new amm + lpToken — done')

  await wallet.stop()
}

main().then(
  () => process.exit(0),
  (err) => {
    console.error('[redeploy-amm] FAILED:', err)
    process.exit(1)
  },
)
