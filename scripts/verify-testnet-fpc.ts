/**
 * Live verification of the multi-asset FPC flow on Aztec testnet, end to end:
 *
 *   faucet.drip → token.transfer_public_to_private (shield) → estimate gas →
 *   FpcClient.createPaymentMethod → send a tx paying fees IN THE ACCEPTED TOKEN
 *
 * Self-contained: spins up a FRESH ephemeral account (no TESTNET_SECRET needed).
 * SponsoredFPC covers the setup txs (account deploy, drip, shield); the final
 * tx is the one that proves multi-asset fee payment works. Run BEFORE building
 * the UI panel — this is where the live unknowns live (attestation service,
 * shielding, the authwit the FPC uses to pull the token).
 *
 *   TESTNET_URL=https://fervor.tail3e3a0c.ts.net:8443 npx tsx scripts/verify-testnet-fpc.ts
 *   # (defaults to the public RPC if TESTNET_URL unset)
 *
 * STATUS (2026-06-07): PARKED on upstream. Our client path is healthy — the
 * ephemeral account proves and SENDS on the live 4.3.1 testnet. It then fails at
 * the first attach(): the vendored Nethermind FPC artifacts (June-1, ~4.2.0)
 * compute class id 0x10e31a… for the Faucet while the deployed instance refers to
 * 0x18c66f… — i.e. the staging deployment was recompiled for 4.3.1 but the
 * artifacts we have weren't re-vendored. Their discovery doc
 * (/.well-known/fpc.json on the attestation host) also 404s. Re-vendoring needs
 * 4.3.1-matching artifacts AND a healthy attestation host; the durable fix is to
 * self-host our own token-accepting FPC + signer. Surfaced honestly in the UI as
 * the "Multi-asset fees (FPC)" card in Shell.tsx.
 */
import { EmbeddedWallet } from '@aztec/wallets/embedded'
import { createAztecNodeClient } from '@aztec/aztec.js/node'
import { Fr, Fq } from '@aztec/aztec.js/fields'
import { AztecAddress } from '@aztec/stdlib/aztec-address'
import { SponsoredFPCContract } from '@aztec/noir-contracts.js/SponsoredFPC'
import { SponsoredFeePaymentMethod } from '@aztec/aztec.js/fee'
import { getContractInstanceFromInstantiationParams } from '@aztec/aztec.js/contracts'
import { SPONSORED_FPC_SALT } from '@aztec/constants'
import { NO_FROM } from '@aztec/aztec.js/account'

import { FpcClient } from '../src/lib/fpc/index.js'
import { FPCMultiAssetContract } from '../src/contracts/fpc/FPCMultiAsset.js'
import { TokenContract } from '../src/contracts/fpc/Token.js'
import { FaucetContract } from '../src/contracts/fpc/Faucet.js'

// Nethermind multi-asset FPC — Aztec testnet coordinates (from aztec-fpc repo
// docs/reference/testnet-deployment.md).
const FPC_ADDRESS = '0x1be2cae678e1eddd712682948119b3fe2c3ff3f381d78ebea06162f21487d60f'
const OPERATOR = '0x0aa818ff7e9bb59334e0106eeeacc5ce8d32610d34917b213f305a30a87cf974'
const ATTESTATION_BASE_URL = 'https://aztec-fpc-testnet.staging-nethermind.xyz/'
const ACCEPTED_TOKEN = '0x07348d12aae72d1c2ff67cb2bf6b0e54f2ac39484f21cad7247d4e27b4822afb'
const FAUCET = '0x291b988c66f0314b3e2758fe7c85b85f39c3007a9478ccc46f443f8b48783db4'

const TESTNET_URL = process.env.TESTNET_URL ?? 'https://v5.testnet.rpc.aztec-labs.com'

function log(...a: unknown[]) {
  // eslint-disable-next-line no-console
  console.log('[verify-fpc]', ...a)
}

// Attach a contract that's already deployed on testnet by pulling its instance
// from the node, registering it with the PXE, then constructing the typed view.
async function attach(
  addrStr: string,
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  ContractClass: any,
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  wallet: any,
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  node: any,
) {
  const addr = AztecAddress.fromStringUnsafe(addrStr)
  const instance = await node.getContract(addr)
  if (!instance) throw new Error(`contract not deployed on testnet: ${addrStr}`)
  await wallet.registerContract(instance, ContractClass.artifact)
  return ContractClass.at(addr, wallet)
}

