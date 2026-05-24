import type { Verdict, VariationAxis } from './variations'

export interface GameVariation {
  id: 'g1' | 'g2' | 'g3' | 'g4' | 'g5' | 'g6' | 'g7'
  title: string
  one_liner: string
  verdict: Verdict
  /**
   * Implementation state — independent of `verdict` (which is about feasibility).
   *   'shipped'  — Noir contract deployed + interactive panel wired
   *   'planned'  — buildable today, designed but not yet implemented
   *   'research' — needs new primitives/infra (also flagged via verdict: 'research')
   */
  status?: 'shipped' | 'planned' | 'research'
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
    status: 'shipped',
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
    status: 'shipped',
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
      'Two players, two hidden fleets, no contract-side randomness or trusted operator. Each player commits a fleet hash; the defender proves hit/miss against it in a private function, revealing only the boolean.',
    verdict: 'buildable',
    status: 'shipped',
    axes: [
      { label: 'Each player identity', value: 'public' },
      { label: 'Each player fleet', value: 'private' },
      { label: 'Shot outcomes', value: 'public' },
    ],
    what_observer_sees:
      "Two commit txs (one per player) with fleet hashes. Then alternating fire (public) / answer (private) txs — each answer carries a ZK proof that the hit/miss boolean is consistent with the committed fleet. Observers see who's winning but never the ship positions.",
    reason:
      "The genuinely trustless privacy story: no contract-RNG, no operator. The defender re-opens their committed fleet as private inputs each answer; the public phase binds the boolean to the stored commitment so they can't move ships to dodge. Demo plays both players from one browser for convenience (UI shortcut) - the on-chain privacy is real either way. Production would also constrain ship-placement validity inside the commitment circuit + add real two-PXE matchmaking.",
  },
  {
    id: 'g4',
    title: 'Blackjack · fair + private vs online dealer',
    one_liner:
      'Combined-entropy commit-reveal shuffles a deck the dealer commits as a Merkle root. You can\'t see future cards, the dealer can\'t swap them, and at showdown your hand is a ZK witness — only your total + the outcome go public.',
    verdict: 'buildable',
    status: 'shipped',
    axes: [
      { label: 'Player hand', value: 'private' },
      { label: 'Player decisions', value: 'private' },
      { label: 'Final total', value: 'public' },
      { label: 'Dealer hand', value: 'public' },
    ],
    what_observer_sees:
      'A committed deck Merkle root + the player\'s two commit txs. At showdown a private settle proves every player card is the committed card at its dealing position and publishes ONLY the total + win/lose/push — the player\'s individual cards never reach public state.',
    reason:
      'Solves the single-player RNG problem honestly: neither side alone picks the shuffle (combined commit-reveal), the deck is committed so the dealer can\'t cheat mid-hand, and the player can\'t see ahead (never learns the dealer\'s seed during play). Cards are Merkle-verified in-circuit at showdown. Caveat: needs the dealer online to deal cards; fully-trustless shuffling is mental-poker (research-grade). Shipped on sandbox.',
  },
  {
    id: 'g5',
    title: 'Sealed-bid auction',
    one_liner:
      "Place a bid as a private commitment. Reveal window opens; only the bids you choose to publish reach public state. Bids you keep sealed stay private forever - something Solidity can't do without an MPC operator.",
    verdict: 'buildable',
    status: 'shipped',
    axes: [
      { label: 'Bidder identity', value: 'private' },
      { label: 'Bid amount', value: 'private' },
      { label: 'Winning bid', value: 'public' },
      { label: 'Losing bids', value: 'private' },
    ],
    what_observer_sees:
      'A public list of bid commitments (each is a private note nullifier — opaque). At close, a single reveal tx surfaces the highest bid + winner. All other bids stay encrypted in their bidders\' PXEs; observers never learn who else bid or how much.',
    reason:
      "Cleanest pure-Aztec privacy showcase. Each bid is a user-owned private note (genuinely hidden — not contract-owned). At reveal, only the winner has to open. Losers' bids are nullified without disclosure. Buildable today; not yet implemented.",
  },
  {
    id: 'g6',
    title: 'Wordle · daily puzzle with private guesses',
    one_liner:
      'Public daily target hash; each guess emits a private commitment. Operator reveals target at day-end; solvers can prove which attempt they got right without exposing failed guesses.',
    verdict: 'buildable',
    status: 'shipped',
    axes: [
      { label: 'Target word', value: 'public' },
      { label: 'Player guess history', value: 'private' },
      { label: 'Completion + rank', value: 'public' },
    ],
    what_observer_sees:
      'A public daily challenge (committed hash of the target word, revealed at end-of-day cron). Each player makes guess txs that store the guess as a private note + emit a public "guess #N submitted" event. At day end, players can optionally reveal their path to prove a fast solve. The actual letters guessed stay private otherwise.',
    reason:
      "Solid showcase of 'gameplay history stays private even on a public chain.' Each player's guess history is their own private notes — observers can see WHEN you played, not WHAT you guessed. Buildable today; not yet implemented.",
  },
  {
    id: 'g7',
    title: 'Private lottery · anonymous tickets',
    one_liner:
      'Buy a ticket privately - each ticket is a commitment to (player, number, salt). Operator draws via commit-reveal; the contract also emits an L2->L1 hook so the draw can be upgraded to Chainlink VRF using the same portal pattern as variant h. Winners claim publicly; non-winners stay anonymous - the anonymity set is all ticket holders.',
    verdict: 'buildable',
    status: 'shipped',
    axes: [
      { label: 'Ticket holders', value: 'private' },
      { label: 'Ticket numbers', value: 'private' },
      { label: 'Winning number', value: 'public' },
      { label: 'Winner identity', value: 'public' },
    ],
    what_observer_sees:
      "A public counter of opaque ticket commitments. At draw time the operator reveals the previously-committed seed; the contract derives the winning number deterministically. Only winners reveal (number, salt) to claim. Non-winners' tickets stay encrypted in their PXEs forever - observers cannot enumerate ticket holders.",
    reason:
      "Sandbox uses operator commit-reveal for randomness; the contract also emits an L2->L1 message at request_draw as a hook for upgrading to real Chainlink VRF (same L1 portal pattern as variant h Uniswap or variant i Base bridge). The privacy story - anonymity set of ticket holders - holds under either RNG source.",
  },
]
