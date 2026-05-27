/**
 * Sandbox bootstrap: deploys two Token contracts and an AMM to the local
 * Aztec sandbox, mints private balances to a pre-funded test account, and
 * writes addresses to public/sandbox-state.json so the dashboard can read them.
 *
 *   npm run sandbox:setup
 */
import { mkdirSync, writeFileSync } from 'node:fs'
import { dirname, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

import { EmbeddedWallet } from '@aztec/wallets/embedded'
import { getInitialTestAccountsData } from '@aztec/accounts/testing/lazy'
import { createAztecNodeClient } from '@aztec/aztec.js/node'
import { TokenContract } from '@aztec/noir-contracts.js/Token'
import { AMMContract } from '@aztec/noir-contracts.js/AMM'
import { CrowdfundingContract } from '@aztec/noir-contracts.js/Crowdfunding'
import { LendingContract } from '@aztec/noir-contracts.js/Lending'
import { PriceFeedContract } from '@aztec/noir-contracts.js/PriceFeed'
import { UniswapContract } from '@aztec/noir-contracts.js/Uniswap'
import { TokenBridgeContract } from '@aztec/noir-contracts.js/TokenBridge'
import { EthAddress } from '@aztec/aztec.js/addresses'
import { PrivateSwapWrapperContract } from '../src/contracts/PrivateSwapWrapper'
import { PublicTotalCrowdfundingContract } from '../src/contracts/PublicTotalCrowdfunding'
import { PerDonorReceiptsContract } from '../src/contracts/PerDonorReceipts'
import { PublicCollateralPrivateDebtContract } from '../src/contracts/PublicCollateralPrivateDebt'
import { PrivateVotingContract } from '@aztec/noir-contracts.js/PrivateVoting'
import { MinesweeperContract } from '../src/contracts/Minesweeper'
import { BattleshipContract } from '../src/contracts/Battleship'
import { SealedBidAuctionContract } from '../src/contracts/SealedBidAuction'
import { WordleContract } from '../src/contracts/Wordle'
import { LotteryContract } from '../src/contracts/Lottery'
import { IdentityAttestationContract } from '../src/contracts/IdentityAttestation'
import { BatchPayContract } from '../src/contracts/BatchPay'
import { GoodsEscrowContract } from '../src/contracts/GoodsEscrow'
import { BattleshipPvPContract } from '../src/contracts/BattleshipPvP'
import { PayrollContract } from '../src/contracts/Payroll'
import { RewardsContract } from '../src/contracts/Rewards'
import { BlackjackContract } from '../src/contracts/Blackjack'
import { AnonymousVotingContract } from '../src/contracts/AnonymousVoting'
import { buildRewardsTree, type RewardEntry } from '../src/lib/rewards-merkle'
import { buildEligibleTree } from '../src/lib/voting-merkle'
import { jsonStringify } from '@aztec/foundation/json-rpc'

const SANDBOX_URL = process.env.SANDBOX_URL ?? 'http://localhost:8090'

const __dirname = dirname(fileURLToPath(import.meta.url))
const stateFile = resolve(__dirname, '..', 'public', 'sandbox-state.json')

function log(...args: unknown[]) {
  // eslint-disable-next-line no-console
  console.log('[setup-sandbox]', ...args)
}

async function main() {
  log('connecting to', SANDBOX_URL)
  const node = createAztecNodeClient(SANDBOX_URL)
  // Persistent on-disk PXE so follow-up scripts (seed-and-swap, etc.) can
  // attach to these contracts via the shared wallet DB.
  const wallet = await EmbeddedWallet.create(node)

  const [testAccount] = await getInitialTestAccountsData()
  log('registering test account…')
  await wallet.createSchnorrAccount(testAccount.secret, testAccount.salt, testAccount.signingKey)
  const admin = testAccount.address
  log('admin =', admin.toString())

  log('deploying Token AZA…')
  const { contract: token0 } = await TokenContract.deploy(
    wallet,
    admin,
    'AztecA',
    'AZA',
    18,
  ).send({ from: admin })
  log('Token0 (AZA) at', token0.address.toString())

  log('deploying Token AZB…')
  const { contract: token1 } = await TokenContract.deploy(
    wallet,
    admin,
    'AztecB',
    'AZB',
    18,
  ).send({ from: admin })
  log('Token1 (AZB) at', token1.address.toString())

  log('deploying LP Token AZLP…')
  const { contract: lpToken } = await TokenContract.deploy(
    wallet,
    admin,
    'AztecLP',
    'AZLP',
    18,
  ).send({ from: admin })
  log('LP token at', lpToken.address.toString())

  log('deploying AMM(token0, token1, lp)…')
  const { contract: amm } = await AMMContract.deploy(
    wallet,
    token0.address,
    token1.address,
    lpToken.address,
  ).send({ from: admin })
  log('AMM at', amm.address.toString())

  log('granting AMM minter rights on LP token…')
  await lpToken.methods.set_minter(amm.address, true).send({ from: admin })

  log('deploying PrivateSwapWrapper (variant c building block)…')
  const { contract: wrapper } = await PrivateSwapWrapperContract.deploy(wallet).send({
    from: admin,
  })
  log('PrivateSwapWrapper at', wrapper.address.toString())

  log('deploying PriceFeed + Lending (phase 3)…')
  const { contract: priceFeed } = await PriceFeedContract.deploy(wallet).send({ from: admin })
  log('PriceFeed at', priceFeed.address.toString())
  // Lending math uses 1e9 price precision. price=1e9 → 1 collateral = 1 stable.
  const PRICE_1_FOR_1 = 1_000_000_000n
  await priceFeed.methods.set_price(0n, PRICE_1_FOR_1).send({ from: admin })

  const { contract: lending } = await LendingContract.deploy(wallet).send({ from: admin })
  log('Lending at', lending.address.toString())
  // 80% LTV (basis points → out of 10_000)
  await lending.methods
    .init(priceFeed.address, 8_000n, token0.address, token1.address)
    .send({ from: admin })
  // Lending mints stable_coin (AZB) when borrowers borrow.
  await token1.methods.set_minter(lending.address, true).send({ from: admin })

  log('deploying PublicCollateralPrivateDebt (lending variant ld2)…')
  const { contract: ld2 } = await PublicCollateralPrivateDebtContract.deploy(
    wallet,
    token0.address,
    token1.address,
    admin,
  ).send({ from: admin })
  log('PublicCollateralPrivateDebt at', ld2.address.toString())
  // ld2 mints debt token (AZB) privately to borrowers.
  await token1.methods.set_minter(ld2.address, true).send({ from: admin })

  log('deploying Crowdfunding (phase 4 launchpad demo)…')
  const deadlineSec = BigInt(Math.floor(Date.now() / 1000) + 60 * 60 * 24 * 30) // 30 days
  const { contract: crowdfunding } = await CrowdfundingContract.deploy(
    wallet,
    token0.address,
    admin,
    deadlineSec,
  ).send({ from: admin })
  log('Crowdfunding at', crowdfunding.address.toString(), 'deadline=', deadlineSec.toString())

  log('deploying L2-side bridges + Uniswap (phase 2 — L1 portals TBD)…')
  const PLACEHOLDER_PORTAL = EthAddress.fromString(
    '0x000000000000000000000000000000000000dead',
  )
  const { contract: bridge0 } = await TokenBridgeContract.deploy(
    wallet,
    token0.address,
    PLACEHOLDER_PORTAL,
  ).send({ from: admin })
  const { contract: bridge1 } = await TokenBridgeContract.deploy(
    wallet,
    token1.address,
    PLACEHOLDER_PORTAL,
  ).send({ from: admin })
  const { contract: l2Uniswap } = await UniswapContract.deploy(wallet, PLACEHOLDER_PORTAL).send({
    from: admin,
  })
  log('Bridge(AZA) at', bridge0.address.toString())
  log('Bridge(AZB) at', bridge1.address.toString())
  log('L2 Uniswap at', l2Uniswap.address.toString())

  log('deploying PublicTotalCrowdfunding (lp2)…')
  const { contract: publicCrowdfunding } = await PublicTotalCrowdfundingContract.deploy(
    wallet,
    token0.address,
    admin,
  ).send({ from: admin })
  log('PublicTotalCrowdfunding at', publicCrowdfunding.address.toString())

  log('deploying PerDonorReceipts (lp3)…')
  const { contract: perDonorReceipts } = await PerDonorReceiptsContract.deploy(
    wallet,
    token0.address,
    admin,
  ).send({ from: admin })
  log('PerDonorReceipts at', perDonorReceipts.address.toString())

  log('deploying PrivateVoting + opening the demo election…')
  const { contract: voting } = await PrivateVotingContract.deploy(wallet, admin).send({
    from: admin,
  })
  log('PrivateVoting at', voting.address.toString())
  const DEMO_ELECTION_ID = 1n
  await voting.methods.start_vote({ id: DEMO_ELECTION_ID }).send({ from: admin })
  log('election', DEMO_ELECTION_ID.toString(), 'started')

  log('deploying Minesweeper (games variant g1)…')
  const { contract: minesweeper } = await MinesweeperContract.deploy(
    wallet,
    token0.address, // payment token = AZA
    admin,
  ).send({ from: admin })
  log('Minesweeper at', minesweeper.address.toString())

  log('deploying Battleship (games variant g2)…')
  const { contract: battleship } = await BattleshipContract.deploy(
    wallet,
    token0.address,
    admin,
  ).send({ from: admin })
  log('Battleship at', battleship.address.toString())

  // For Wordle we need pedersenHash to compute the challenge commitment.
  const { pedersenHash } = await import('@aztec/foundation/crypto/sync')
  const { Fr } = await import('@aztec/aztec.js/fields')

  log('deploying SealedBidAuction (games variant g5)…')
  // L2 block timestamps drift ahead of wall-clock on a sandbox that's been
  // running for a while — use the latest L2 block ts as the baseline so the
  // contract's `self.context.timestamp()` check matches our expectations.
  const latestHeader = await node.getBlockHeader()
  const l2NowSec =
    latestHeader && latestHeader.globalVariables
      ? Number((latestHeader.globalVariables as { timestamp: bigint }).timestamp)
      : Math.floor(Date.now() / 1000)
  // Fast-cycle windows for sandbox testing: 10 min bid + 10 min reveal.
  // Sandbox L2 advances ahead of wall-clock so we need extra slack.
  const auctionBidDeadline = BigInt(l2NowSec + 600)
  const auctionRevealDeadline = auctionBidDeadline + 600n
  // Off-chain item description hashed for the on-chain commitment. The actual
  // text lives in the panel; the hash just binds the demo to a known item.
  const auctionItemHash = 1n
  const { contract: auction } = await SealedBidAuctionContract.deploy(
    wallet,
    admin,
    auctionItemHash,
    auctionBidDeadline,
    auctionRevealDeadline,
  ).send({ from: admin })
  log('SealedBidAuction at', auction.address.toString())

  log('deploying Wordle (games variant g6)…')
  // Pack a 5-letter target into a single Field. "aztec" is the demo target;
  // production would generate this off-chain per day from a curated list.
  function packWord(word: string): bigint {
    if (word.length !== 5) throw new Error('word must be 5 letters')
    let packed = 0n
    for (let i = 0; i < 5; i++) {
      packed = packed * 256n + BigInt(word.charCodeAt(i))
    }
    return packed
  }
  const wordleTarget = 'aztec'
  const wordleTargetPacked = packWord(wordleTarget)
  const wordleSalt = Fr.random()
  const wordleChallengeHash = pedersenHash([wordleTargetPacked, wordleSalt])
  // Fast-cycle windows: 10 min guess + 10 min reveal.
  const wordleGuessDeadline = BigInt(l2NowSec + 600)
  const wordleRevealDeadline = wordleGuessDeadline + 600n
  const { contract: wordle } = await WordleContract.deploy(
    wallet,
    admin,
    wordleChallengeHash.toBigInt(),
    wordleGuessDeadline,
    wordleRevealDeadline,
  ).send({ from: admin })
  log('Wordle at', wordle.address.toString(), '(target =', wordleTarget, ')')

  log('deploying Lottery (games variant g7)…')
  // Operator commits to a random seed; revealed at finalize_draw. Sandbox
  // path. The L1 VRF portal slot is wired to a zero address - real VRF lands
  // when the L1 portal is deployed (variant h pattern).
  const lotterySeed = Fr.random()
  const lotterySalt = Fr.random()
  const lotterySeedCommitment = pedersenHash([lotterySeed, lotterySalt])
  const { contract: lottery } = await LotteryContract.deploy(
    wallet,
    token0.address,
    admin,
    EthAddress.ZERO,
    lotterySeedCommitment.toBigInt(),
  ).send({ from: admin })
  log('Lottery at', lottery.address.toString())

  log('deploying IdentityAttestation (anonymous credential primitive)…')
  const { contract: attestation } = await IdentityAttestationContract.deploy(
    wallet,
    admin, // issuer = admin in this demo
  ).send({ from: admin })
  log('IdentityAttestation at', attestation.address.toString())

  // Pre-issue three credentials so the demo has something to prove against
  // immediately. Each (secret, hash) lives in the operator's PXE in real
  // life; we publish them in state.json so the dashboard demo can complete
  // the cycle end-to-end.
  const attestationSecrets: { secret: string; commitment: string }[] = []
  for (let i = 0; i < 3; i++) {
    const secret = Fr.random()
    const commitment = pedersenHash([secret])
    await attestation.methods.add_credential(commitment.toBigInt()).send({ from: admin })
    attestationSecrets.push({
      secret: secret.toString(),
      commitment: commitment.toString(),
    })
  }
  log('  pre-issued', attestationSecrets.length, 'credentials')

  log('deploying AnonymousVoting (eligibility-gated, composes with attestation)…')
  const VOTE_CANDIDATES = ['Raise the quorum', 'Keep as-is', 'Abstain']
  const { contract: anonVoting } = await AnonymousVotingContract.deploy(
    wallet,
    admin,
    VOTE_CANDIDATES.length,
  ).send({ from: admin })
  log('AnonymousVoting at', anonVoting.address.toString())
  // Eligible voters = holders of the attestation credentials above (same
  // secrets), so the two primitives genuinely compose. Publish the Merkle root.
  const eligibleSecrets = attestationSecrets.map((c) => c.secret)
  const { root: eligibleRoot } = buildEligibleTree(eligibleSecrets)
  await anonVoting.methods
    .publish_eligible_root(Fr.fromString(eligibleRoot).toBigInt())
    .send({ from: admin })
  log('  published eligible root for', eligibleSecrets.length, 'voters')

  log('deploying BatchPay (nested private composability demo)…')
  const { contract: batchPay } = await BatchPayContract.deploy(
    wallet,
    token0.address,
  ).send({ from: admin })
  log('BatchPay at', batchPay.address.toString())

  log('deploying GoodsEscrow (zkp2p-style P2P escrow)…')
  // attestor = admin in this demo (stands in for a zkEmail/zkTLS verifier).
  const { contract: goodsEscrow } = await GoodsEscrowContract.deploy(
    wallet,
    token0.address, // USDC = AZA in the demo
    admin,
  ).send({ from: admin })
  log('GoodsEscrow at', goodsEscrow.address.toString())

  log('deploying BattleshipPvP (games variant g3 - trustless PvP)…')
  const { contract: battleshipPvp } = await BattleshipPvPContract.deploy(wallet).send({
    from: admin,
  })
  log('BattleshipPvP at', battleshipPvp.address.toString())

  log('deploying Payroll (confidential payroll register)…')
  // operator = admin; in this demo the same account also plays the employee.
  const { contract: payroll } = await PayrollContract.deploy(
    wallet,
    token0.address, // payroll currency = AZA (USDC stand-in)
    admin,
  ).send({ from: admin })
  log('Payroll at', payroll.address.toString())
  // Fund the pool directly by minting public AZA to the contract (setup
  // shortcut — the panel's fund() path exercises the authwit-gated deposit).
  const PAYROLL_FUND = 50_000n
  await token0.methods.mint_to_public(payroll.address, PAYROLL_FUND).send({ from: admin })
  // Publish a few payslips for period 0. Each commitment binds (employee,
  // amount, period); only an opaque field lands on chain. employee = admin in
  // this single-session demo. Amounts/salts would live only in the operator's
  // PXE in a real deploy; we publish them so the dashboard can complete claims.
  const payrollPeriod = 0n
  const payrollAmounts = [3200n, 4500n, 2750n]
  const payrollPayslips: { amount: string; period: string; commitment: string }[] = []
  for (const amount of payrollAmounts) {
    const commitment = pedersenHash([admin.toField(), new Fr(amount), new Fr(payrollPeriod)])
    await payroll.methods.add_payslip(commitment.toBigInt()).send({ from: admin })
    payrollPayslips.push({
      amount: amount.toString(),
      period: payrollPeriod.toString(),
      commitment: commitment.toString(),
    })
  }
  log('  funded', PAYROLL_FUND.toString(), 'AZA, published', payrollPayslips.length, 'payslips')

  log('deploying Rewards (Merkl-style private rewards)…')
  const { contract: rewards } = await RewardsContract.deploy(
    wallet,
    token0.address, // reward token = AZA
    admin,
  ).send({ from: admin })
  log('Rewards at', rewards.address.toString())
  const REWARDS_FUND = 100_000n
  await token0.methods.mint_to_public(rewards.address, REWARDS_FUND).send({ from: admin })
  // Campaign tree for period 0. admin is entry 0 (claimable in this demo); the
  // rest are random addresses that make up the anonymity set.
  const rewardsPeriod = 0n
  const rewardsEntries: RewardEntry[] = [
    { address: admin.toString(), amount: '5000' },
    { address: Fr.random().toString(), amount: '3000' },
    { address: Fr.random().toString(), amount: '7000' },
    { address: Fr.random().toString(), amount: '1500' },
  ]
  const { root: rewardsRoot } = buildRewardsTree(rewardsEntries, rewardsPeriod)
  await rewards.methods.publish_root(Fr.fromString(rewardsRoot).toBigInt()).send({ from: admin })
  log('  funded', REWARDS_FUND.toString(), 'AZA, published root for', rewardsEntries.length, 'leaves')

  log('deploying Blackjack (fair + private vs dealer)…')
  // dealer = admin in this demo; games are created per session (no seed at setup).
  const { contract: blackjack } = await BlackjackContract.deploy(wallet, admin).send({ from: admin })
  log('Blackjack at', blackjack.address.toString())

  log('minting balances to admin…')
  const MINT = 1_000_000n
  await token0.methods.mint_to_private(admin, MINT).send({ from: admin })
  await token1.methods.mint_to_private(admin, MINT).send({ from: admin })
  // Also mint a public stack of AZA so we can exercise the public-lending
  // (variant ld3) flow without a private→public transfer first.
  const MINT_PUBLIC = 200_000n
  await token0.methods.mint_to_public(admin, MINT_PUBLIC).send({ from: admin })
  log('minted', MINT.toString(), 'each (private), +', MINT_PUBLIC.toString(), 'public AZA')

  const { result: bal0 } = await token0.methods.balance_of_private(admin).simulate({ from: admin })
  const { result: bal1 } = await token1.methods.balance_of_private(admin).simulate({ from: admin })
  log('admin private balances: AZA =', bal0, 'AZB =', bal1)

  // Serialize each contract's full instance (salt + publicKeys + classIds)
  // so a fresh PXE (e.g., in the browser) can rehydrate and register them.
  async function instanceJSON(address: typeof admin) {
    const meta = await wallet.getContractMetadata(address)
    if (!meta.instance) throw new Error('instance missing for ' + address.toString())
    return JSON.parse(jsonStringify(meta.instance))
  }

  const state = {
    sandboxUrl: SANDBOX_URL,
    deployer: admin.toString(),
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
    privateSwapWrapper: {
      address: wrapper.address.toString(),
      instance: await instanceJSON(wrapper.address),
    },
    priceFeed: {
      address: priceFeed.address.toString(),
      instance: await instanceJSON(priceFeed.address),
      price: PRICE_1_FOR_1.toString(),
    },
    lending: {
      address: lending.address.toString(),
      instance: await instanceJSON(lending.address),
      collateralAsset: 'AZA',
      stableCoin: 'AZB',
      loanToValueBps: '8000',
    },
    publicCollateralPrivateDebt: {
      address: ld2.address.toString(),
      instance: await instanceJSON(ld2.address),
      collateralAsset: 'AZA',
      debtAsset: 'AZB',
      ltvNumerator: '50',
      ltvDenominator: '100',
    },
    crowdfunding: {
      address: crowdfunding.address.toString(),
      instance: await instanceJSON(crowdfunding.address),
      donationToken: 'AZA',
      operator: admin.toString(),
      deadline: deadlineSec.toString(),
    },
    publicCrowdfunding: {
      address: publicCrowdfunding.address.toString(),
      instance: await instanceJSON(publicCrowdfunding.address),
      donationToken: 'AZA',
      operator: admin.toString(),
    },
    perDonorReceipts: {
      address: perDonorReceipts.address.toString(),
      instance: await instanceJSON(perDonorReceipts.address),
      donationToken: 'AZA',
      operator: admin.toString(),
    },
    voting: {
      address: voting.address.toString(),
      instance: await instanceJSON(voting.address),
      admin: admin.toString(),
      electionId: DEMO_ELECTION_ID.toString(),
    },
    minesweeper: {
      address: minesweeper.address.toString(),
      instance: await instanceJSON(minesweeper.address),
      paymentToken: 'AZA',
      operator: admin.toString(),
    },
    battleship: {
      address: battleship.address.toString(),
      instance: await instanceJSON(battleship.address),
      paymentToken: 'AZA',
      operator: admin.toString(),
    },
    sealedBidAuction: {
      address: auction.address.toString(),
      instance: await instanceJSON(auction.address),
      operator: admin.toString(),
      itemHash: auctionItemHash.toString(),
      bidDeadline: auctionBidDeadline.toString(),
      revealDeadline: auctionRevealDeadline.toString(),
    },
    wordle: {
      address: wordle.address.toString(),
      instance: await instanceJSON(wordle.address),
      operator: admin.toString(),
      // Store target + salt so the operator (us, in this demo) can reveal at
      // the deadline. In a real deploy these would only live in the operator's
      // PXE, NOT in the shared state file.
      targetWord: wordleTarget,
      targetPacked: wordleTargetPacked.toString(),
      targetSalt: wordleSalt.toString(),
      guessDeadline: wordleGuessDeadline.toString(),
      revealDeadline: wordleRevealDeadline.toString(),
    },
    lottery: {
      address: lottery.address.toString(),
      instance: await instanceJSON(lottery.address),
      operator: admin.toString(),
      // Seed + salt would live ONLY in the operator's PXE in a real deploy;
      // we store them here so the dashboard demo can complete the cycle.
      seed: lotterySeed.toString(),
      salt: lotterySalt.toString(),
      seedCommitment: lotterySeedCommitment.toString(),
      maxNumber: '100',
    },
    anonymousVoting: {
      address: anonVoting.address.toString(),
      instance: await instanceJSON(anonVoting.address),
      operator: admin.toString(),
      numCandidates: VOTE_CANDIDATES.length,
      candidates: VOTE_CANDIDATES,
      eligibleRoot,
      // Demo: the eligible voters' secrets, so the sandbox panel can derive a
      // Merkle proof + vote. In a real deploy these live only in each holder's
      // wallet (same as the attestation credential secrets).
      eligibleSecrets,
    },
    attestation: {
      address: attestation.address.toString(),
      instance: await instanceJSON(attestation.address),
      issuer: admin.toString(),
      // Secrets would live ONLY in each credential holder's PXE in real
      // life. The demo publishes them so a single browser session can
      // play both the issuer + the prover roles.
      credentials: attestationSecrets,
    },
    batchPay: {
      address: batchPay.address.toString(),
      instance: await instanceJSON(batchPay.address),
      paymentToken: 'AZA',
    },
    goodsEscrow: {
      address: goodsEscrow.address.toString(),
      instance: await instanceJSON(goodsEscrow.address),
      paymentToken: 'AZA',
      attestor: admin.toString(),
    },
    battleshipPvp: {
      address: battleshipPvp.address.toString(),
      instance: await instanceJSON(battleshipPvp.address),
    },
    payroll: {
      address: payroll.address.toString(),
      instance: await instanceJSON(payroll.address),
      paymentToken: 'AZA',
      operator: admin.toString(),
      // Demo: the same account is registered as the employee for every payslip.
      employee: admin.toString(),
      period: payrollPeriod.toString(),
      payslips: payrollPayslips,
    },
    rewards: {
      address: rewards.address.toString(),
      instance: await instanceJSON(rewards.address),
      paymentToken: 'AZA',
      operator: admin.toString(),
      period: rewardsPeriod.toString(),
      root: rewardsRoot,
      // Campaign leaves (address, amount). The panel rebuilds the tree from
      // these to derive its own Merkle proof. entry 0 is this demo account.
      entries: rewardsEntries,
    },
    blackjack: {
      address: blackjack.address.toString(),
      instance: await instanceJSON(blackjack.address),
      dealer: admin.toString(),
    },
    crossChain: {
      bridge0: bridge0.address.toString(),
      bridge1: bridge1.address.toString(),
      l2Uniswap: l2Uniswap.address.toString(),
      placeholderPortal: PLACEHOLDER_PORTAL.toString(),
    },
    initialPrivateBalances: { AZA: bal0.toString(), AZB: bal1.toString() },
    deployedAt: new Date().toISOString(),
  }

  mkdirSync(dirname(stateFile), { recursive: true })
  writeFileSync(stateFile, JSON.stringify(state, null, 2))
  log('wrote', stateFile)

  await wallet.stop()
}

main().then(
  () => process.exit(0),
  (err) => {
    console.error('[setup-sandbox] FAILED:', err)
    process.exit(1)
  },
)
