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
      'Two players, two boards, no contract-side randomness. Each player commits to their own fleet hash; shots prove hit/miss in ZK without revealing the rest.',
    verdict: 'research',
    status: 'research',
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
  {
    id: 'g4',
    title: 'Blackjack · player vs deterministic dealer',
    one_liner:
      'Hole cards dealt to the player as their OWN private notes (genuinely hidden — encrypted to player pubkey, not contract). Dealer follows a fixed rule from a public seed; player decides hit/stand and reveals at showdown.',
    verdict: 'buildable',
    status: 'planned',
    axes: [
      { label: 'Player hand', value: 'private' },
      { label: 'Dealer hand', value: 'public' },
      { label: 'Player decisions', value: 'private' },
      { label: 'Final score', value: 'public' },
    ],
    what_observer_sees:
      'Bet + dealer face-up card public. A sequence of player private function calls (hit/stand) — only the action type is visible, not the resulting hand. At showdown the player reveals a ZK proof: "given my hole cards + my hit history, my final total is N (≤21 or busted)." Contract verifies + settles.',
    reason:
      'The strongest single-player Aztec demo: the player\'s hand lives in their own private notes (encrypted to their pubkey, NOT the contract\'s), so observers truly cannot see the hand mid-game. Dealer rules are deterministic ("hit until 17") so no RNG needed beyond the initial public shuffle seed. Buildable today; not yet implemented.',
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
    title: 'Private lottery · anonymous tickets + VRF draw',
    one_liner:
      'Buy a ticket privately (number stored as your private note). Chainlink VRF on L1 draws the winning number. Winners claim publicly; non-winners stay anonymous — even the list of ticket-holders can be hidden.',
    verdict: 'buildable',
    status: 'planned',
    axes: [
      { label: 'Ticket holders', value: 'private' },
      { label: 'Ticket numbers', value: 'private' },
      { label: 'Winning number', value: 'public' },
      { label: 'Winner identity', value: 'public' },
    ],
    what_observer_sees:
      'A public counter of ticket commitments (each is a private note nullifier). VRF request emitted as an L2→L1 message via portal; VRF callback returns the winning number as an L1→L2 message. Only the winner reveals to claim — losers stay anonymous, their ticket numbers stay encrypted in their PXEs.',
    reason:
      "First legitimate use of Chainlink VRF in this matrix — the public winning number is fine to be public; the private property is the anonymity set of ticket holders. Single-user demo: buy a ticket, wait for VRF, see your private note still encrypted whether you won or lost. Buildable today; not yet implemented.",
  },
]
