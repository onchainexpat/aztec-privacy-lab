// Off-chain deck for the Blackjack contract. The deck is a Merkle tree whose
// leaf at position i is poseidon2([card_i, i, deck_salt]) - matching the
// in-circuit verification in contracts/blackjack. The shuffle is a
// deterministic function of the combined seed so it can be audited after the
// dealer reveals dealer_seed.

import { Fr } from '@aztec/aztec.js/fields'
import { poseidon2Hash } from '@aztec/foundation/crypto/sync'

export const DECK_DEPTH = 6
export const DECK_LEAVES = 1 << DECK_DEPTH // 64 (covers a 52-card deck)
export const DECK_SIZE = 52
export const MAX_CARDS = 5

// Player is dealt deck positions 0..4 (hole 0,1; hits 2,3,4); dealer 5..9.
export const PLAYER_BASE = 0
export const DEALER_BASE = MAX_CARDS

export interface CardProof {
  position: number
  card: number
  siblingPath: string[]
}

export interface Deck {
  /** Shuffled card values (0..51) by position. */
  order: number[]
  /** Merkle root (0x hex) of the committed deck. */
  root: string
  /** Proof per position (0..DECK_LEAVES-1). */
  proofs: CardProof[]
  saltHex: string
}

function leafHash(card: number, position: number, salt: Fr): Fr {
  return poseidon2Hash([new Fr(BigInt(card)), new Fr(BigInt(position)), salt])
}

// Deterministic Fisher-Yates shuffle of [0..51] driven by poseidon2(seed, i).
export function shuffleDeck(combinedSeedHex: string): number[] {
  const seed = Fr.fromString(combinedSeedHex)
  const order = Array.from({ length: DECK_SIZE }, (_, i) => i)
  for (let i = DECK_SIZE - 1; i > 0; i--) {
    const r = poseidon2Hash([seed, new Fr(BigInt(i))]).toBigInt()
    const j = Number(r % BigInt(i + 1))
    ;[order[i], order[j]] = [order[j], order[i]]
  }
  return order
}

export function buildDeck(combinedSeedHex: string, deckSaltHex: string): Deck {
  const order = shuffleDeck(combinedSeedHex)
  const salt = Fr.fromString(deckSaltHex)
  // Leaves for all DECK_LEAVES positions (pad >=52 with card 0).
  const leaves: Fr[] = []
  for (let i = 0; i < DECK_LEAVES; i++) {
    leaves.push(leafHash(i < DECK_SIZE ? order[i] : 0, i, salt))
  }
  const levels: Fr[][] = [leaves]
  let cur = leaves
  while (cur.length > 1) {
    const next: Fr[] = []
    for (let i = 0; i < cur.length; i += 2) next.push(poseidon2Hash([cur[i], cur[i + 1]]))
    levels.push(next)
    cur = next
  }
  const root = levels[levels.length - 1][0].toString()

  const proofs: CardProof[] = []
  for (let pos = 0; pos < DECK_LEAVES; pos++) {
    const siblingPath: string[] = []
    let idx = pos
    for (let level = 0; level < DECK_DEPTH; level++) {
      siblingPath.push(levels[level][idx ^ 1].toString())
      idx = idx >> 1
    }
    proofs.push({ position: pos, card: pos < DECK_SIZE ? order[pos] : 0, siblingPath })
  }
  return { order, root, proofs, saltHex: deckSaltHex }
}

// --- card display + scoring (mirror of contracts/blackjack/src/cards.nr) ---

const RANKS = ['A', '2', '3', '4', '5', '6', '7', '8', '9', '10', 'J', 'Q', 'K']
const SUITS = ['♠', '♥', '♦', '♣'] // spades hearts diamonds clubs

export function cardLabel(card: number): string {
  return `${RANKS[card % 13]}${SUITS[Math.floor(card / 13) % 4]}`
}

function baseValue(card: number): number {
  const rank = card % 13
  if (rank === 0) return 11
  if (rank <= 8) return rank + 1
  return 10
}

export function handTotal(cards: number[]): number {
  let total = 0
  let aces = 0
  for (const c of cards) {
    total += baseValue(c)
    if (c % 13 === 0) aces++
  }
  while (total > 21 && aces > 0) {
    total -= 10
    aces--
  }
  return total
}
