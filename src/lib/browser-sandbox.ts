// Browser-side PXE bootstrap. Lazy: nothing loads until the user clicks
// "Initialize browser PXE". Heavy WASM (~10MB).
//
// On a fresh page this:
//   1. Creates an in-browser PXE talking to the sandbox node
//   2. Registers the first --local-network test account
//   3. Attaches to the deployed Token/AMM/LP contracts so we can run private
//      execution against them.

import type { Wallet } from '@aztec/aztec.js/wallet'
import type { AztecAddress } from '@aztec/aztec.js/addresses'
import type { TokenContract } from '@aztec/noir-contracts.js/Token'
import type { AMMContract } from '@aztec/noir-contracts.js/AMM'
import type { CrowdfundingContract } from '@aztec/noir-contracts.js/Crowdfunding'
import type { LendingContract } from '@aztec/noir-contracts.js/Lending'
import type { PrivateSwapWrapperContract } from '../contracts/PrivateSwapWrapper'
import type { PublicTotalCrowdfundingContract } from '../contracts/PublicTotalCrowdfunding'
import type { PerDonorReceiptsContract } from '../contracts/PerDonorReceipts'
import type { PublicCollateralPrivateDebtContract } from '../contracts/PublicCollateralPrivateDebt'
import type { PrivateVotingContract } from '@aztec/noir-contracts.js/PrivateVoting'
import type { TokenBridgeContract } from '@aztec/noir-contracts.js/TokenBridge'
import type { UniswapContract } from '@aztec/noir-contracts.js/Uniswap'
import type { SandboxState } from './sandbox-state'
import { isCrossPrivateBoundary, PrivateNetworkUnreachableError } from './aztec'

export interface BrowserSandbox {
  wallet: Wallet
  admin: AztecAddress
  amm: AMMContract
  token0: TokenContract
  token1: TokenContract
  lpToken: TokenContract
  wrapper: PrivateSwapWrapperContract | null
  crowdfunding: CrowdfundingContract | null
  publicCrowdfunding: PublicTotalCrowdfundingContract | null
  perDonorReceipts: PerDonorReceiptsContract | null
  voting: PrivateVotingContract | null
  lending: LendingContract | null
  ld2: PublicCollateralPrivateDebtContract | null
  l2Bridge: TokenBridgeContract | null
  l2BridgeB: TokenBridgeContract | null
  l2Uniswap: UniswapContract | null
}

let cached: Promise<BrowserSandbox> | null = null

export class TestnetInteractiveNotYetSupportedError extends Error {
  constructor() {
    super(
      'Interactive demos on testnet are not wired yet. The current `initBrowserSandbox` ' +
        'uses the sandbox pre-funded test accounts via `getInitialTestAccountsData()`, ' +
        'which only exist on `aztec start --local-network`. The testnet path needs a ' +
        'per-tab Schnorr account deployed via SponsoredFPC + `proverEnabled: true`. ' +
        'For now: view the deployed contracts on Aztecscan via the links in the panel ' +
        'above, or clone the repo and run the dev server against a local sandbox.',
    )
    this.name = 'TestnetInteractiveNotYetSupportedError'
  }
}

