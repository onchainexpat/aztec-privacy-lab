// Browser-side testnet client. Different from browser-sandbox in three ways:
//   - per-tab Schnorr account (persisted in localStorage), not the sandbox's
//     pre-funded test account
//   - PXE configured with `proverEnabled: true` so the sequencer accepts proofs
//   - SponsoredFPC paymaster for fees — visitor doesn't need fee juice
//
// On first init the visitor's account is deployed via SponsoredFPC. Subsequent
// inits reuse the localStorage credentials and skip the deploy.
//
// Tokens for actually interacting (deposit_public on ld2, swap on AMM, etc.)
// come from the /api/faucet endpoint (see api/faucet.ts).

import type { AztecAddress } from '@aztec/aztec.js/addresses'
import type { Wallet } from '@aztec/aztec.js/wallet'
import type { TokenContract } from '@aztec/noir-contracts.js/Token'
import type { AMMContract } from '@aztec/noir-contracts.js/AMM'
import type { PrivateVotingContract } from '@aztec/noir-contracts.js/PrivateVoting'
import type { PublicCollateralPrivateDebtContract } from '../contracts/PublicCollateralPrivateDebt'
import type { SandboxState } from './sandbox-state'
import type { SponsoredFeePaymentMethod } from '@aztec/aztec.js/fee'

export interface TestnetClient {
  wallet: Wallet
  /** This visitor's account address (per-tab, persistent in localStorage). */
  address: AztecAddress
  /** True if the account contract had to be deployed during this init. */
  freshAccount: boolean
  /** Fee options to attach to every send/call. SponsoredFPC pays gas. */
  feeOpts: { paymentMethod: SponsoredFeePaymentMethod }
  /** The visitor's account secret. Used to derive the ld2 position commitment
   *  as pedersen(secret, address). Only present in this tab; the only place
   *  it lives is the visitor's localStorage. */
  accountSecretHex: string
  /** ld2 position commitment derived from (accountSecret, accountAddress).
   *  This is the public key the visitor uses to deposit/borrow on ld2. */
  ld2Commitment: bigint
  token0: TokenContract
  token1: TokenContract
  lpToken: TokenContract | null
  amm: AMMContract | null
  ld2: PublicCollateralPrivateDebtContract | null
  voting: PrivateVotingContract | null
}

const STORAGE_KEY = 'aztec-experiments:testnet-account'

interface PersistedAccount {
  secret: string
  salt: string
  signing: string
  address: string
}

function loadAccount(): PersistedAccount | null {
  if (typeof localStorage === 'undefined') return null
  const raw = localStorage.getItem(STORAGE_KEY)
  if (!raw) return null
  try {
    return JSON.parse(raw) as PersistedAccount
  } catch {
    return null
  }
}

function saveAccount(a: PersistedAccount) {
  if (typeof localStorage !== 'undefined') localStorage.setItem(STORAGE_KEY, JSON.stringify(a))
}

/** Clear the visitor's local account — useful if they want a fresh one. */
export function resetTestnetAccount() {
  if (typeof localStorage !== 'undefined') localStorage.removeItem(STORAGE_KEY)
  cached = null
  broadcastClient(null)
}

let cached: Promise<TestnetClient> | null = null
let resolvedClient: TestnetClient | null = null

/** Read-only access to the already-resolved TestnetClient if one exists.
 *  Used by the top-level WalletPanel so it can show balances without forcing
 *  a fresh init — visitors who started in a demo panel get instant sync here. */
export function getResolvedTestnetClient(): TestnetClient | null {
  return resolvedClient
}

const clientListeners = new Set<(client: TestnetClient | null) => void>()
export function subscribeTestnetClient(listener: (client: TestnetClient | null) => void): () => void {
  clientListeners.add(listener)
  return () => {
    clientListeners.delete(listener)
  }
}
function broadcastClient(client: TestnetClient | null) {
  resolvedClient = client
  for (const l of clientListeners) l(client)
}

