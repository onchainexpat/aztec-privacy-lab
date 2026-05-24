import type { Verdict, VariationAxis } from './variations'

// Merkl-style private rewards distribution. An app funds a reward pool and
// publishes a Merkle root over (recipient, amount) leaves computed off-chain
// from on-chain activity; users claim by proving Merkle inclusion privately.
// One root commits to the whole campaign. Two techniques here are new to the
// rest of the board: an in-circuit Merkle inclusion proof, and a
// private-RECIPIENT payout (partial note) — see the honest boundary below on
// why the payout AMOUNT can't also be hidden under contract custody.
//
// r1/r2/r3 are the same deployed Rewards contract (different claim entry points
// + a period field), the way the AMM covers variants a/f with one pool.

export interface RewardsVariation {
  id: 'r1' | 'r2' | 'r3' | 'r4' | 'r5'
  title: string
  one_liner: string
  verdict: Verdict
  axes: VariationAxis[]
  what_observer_sees: string
  /** New ZK surface area this variant introduces, if any. */
  new_technique?: string
  /** Whether the deployed Rewards contract implements this variant. */
  built: boolean
  reason?: string
}

export const REWARDS_VARIATIONS: RewardsVariation[] = [
  {
    id: 'r1',
    title: 'Private claim · private-recipient payout',
    one_liner:
      'Prove Merkle inclusion privately and pay into a partial note, so the recipient address is hidden.',
    verdict: 'buildable',
    built: true,
    axes: [
      { label: 'Merkle root', value: 'public' },
      { label: 'Claimant identity', value: 'private' },
      { label: 'Recipient', value: 'private' },
      { label: 'Payout amount', value: 'public' },
    ],
    new_technique:
      'In-circuit Merkle inclusion proof (root_from_sibling_path / poseidon2) inside a private function, plus a private-recipient payout via transfer_to_private (partial note hides who receives).',
    what_observer_sees:
      'A public reward budget and a single Merkle root. A claim consumes an opaque leaf and moves a visible amount out of the pool into SOMEONE\'s private note — observers see the amount but not which eligible member claimed nor who received it. claim_private on the deployed contract.',
  },
  {
    id: 'r2',
    title: 'Private claim · public payout',
    one_liner:
      'Same inclusion proof, paid to a visible recipient. The claimant\'s eligible identity still stays hidden.',
    verdict: 'buildable',
    built: true,
    axes: [
      { label: 'Merkle root', value: 'public' },
      { label: 'Claimant identity', value: 'private' },
      { label: 'Recipient', value: 'public' },
      { label: 'Payout amount', value: 'public' },
    ],
    what_observer_sees:
      'Amount + recipient are public at claim (or send to a burner to break the link). The privacy gain is the anonymity set: observers learn someone in the tree claimed, not who. claim_public on the deployed contract.',
  },
  {
    id: 'r3',
    title: 'Vested / recurring campaigns (periods)',
    one_liner:
      'The operator advances a period and republishes a root; the same (recipient, amount) becomes a fresh leaf each cycle.',
    verdict: 'buildable',
    built: true,
    axes: [
      { label: 'Schedule / period', value: 'public' },
      { label: 'Claimant identity', value: 'private' },
      { label: 'Payout amount', value: 'public' },
    ],
    new_technique:
      'Period is folded into the leaf (poseidon2(addr, amount, period)) and checked on claim, so recurring campaigns reuse the same allocation without linkable repeats and old leaves stay independently claimed.',
    what_observer_sees:
      'A public period counter + per-period root. Each cycle a recipient privately claims their slice; observers see a per-period claim count, never the schedule-to-wallet mapping.',
  },
  {
    id: 'r4',
    title: 'Amount-private payout / fully private budget',
    one_liner:
      'Hide the payout amount itself (and ultimately the total budget), not just identities.',
    verdict: 'research',
    built: false,
    axes: [
      { label: 'Reward budget', value: 'private' },
      { label: 'Claimant identity', value: 'private' },
      { label: 'Payout amount', value: 'private' },
    ],
    what_observer_sees:
      'Ideally nothing but an opaque commitment. In practice the amount leaks (see reason).',
    reason:
      'The pool is custodied in public balance, so every release moves a VISIBLE amount out of public state — even transfer_to_private finalizes the amount in a public call. Hiding the amount needs contract-owned private notes or supply-hiding; enforcing sum(claims) <= a hidden budget needs a per-claim recursive conservation proof. Research-grade.',
  },
  {
    id: 'r5',
    title: 'Eligibility from the user\'s own private activity',
    one_liner:
      'Reward earned by qualifying private activity (e.g. private swaps); prove you did it without revealing it.',
    verdict: 'blocked',
    built: false,
    axes: [
      { label: 'Qualifying activity', value: 'private' },
      { label: 'Claimant identity', value: 'private' },
      { label: 'Reward paid', value: 'public' },
    ],
    what_observer_sees: 'A reward payout with no link to the private behaviour that earned it.',
    reason:
      "Deriving eligibility from a user's OWN private history requires proving over past private notes/nullifiers, which Aztec does not expose to application circuits today (no general note-history proofs). The off-chain-root model (r1/r2) sidesteps this by computing eligibility from observable activity.",
  },
]
