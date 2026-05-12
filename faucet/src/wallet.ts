/**
 * Boot a Node-side Aztec wallet against the canonical testnet RPC. Loads the
 * admin Schnorr account from env, registers AZA + AZB contract instances from
 * testnet-state.json, prepares the SponsoredFPC paymaster.
 *
 * The PXE state is persistent (LMDB on disk) so restarts don't re-sync the
 * world state from scratch.
 */
import { EmbeddedWallet } from '@aztec/wallets/embedded'
import { createAztecNodeClient } from '@aztec/aztec.js/node'
import { Fr, Fq } from '@aztec/aztec.js/fields'
import { TokenContract } from '@aztec/noir-contracts.js/Token'
import { SponsoredFPCContract } from '@aztec/noir-contracts.js/SponsoredFPC'
import { getContractInstanceFromInstantiationParams } from '@aztec/aztec.js/contracts'
import { SponsoredFeePaymentMethod } from '@aztec/aztec.js/fee'
import { SPONSORED_FPC_SALT } from '@aztec/constants'
import { jsonParseWithSchema } from '@aztec/foundation/json-rpc'
import { ContractInstanceWithAddressSchema } from '@aztec/stdlib/contract'
import { AztecAddress } from '@aztec/aztec.js/addresses'

import type { TestnetState } from './state.ts'

export interface FaucetWallet {
  admin: AztecAddress
  token0: TokenContract
  token1: TokenContract
  feeOpts: { paymentMethod: SponsoredFeePaymentMethod }
  stop: () => Promise<void>
}

function fr(name: string, hex: string | undefined): Fr {
  if (!hex) throw new Error(`missing env ${name}`)
  return Fr.fromString(hex.startsWith('0x') ? hex : `0x${hex}`)
}

function fq(name: string, hex: string | undefined): Fq {
  if (!hex) throw new Error(`missing env ${name}`)
  return Fq.fromString(hex.startsWith('0x') ? hex : `0x${hex}`)
}

export async function bootWallet(state: TestnetState): Promise<FaucetWallet> {
  const url = process.env.TESTNET_URL ?? state.sandboxUrl
  const dataDir = process.env.DATA_DIR ?? '/data'

  console.log(`[faucet] connecting to ${url}`)
  const node = createAztecNodeClient(url)

  const info = await node.getNodeInfo()
  console.log(
    `[faucet] node version ${info.nodeVersion} chain ${info.l1ChainId} rollup ${info.rollupVersion}`,
  )

  console.log(`[faucet] starting PXE with proverEnabled=true (real proofs)`)
  const wallet = await EmbeddedWallet.create(node, {
    pxe: { proverEnabled: true },
    // dataDirectory persists the PXE state across restarts. Without this the
    // service re-syncs from genesis on every boot, which is slow on testnet.
    pxeConfig: { dataDirectory: dataDir } as Record<string, unknown>,
  })

  console.log(`[faucet] resolving SponsoredFPC paymaster`)
  const fpcInstance = await getContractInstanceFromInstantiationParams(
    SponsoredFPCContract.artifact,
    { salt: new Fr(SPONSORED_FPC_SALT) },
  )
  await wallet.registerContract(fpcInstance, SponsoredFPCContract.artifact)
  const feeOpts = { paymentMethod: new SponsoredFeePaymentMethod(fpcInstance.address) }

  console.log(`[faucet] registering admin Schnorr account from env`)
  const secret = fr('TESTNET_SECRET', process.env.TESTNET_SECRET)
  const salt = fr('TESTNET_SALT', process.env.TESTNET_SALT)
  const signing = fq('TESTNET_SIGNING', process.env.TESTNET_SIGNING)
  const accountManager = await (
    wallet as unknown as {
      createSchnorrAccount: (s: Fr, sl: Fr, k: Fq) => Promise<{ address: AztecAddress }>
    }
  ).createSchnorrAccount(secret, salt, signing)
  const admin = accountManager.address
  console.log(`[faucet] admin address ${admin.toString()}`)

  function deserialize(raw: unknown) {
    return jsonParseWithSchema(JSON.stringify(raw), ContractInstanceWithAddressSchema)
  }

  console.log(`[faucet] registering ${state.token0.symbol} + ${state.token1.symbol} contracts`)
  await wallet.registerContract(deserialize(state.token0.instance), TokenContract.artifact)
  await wallet.registerContract(deserialize(state.token1.instance), TokenContract.artifact)

  const token0 = await TokenContract.at(
    AztecAddress.fromString(state.token0.address),
    wallet as unknown as Parameters<typeof TokenContract.at>[1],
  )
  const token1 = await TokenContract.at(
    AztecAddress.fromString(state.token1.address),
    wallet as unknown as Parameters<typeof TokenContract.at>[1],
  )

  return {
    admin,
    token0,
    token1,
    feeOpts,
    stop: () => wallet.stop(),
  }
}
