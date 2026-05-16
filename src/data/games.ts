import type { Verdict, VariationAxis } from './variations'

export interface GameVariation {
  id: 'g1' | 'g2' | 'g3'
  title: string
  one_liner: string
  verdict: Verdict
  axes: VariationAxis[]
  what_observer_sees: string
  trust_caveat?: string
  reason?: string
}

export const GAME_VARIATIONS: GameVariation[] = [
  {
    id: 'g1',
    title: 'Minesweeper · contract-RNG board',
    one_liner:
      'Pay-to-play single-player Minesweeper. Contract pseudo-randomly places mines from on-chain entropy; player reveals one cell at a time.',
    verdict: 'hard',
    axes: [
      { label: 'Player identity', value: 'public' },
      { label: 'Board layout', value: 'private' },
      { label: 'Reveal history', value: 'public' },
    ],
    what_observer_sees:
      'A start_game tx (visible payer + block-derived seed) followed by a series of reveal(x, y) calls. Each reveal updates a public revealed-cells map and emits hit/miss. The board itself lives in contract-owned private notes.',
    trust_caveat:
      'On-chain RNG limitation: anyone who knows the contract address can derive its viewing key AND recompute the seed from (sender, block, nonce). A determined attacker can reconstruct the full board before the player reveals it. Honest demo of "what pseudo-random feels like in practice"; not for stakes. Production version would need a VRF oracle.',
  },
  {
    id: 'g2',
    title: 'Battleship · single-player vs contract',
    one_liner:
      'Fleet of 5 ships placed on a 10×10 board from contract seed. Player fires shots; contract reports miss / hit / sunk.',
    verdict: 'hard',
    axes: [
      { label: 'Player identity', value: 'public' },
      { label: 'Ship positions', value: 'private' },
      { label: 'Shot history', value: 'public' },
    ],
    what_observer_sees:
      'A start_game tx, then a sequence of fire(x, y) calls. Each fire bumps a public shots-taken counter and emits an outcome. Hits per ship accumulate publicly so observers can tell when a ship was sunk. The fleet placement is in contract-owned private notes.',
    trust_caveat:
      'Same on-chain RNG limitation as g1 — board is technically encrypted but the decryption key is derivable from the contract address. The variant is a useful demo of Aztec storage primitives; the privacy story is honest about the leak.',
  },
  {
    id: 'g3',
    title: 'Battleship · PvP commit-reveal (trustless)',
    one_liner:
      'Two players, two boards, no contract-side randomness. Each player commits to their own fleet hash; shots prove hit/miss in ZK without revealing the rest.',
    verdict: 'research',
    axes: [
      { label: 'Each player identity', value: 'public' },
      { label: 'Each player fleet', value: 'private' },
      { label: 'Shot outcomes', value: 'public' },
    ],
    what_observer_sees:
      "Two commit txs (one per player) with fleet hashes. Then alternating fire / answer txs — each answer comes with a ZK proof that the response is consistent with the committed fleet. Observers see who's winning but never see ship positions.",
    reason:
      'Fully trustless and the most interesting privacy story, but the matchmaking UI alone (pair two browsers, manage turns, sync the encrypted boards) is a sub-project. Tracked as research-grade; ship when g1/g2 prove the contract pattern.',
  },
]
