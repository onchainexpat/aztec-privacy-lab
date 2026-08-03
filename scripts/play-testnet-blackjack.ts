/**
 * Play one full Blackjack hand on Aztec testnet using the deployer account as
 * BOTH player and dealer (the dealer is operator-gated, so a random visitor
 * can't run start_hand - this mirrors the single-session sandbox demo). Proves
 * the fair+private blackjack works on real testnet end-to-end.
 *
 *   TESTNET_SECRET=0x... TESTNET_SALT=0x... TESTNET_SIGNING=0x... \
 *     npm run testnet:play-blackjack
 *
 * The player stands on the two hole cards; the dealer auto-plays (hit until 17).
 */
import { readFileSync } from 'node:fs'
import { dirname, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

import { EmbeddedWallet } from '@aztec/wallets/embedded'
import { createAztecNodeClient } from '@aztec/aztec.js/node'
import { Fr, Fq } from '@aztec/aztec.js/fields'
import { AztecAddress } from '@aztec/stdlib/aztec-address'
import { SponsoredFPCContract } from '@aztec/noir-contracts.js/SponsoredFPC'
import { SponsoredFeePaymentMethod } from '@aztec/aztec.js/fee'
import { getContractInstanceFromInstantiationParams } from '@aztec/aztec.js/contracts'
import { SPONSORED_FPC_SALT } from '@aztec/constants'
import { jsonParseWithSchema } from '@aztec/foundation/json-rpc'
import { ContractInstanceWithAddressSchema } from '@aztec/stdlib/contract'
import { poseidon2Hash } from '@aztec/foundation/crypto/sync'

import { BlackjackContract } from '../src/contracts/Blackjack'
import {
  buildDeck,
  cardLabel,
  handTotal,
  DEALER_BASE,
  PLAYER_BASE,
  MAX_CARDS,
  DECK_DEPTH,
} from '../src/lib/blackjack-deck'

const TESTNET_URL = process.env.TESTNET_URL ?? 'https://v5.testnet.rpc.aztec-labs.com'
const __dirname = dirname(fileURLToPath(import.meta.url))
const stateFile = resolve(__dirname, '..', 'public', 'testnet-state.json')
const OUTCOMES = ['Dealer wins', 'Player wins', 'Push']

function log(...a: unknown[]) {
  // eslint-disable-next-line no-console
  console.log('[bj-testnet]', ...a)
}
function fr(n: string, h: string | undefined): Fr {
  if (!h) throw new Error(`missing env ${n}`)
  return Fr.fromString(h.startsWith('0x') ? h : `0x${h}`)
}
function fq(n: string, h: string | undefined): Fq {
  if (!h) throw new Error(`missing env ${n}`)
  return Fq.fromString(h.startsWith('0x') ? h : `0x${h}`)
}
async function sponsoredFPC() {
  const inst = await getContractInstanceFromInstantiationParams(SponsoredFPCContract.artifact, {
    salt: new Fr(SPONSORED_FPC_SALT),
  })
  return inst
}

async function main() {
  const state = JSON.parse(readFileSync(stateFile, 'utf8'))
  if (!state.blackjack) throw new Error('blackjack not in testnet-state (run testnet:deploy-blackjack)')

  const node = createAztecNodeClient(TESTNET_URL)
  log('node', (await node.getNodeInfo()).nodeVersion)
  const wallet = await EmbeddedWallet.create(node, { ephemeral: true, pxe: { proverEnabled: true } })
  const fpc = await sponsoredFPC()
  await wallet.registerContract(fpc, SponsoredFPCContract.artifact)
  const feeOpts = { paymentMethod: new SponsoredFeePaymentMethod(fpc.address) }

  await wallet.createSchnorrAccount(
    fr('TESTNET_SECRET', process.env.TESTNET_SECRET),
    fr('TESTNET_SALT', process.env.TESTNET_SALT),
    fq('TESTNET_SIGNING', process.env.TESTNET_SIGNING),
  )
  const me = AztecAddress.fromStringUnsafe(state.deployer)
  log('playing as deployer (player + dealer):', me.toString())

  // Attach the deployed Blackjack contract.
  const inst = jsonParseWithSchema(JSON.stringify(state.blackjack.instance), ContractInstanceWithAddressSchema)
  await wallet.registerContract(inst, BlackjackContract.artifact)
  const bj = await BlackjackContract.at(AztecAddress.fromStringUnsafe(state.blackjack.address), wallet)

  // Build a fresh game.
  const gameId = Fr.random()
  const playerSeed = Fr.random()
  const dealerSeed = Fr.random()
  const deckSalt = Fr.random()
  const combined = poseidon2Hash([playerSeed, dealerSeed])
  const deck = buildDeck(combined.toString(), deckSalt.toString())

  log('commit…')
  await bj.methods.commit(gameId, poseidon2Hash([playerSeed])).send({ from: me, fee: feeOpts })
  log('start_hand…')
  await bj.methods
    .start_hand(gameId, poseidon2Hash([dealerSeed]), Fr.fromString(deck.root), deckSalt)
    .send({ from: me, fee: feeOpts })

  // Player stands on the two hole cards (positions 0,1).
  const playerCards = [PLAYER_BASE, PLAYER_BASE + 1]
  const pVals = playerCards.map((p) => deck.order[p])
  log('player hand:', pVals.map(cardLabel).join(' '), '=', handTotal(pVals))

  // Dealer auto-play: hit until 17.
  const dealerCards = [DEALER_BASE, DEALER_BASE + 1]
  while (handTotal(dealerCards.map((p) => deck.order[p])) < 17 && dealerCards.length < MAX_CARDS) {
    dealerCards.push(DEALER_BASE + dealerCards.length)
  }
  const dVals = dealerCards.map((p) => deck.order[p])
  log('dealer hand:', dVals.map(cardLabel).join(' '), '=', handTotal(dVals))

  const ZERO_PATH = Array(DECK_DEPTH).fill(Fr.ZERO)
  const pad = (positions: number[]) => {
    const cards: bigint[] = []
    const paths: Fr[][] = []
    for (let i = 0; i < MAX_CARDS; i++) {
      if (i < positions.length) {
        cards.push(BigInt(deck.order[positions[i]]))
        paths.push(deck.proofs[positions[i]].siblingPath.map((s) => Fr.fromString(s)))
      } else {
        cards.push(0n)
        paths.push(ZERO_PATH)
      }
    }
    return { cards, paths }
  }
  const p = pad(playerCards)
  const d = pad(dealerCards)

  log('settle (private proof: Merkle-verify cards + score)…')
  await bj.methods
    .settle(
      gameId,
      Fr.fromString(deck.root),
      deckSalt,
      p.cards,
      playerCards.length,
      p.paths,
      d.cards,
      dealerCards.length,
      d.paths,
    )
    .send({ from: me, fee: feeOpts })

  const [oc, pt, dt] = await Promise.all([
    bj.methods.get_outcome(gameId).simulate({ from: me }),
    bj.methods.get_player_total(gameId).simulate({ from: me }),
    bj.methods.get_dealer_total(gameId).simulate({ from: me }),
  ])
  log('=== RESULT ===')
  log(`${OUTCOMES[Number(oc.result)]} — player ${Number(pt.result)}, dealer ${Number(dt.result)}`)
  log('(only these totals + outcome are public on testnet; the cards stayed private witnesses)')

  await wallet.stop()
}

main().then(
  () => process.exit(0),
  (err) => {
    console.error('[bj-testnet] FAILED:', err)
    process.exit(1)
  },
)