export function initBrowserSandbox(
  state: SandboxState,
  onProgress?: (msg: string) => void,
): Promise<BrowserSandbox> {
  if (cached) return cached
  if (isCrossPrivateBoundary(state.sandboxUrl)) {
    return Promise.reject(new PrivateNetworkUnreachableError(state.sandboxUrl))
  }
  if (state.network === 'testnet') {
    return Promise.reject(new TestnetInteractiveNotYetSupportedError())
  }
  const promise = (async (): Promise<BrowserSandbox> => {
    onProgress?.('loading aztec.js…')
    const [
      walletsMod,
      testingMod,
      nodeMod,
      addressMod,
      tokenMod,
      ammMod,
      wrapperMod,
      crowdfundingMod,
    ] = await Promise.all([
      import('@aztec/wallets/embedded'),
      import('@aztec/accounts/testing/lazy'),
      import('@aztec/aztec.js/node'),
      import('@aztec/aztec.js/addresses'),
      import('@aztec/noir-contracts.js/Token'),
      import('@aztec/noir-contracts.js/AMM'),
      import('../contracts/PrivateSwapWrapper'),
      import('@aztec/noir-contracts.js/Crowdfunding'),
    ])
    const lendingMod = await import('@aztec/noir-contracts.js/Lending')
    const ld2Mod = await import('../contracts/PublicCollateralPrivateDebt')
    const publicCrowdfundingMod = await import('../contracts/PublicTotalCrowdfunding')
    const perDonorReceiptsMod = await import('../contracts/PerDonorReceipts')
    const votingMod = await import('@aztec/noir-contracts.js/PrivateVoting')
    const bridgeMod = await import('@aztec/noir-contracts.js/TokenBridge')
    const uniswapMod = await import('@aztec/noir-contracts.js/Uniswap')

    onProgress?.('connecting to ' + state.sandboxUrl + '…')
    const node = nodeMod.createAztecNodeClient(state.sandboxUrl)
    const wallet = (await walletsMod.EmbeddedWallet.create(node, {
      ephemeral: true,
    })) as unknown as Wallet

    onProgress?.('registering test account…')
    const [testAccount] = await testingMod.getInitialTestAccountsData()
    await (wallet as unknown as {
      createSchnorrAccount: (
        secret: unknown,
        salt: unknown,
        signingKey: unknown,
      ) => Promise<unknown>
    }).createSchnorrAccount(testAccount.secret, testAccount.salt, testAccount.signingKey)

    onProgress?.('rehydrating deployed contract instances…')
    const [{ jsonParseWithSchema }, { ContractInstanceWithAddressSchema }] = await Promise.all([
      import('@aztec/foundation/json-rpc'),
      import('@aztec/stdlib/contract'),
    ])
    function deserialize(raw: unknown) {
      return jsonParseWithSchema(JSON.stringify(raw), ContractInstanceWithAddressSchema)
    }
    await wallet.registerContract(deserialize(state.token0.instance), tokenMod.TokenContract.artifact)
    await wallet.registerContract(deserialize(state.token1.instance), tokenMod.TokenContract.artifact)
    await wallet.registerContract(deserialize(state.lpToken.instance), tokenMod.TokenContract.artifact)
    await wallet.registerContract(deserialize(state.amm.instance), ammMod.AMMContract.artifact)
    if (state.privateSwapWrapper) {
      await wallet.registerContract(
        deserialize(state.privateSwapWrapper.instance),
        wrapperMod.PrivateSwapWrapperContractArtifact,
      )
    }
    if (state.crowdfunding) {
      await wallet.registerContract(
        deserialize(state.crowdfunding.instance),
        crowdfundingMod.CrowdfundingContract.artifact,
      )
    }
    if (state.lending) {
      await wallet.registerContract(
        deserialize(state.lending.instance),
        lendingMod.LendingContract.artifact,
      )
    }
    if (state.publicCollateralPrivateDebt) {
      await wallet.registerContract(
        deserialize(state.publicCollateralPrivateDebt.instance),
        ld2Mod.PublicCollateralPrivateDebtContractArtifact,
      )
    }
    if (state.publicCrowdfunding) {
      await wallet.registerContract(
        deserialize(state.publicCrowdfunding.instance),
        publicCrowdfundingMod.PublicTotalCrowdfundingContractArtifact,
      )
    }
    if (state.perDonorReceipts) {
      await wallet.registerContract(
        deserialize(state.perDonorReceipts.instance),
        perDonorReceiptsMod.PerDonorReceiptsContractArtifact,
      )
    }
    if (state.voting) {
      await wallet.registerContract(
        deserialize(state.voting.instance),
        votingMod.PrivateVotingContract.artifact,
      )
    }
    if (state.crossChain?.bridge0Instance) {
      await wallet.registerContract(
        deserialize(state.crossChain.bridge0Instance),
        bridgeMod.TokenBridgeContract.artifact,
      )
    }
    if (state.crossChain?.l2BridgeBInstance) {
      await wallet.registerContract(
        deserialize(state.crossChain.l2BridgeBInstance),
        bridgeMod.TokenBridgeContract.artifact,
      )
    }
    if (state.crossChain?.l2UniswapInstance) {
      await wallet.registerContract(
        deserialize(state.crossChain.l2UniswapInstance),
        uniswapMod.UniswapContract.artifact,
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
    const lpToken = await tokenMod.TokenContract.at(
      addressMod.AztecAddress.fromString(state.lpToken.address),
      wallet,
    )
    const amm = await ammMod.AMMContract.at(
      addressMod.AztecAddress.fromString(state.amm.address),
      wallet,
    )
    const wrapper = state.privateSwapWrapper
      ? await wrapperMod.PrivateSwapWrapperContract.at(
          addressMod.AztecAddress.fromString(state.privateSwapWrapper.address),
          wallet,
        )
      : null
    const crowdfunding = state.crowdfunding
      ? await crowdfundingMod.CrowdfundingContract.at(
          addressMod.AztecAddress.fromString(state.crowdfunding.address),
          wallet,
        )
      : null
    const lending = state.lending
      ? await lendingMod.LendingContract.at(
          addressMod.AztecAddress.fromString(state.lending.address),
          wallet,
        )
      : null
    const ld2 = state.publicCollateralPrivateDebt
      ? await ld2Mod.PublicCollateralPrivateDebtContract.at(
          addressMod.AztecAddress.fromString(state.publicCollateralPrivateDebt.address),
          wallet,
        )
      : null
    const publicCrowdfunding = state.publicCrowdfunding
      ? await publicCrowdfundingMod.PublicTotalCrowdfundingContract.at(
          addressMod.AztecAddress.fromString(state.publicCrowdfunding.address),
          wallet,
        )
      : null
    const perDonorReceipts = state.perDonorReceipts
      ? await perDonorReceiptsMod.PerDonorReceiptsContract.at(
          addressMod.AztecAddress.fromString(state.perDonorReceipts.address),
          wallet,
        )
      : null
    const voting = state.voting
      ? await votingMod.PrivateVotingContract.at(
          addressMod.AztecAddress.fromString(state.voting.address),
          wallet,
        )
      : null
    const l2Bridge = state.crossChain?.bridge0Instance
      ? await bridgeMod.TokenBridgeContract.at(
          addressMod.AztecAddress.fromString(state.crossChain.bridge0),
          wallet,
        )
      : null
    const l2BridgeB = state.crossChain?.l2BridgeBInstance && state.crossChain.l2BridgeB
      ? await bridgeMod.TokenBridgeContract.at(
          addressMod.AztecAddress.fromString(state.crossChain.l2BridgeB),
          wallet,
        )
      : null
    const l2Uniswap = state.crossChain?.l2UniswapInstance && state.crossChain.l2Uniswap
      ? await uniswapMod.UniswapContract.at(
          addressMod.AztecAddress.fromString(state.crossChain.l2Uniswap),
          wallet,
        )
      : null

    onProgress?.('ready')
    return {
      wallet,
      admin: testAccount.address,
      amm,
      token0,
      token1,
      lpToken,
      wrapper,
      crowdfunding,
      publicCrowdfunding,
      perDonorReceipts,
      voting,
      lending,
      ld2,
      l2Bridge,
      l2BridgeB,
      l2Uniswap,
    }
  })()
  cached = promise.catch((e) => {
    cached = null
    throw e
  })
  return cached
}