export function initTestnetClient(
  state: SandboxState,
  onProgress?: (msg: string) => void,
): Promise<TestnetClient> {
  if (cached) return cached
  const promise = (async (): Promise<TestnetClient> => {
    onProgress?.('loading aztec.js…')
    const [
      walletsMod,
      nodeMod,
      addressMod,
      tokenMod,
      ammMod,
      ld2Mod,
      votingMod,
      feeMod,
      contractsMod,
      fieldsMod,
      accountMod,
    ] = await Promise.all([
      import('@aztec/wallets/embedded'),
      import('@aztec/aztec.js/node'),
      import('@aztec/aztec.js/addresses'),
      import('@aztec/noir-contracts.js/Token'),
      import('@aztec/noir-contracts.js/AMM'),
      import('../contracts/PublicCollateralPrivateDebt'),
      import('@aztec/noir-contracts.js/PrivateVoting'),
      import('@aztec/aztec.js/fee'),
      import('@aztec/aztec.js/contracts'),
      import('@aztec/aztec.js/fields'),
      import('@aztec/aztec.js/account'),
    ])
    const sponsoredFPCMod = await import('@aztec/noir-contracts.js/SponsoredFPC')
    const constantsMod = await import('@aztec/constants')

    onProgress?.('connecting to ' + state.sandboxUrl + '…')
    const node = nodeMod.createAztecNodeClient(state.sandboxUrl)
    const wallet = (await walletsMod.EmbeddedWallet.create(node, {
      pxe: { proverEnabled: true },
    })) as unknown as Wallet

    // Resolve canonical SponsoredFPC + register so the wallet can use it as a paymaster.
    onProgress?.('resolving SponsoredFPC paymaster…')
    const sponsoredInstance = await contractsMod.getContractInstanceFromInstantiationParams(
      sponsoredFPCMod.SponsoredFPCContract.artifact,
      { salt: new fieldsMod.Fr(constantsMod.SPONSORED_FPC_SALT) },
    )
    await wallet.registerContract(sponsoredInstance, sponsoredFPCMod.SponsoredFPCContract.artifact)
    const paymentMethod = new feeMod.SponsoredFeePaymentMethod(sponsoredInstance.address)
    const feeOpts = { paymentMethod }

    // Load or generate the visitor's per-tab Schnorr account.
    onProgress?.('checking browser account…')
    let persisted = loadAccount()
    let freshAccount = false
    if (!persisted) {
      const secret = fieldsMod.Fr.random()
      const salt = fieldsMod.Fr.random()
      const signing = fieldsMod.Fq.random()
      persisted = {
        secret: secret.toString(),
        salt: salt.toString(),
        signing: signing.toString(),
        address: '', // filled below
      }
      freshAccount = true
    }

    const secret = fieldsMod.Fr.fromString(persisted.secret)
    const salt = fieldsMod.Fr.fromString(persisted.salt)
    const signing = fieldsMod.Fq.fromString(persisted.signing)

    onProgress?.('registering account in PXE…')
    const accountManager = await (
      wallet as unknown as {
        createSchnorrAccount: (
          s: typeof secret,
          sl: typeof salt,
          k: typeof signing,
        ) => Promise<{ address: AztecAddress; getDeployMethod: () => Promise<unknown> }>
      }
    ).createSchnorrAccount(secret, salt, signing)
    const address = accountManager.address
    persisted.address = address.toString()
    saveAccount(persisted)

    // If we generated this account in this call, deploy it. Use NO_FROM
    // so the deploy path skips the normal authwit lookup (account doesn't
    // exist yet on the L2).
    if (freshAccount) {
      onProgress?.('deploying your account on testnet (1-2 min — real proof)…')
      const deployMethod = await accountManager.getDeployMethod() as {
        send: (opts: unknown) => Promise<unknown>
      }
      await deployMethod.send({ from: accountMod.NO_FROM, fee: feeOpts })
    }

    // Register all the admin-deployed contracts so we can interact with them.
    onProgress?.('registering deployed contracts…')
    const [{ jsonParseWithSchema }, { ContractInstanceWithAddressSchema }] = await Promise.all([
      import('@aztec/foundation/json-rpc'),
      import('@aztec/stdlib/contract'),
    ])
    function deserialize(raw: unknown) {
      return jsonParseWithSchema(JSON.stringify(raw), ContractInstanceWithAddressSchema)
    }
    await wallet.registerContract(deserialize(state.token0.instance), tokenMod.TokenContract.artifact)
    await wallet.registerContract(deserialize(state.token1.instance), tokenMod.TokenContract.artifact)
    if (state.lpToken) {
      await wallet.registerContract(
        deserialize(state.lpToken.instance),
        tokenMod.TokenContract.artifact,
      )
    }
    if (state.amm) {
      await wallet.registerContract(deserialize(state.amm.instance), ammMod.AMMContract.artifact)
    }
    if (state.publicCollateralPrivateDebt) {
      await wallet.registerContract(
        deserialize(state.publicCollateralPrivateDebt.instance),
        ld2Mod.PublicCollateralPrivateDebtContractArtifact,
      )
    }
    if (state.voting) {
      await wallet.registerContract(
        deserialize(state.voting.instance),
        votingMod.PrivateVotingContract.artifact,
      )
    }

    const token0 = await tokenMod.TokenContract.at(
      addressMod.AztecAddress.fromString(state.token0.address),
      wallet,
    )
    const token1 = await tokenMod.TokenContract.at(
      addressMod.AztecAddress.fromString(state.token1.address),
      wallet,
    )
    const lpToken = state.lpToken
      ? await tokenMod.TokenContract.at(
          addressMod.AztecAddress.fromString(state.lpToken.address),
          wallet,
        )
      : null
    const amm = state.amm
      ? await ammMod.AMMContract.at(addressMod.AztecAddress.fromString(state.amm.address), wallet)
      : null
    const ld2 = state.publicCollateralPrivateDebt
      ? await ld2Mod.PublicCollateralPrivateDebtContract.at(
          addressMod.AztecAddress.fromString(state.publicCollateralPrivateDebt.address),
          wallet,
        )
      : null
    const voting = state.voting
      ? await votingMod.PrivateVotingContract.at(
          addressMod.AztecAddress.fromString(state.voting.address),
          wallet,
        )
      : null

    // Derive the ld2 position commitment from the account secret + address.
    // This mirrors `pedersen_hash([secret, owner.to_field()])` in the
    // contract's borrow_private function, so the visitor can prove ownership
    // of their position by re-supplying the same secret.
    onProgress?.('deriving ld2 commitment…')
    const { pedersenHash } = await import('@aztec/foundation/crypto/sync')
    const ld2Commitment = pedersenHash([secret, address.toField()]).toBigInt()

    onProgress?.('ready')
    return {
      wallet,
      address,
      freshAccount,
      feeOpts,
      accountSecretHex: persisted.secret,
      ld2Commitment,
      token0,
      token1,
      lpToken,
      amm,
      ld2,
      voting,
    }
  })()
  cached = promise.then(
    (c) => {
      broadcastClient(c)
      return c
    },
    (e) => {
      cached = null
      throw e
    },
  )
  return cached
}