async function run() {
  log('connecting', TESTNET_URL)
  const node = createAztecNodeClient(TESTNET_URL)
  const info = await node.getNodeInfo()
  log('node version', info.nodeVersion, '· l1ChainId', info.l1ChainId)

  // Fresh ephemeral account, prover enabled (testnet sequencer requires proofs).
  const wallet = await EmbeddedWallet.create(node, { ephemeral: true, pxe: { proverEnabled: true } })

  // SponsoredFPC pays for the setup txs (account deploy, drip, shield).
  const sponsored = await getContractInstanceFromInstantiationParams(SponsoredFPCContract.artifact, {
    salt: new Fr(SPONSORED_FPC_SALT),
  })
  await wallet.registerContract(sponsored, SponsoredFPCContract.artifact)
  const sponsoredFee = { paymentMethod: new SponsoredFeePaymentMethod(sponsored.address) }

  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const account: any = await (wallet as any).createSchnorrAccount(Fr.random(), Fr.random(), Fq.random())
  const me = account.address
  log('ephemeral account', me.toString())
  log('deploying account on testnet (SponsoredFPC pays)…')
  const deploy = await account.getDeployMethod()
  await deploy.send({ from: NO_FROM, fee: sponsoredFee })

  // Attach the deployed contracts.
  const faucet = await attach(FAUCET, FaucetContract, wallet, node)
  const token = await attach(ACCEPTED_TOKEN, TokenContract, wallet, node)
  await attach(FPC_ADDRESS, FPCMultiAssetContract, wallet, node)

  // 1) claim the accepted asset (mints to public balance)
  log('drip…')
  await faucet.methods.drip(me).send({ from: me, fee: sponsoredFee }).wait()
  const pub = await token.methods.balance_of_public(me).simulate({ from: me })
  log('public token balance after drip:', pub)

  // 2) shield: public → private (the FPC pulls from the private balance)
  const shieldAmt = BigInt(pub) / 2n
  log('shielding', shieldAmt.toString(), '…')
  await token.methods
    .transfer_public_to_private(me, me, shieldAmt, 0)
    .send({ from: me, fee: sponsoredFee })
    .wait()
  const priv = await token.methods.balance_of_private(me).simulate({ from: me })
  log('private token balance after shield:', priv)

  // 3) target tx whose fee we'll pay in the accepted token
  const target = token.methods.transfer_private_to_public(me, me, 1n, 0)

  // gas estimate (createPaymentMethod needs gasLimits + teardownGasLimits)
  const estimatedGas = await target.estimateGas({ from: me, fee: sponsoredFee })
  log('estimated gas', JSON.stringify(estimatedGas))

  // 4) get a signed quote + token-fee payment method from the FPC
  const fpcClient = new FpcClient({
    fpcAddress: AztecAddress.fromStringUnsafe(FPC_ADDRESS),
    operator: AztecAddress.fromStringUnsafe(OPERATOR),
    node,
    attestationBaseUrl: ATTESTATION_BASE_URL,
  })
  log('requesting FPC quote…')
  const { fee, quote } = await fpcClient.createPaymentMethod({
    wallet,
    user: me,
    tokenAddress: AztecAddress.fromStringUnsafe(ACCEPTED_TOKEN),
    estimatedGas,
  })
  log('quote:', quote)

  // 5) send the target tx paying fees IN THE ACCEPTED TOKEN
  const privBefore = BigInt(await token.methods.balance_of_private(me).simulate({ from: me }))
  log('sending target tx with token-paid fee…')
  const receipt = await target.send({ from: me, fee }).wait()
  const privAfter = BigInt(await token.methods.balance_of_private(me).simulate({ from: me }))

  log('✅ mined. tx', receipt.txHash?.toString())
  log(`private token balance: ${privBefore} → ${privAfter} (fee paid in token: ${privBefore - privAfter - 1n})`)
  await wallet.stop?.()
}

run().then(
  () => process.exit(0),
  (e) => {
    console.error('[verify-fpc] FAILED:', e)
    process.exit(1)
  },
)
