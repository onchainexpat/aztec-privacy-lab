/**
 * Seed the deployed AMM with initial liquidity, then run a sample swap.
 * Reads contract addresses from public/sandbox-state.json (written by
 * setup-sandbox.ts), updates the same file with reserves + last-swap info.
 *
 *   npm run sandbox:seed
 */
import { readFileSync, writeFileSync } from 'node:fs'
import { resolve, dirname } from 'node:path'
import { fileURLToPath } from 'node:url'

import { EmbeddedWallet } from '@aztec/wallets/embedded'
import { getInitialTestAccountsData } from '@aztec/accounts/testing/lazy'
import { createAztecNodeClient } from '@aztec/aztec.js/node'
import { AztecAddress } from '@aztec/aztec.js/addresses'
import { Fr } from '@aztec/aztec.js/fields'
import { TokenContract } from '@aztec/noir-contracts.js/Token'
import { AMMContract } from '@aztec/noir-contracts.js/AMM'
import { jsonParseWithSchema } from '@aztec/foundation/json-rpc'
import { ContractInstanceWithAddressSchema } from '@aztec/stdlib/contract'

const SANDBOX_URL = process.env.SANDBOX_URL ?? 'http://localhost:8090'

const __dirname = dirname(fileURLToPath(import.meta.url))
const stateFile = resolve(__dirname, '..', 'public', 'sandbox-state.json')

function log(...args: unknown[]) {
  // eslint-disable-next-line no-console
  console.log('[seed-and-swap]', ...args)
}

async function main() {
  const state = JSON.parse(readFileSync(stateFile, 'utf8'))
  log('loaded state from', stateFile)

  const node = createAztecNodeClient(SANDBOX_URL)
  // Ephemeral PXE — contract instances are loaded from sandbox-state.json.
  const wallet = await EmbeddedWallet.create(node, { ephemeral: true })

  const [testAccount] = await getInitialTestAccountsData()
  await wallet.createSchnorrAccount(testAccount.secret, testAccount.salt, testAccount.signingKey)
  const admin = testAccount.address

  // Rehydrate contract instances from the JSON the setup script wrote, then
  // register each with the PXE so private execution can run against them.
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

  const AMOUNT0 = 100_000n
  const AMOUNT1 = 200_000n // initial price: 1 AZA = 2 AZB
  log(`seeding pool: ${AMOUNT0} ${state.token0.symbol} + ${AMOUNT1} ${state.token1.symbol}`)

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
    .send({ from: admin, authWitnesses: [t0Authwit, t1Authwit] })
  log('add_liquidity confirmed')

  // Sample swap: 1000 AZA → AZB
  const SWAP_IN = 1_000n
  log(`swapping ${SWAP_IN} ${state.token0.symbol} for ${state.token1.symbol}`)
  const { result: reserve0 } = await token0.methods
    .balance_of_public(amm.address)
    .simulate({ from: admin })
  const { result: reserve1 } = await token1.methods
    .balance_of_public(amm.address)
    .simulate({ from: admin })
  const { result: amountOutMin } = await amm.methods
    .get_amount_out_for_exact_in(reserve0, reserve1, SWAP_IN)
    .simulate({ from: admin })
  log(`pre-swap reserves: ${reserve0} / ${reserve1}, quote out = ${amountOutMin}`)

  const swapNonce = Fr.random()
  const swapAuthwit = await wallet.createAuthWit(admin, {
    caller: amm.address,
    call: await token0.methods
      .transfer_to_public(admin, amm.address, SWAP_IN, swapNonce)
      .getFunctionCall(),
  })
  await amm.methods
    .swap_exact_tokens_for_tokens(token0.address, token1.address, SWAP_IN, amountOutMin, swapNonce)
    .send({ from: admin, authWitnesses: [swapAuthwit] })
  log('swap confirmed')

  const { result: reserve0After } = await token0.methods
    .balance_of_public(amm.address)
    .simulate({ from: admin })
  const { result: reserve1After } = await token1.methods
    .balance_of_public(amm.address)
    .simulate({ from: admin })
  const { result: balAfter0 } = await token0.methods
    .balance_of_private(admin)
    .simulate({ from: admin })
  const { result: balAfter1 } = await token1.methods
    .balance_of_private(admin)
    .simulate({ from: admin })
  log(`post-swap reserves: ${reserve0After} / ${reserve1After}`)
  log(`admin private balances: AZA=${balAfter0} AZB=${balAfter1}`)

  state.reserves = { AZA: reserve0After.toString(), AZB: reserve1After.toString() }
  state.adminBalances = { AZA: balAfter0.toString(), AZB: balAfter1.toString() }
  state.lastSwap = {
    in: { symbol: state.token0.symbol, amount: SWAP_IN.toString() },
    out: { symbol: state.token1.symbol, amount: amountOutMin.toString() },
    at: new Date().toISOString(),
  }
  writeFileSync(stateFile, JSON.stringify(state, null, 2))
  log('updated', stateFile)

  await wallet.stop()
}

main().then(
  () => process.exit(0),
  (err) => {
    console.error('[seed-and-swap] FAILED:', err)
    process.exit(1)
  },
)
