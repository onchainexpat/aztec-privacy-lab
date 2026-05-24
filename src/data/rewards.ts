import type { Verdict, VariationAxis } from './variations'

// Merkl-style private rewards distribution. An app funds a reward pool and
// publishes a Merkle root of (recipient, amount) leaves computed off-chain
// from on-chain activity; users claim by proving Merkle inclusion privately
// and receive rewards into a private note. A per-leaf nullifier prevents
// double-claims. Two techniques here are NOT yet demonstrated elsewhere on the
// dashboard: an in-circuit Merkle inclusion proof, and a private-note payout
// (mint/transfer into an encrypted note so the amount need not leak at claim).

export interface RewardsVariation {
  id: 'r1' | 'r2' | 'r3' | 'r4' | 'r5'
  title: string
  one_liner: string
  verdict: Verdict
  axes: VariationAxis[]
  what_observer_sees: string
  /** New ZK surface area this variant introduces, if any. */
  new_technique?: string
  /** Whether a contract + panel exist yet. All are scoped, none built. */
  built: boolean
  reason?: string
}

export const REWARDS_VARIATIONS: RewardsVariation[] = [
  {
    id: 'r1',
    title: 'Public budget + root · private claimants · private amounts',
    one_liner:
      'App publishes a Merkle root of (recipient, amount); users prove inclusion privately and are paid into a private note.',
    verdict: 'buildable',
    built: false,
    axes: [
      { label: 'Reward budget', value: 'public' },
      { label: 'Merkle root', value: 'public' },
      { label: 'Claimant identity', value: 'private' },
      { label: 'Claim amount', value: 'private' },
    ],
    new_technique:
      'In-circuit Merkle inclusion proof inside a private function + private-note payout (mint/transfer into an encrypted note, so the amount never lands in public state).',
    what_observer_sees:
      'A public reward budget and a single Merkle root. Each claim consumes an opaque leaf nullifier and bumps a claim counter — observers learn that someone in the set claimed, but not who or how much. Scales to thousands of recipients with one on-chain commitment (vs one-per-recipient in the payroll variant).',
  },
  {
    id: 'r2',
    title: 'Public rewards table · private claim',
    one_liner:
      'The full (address -> amount) table is public for transparency; whether/when a given user claims stays private.',
    verdict: 'buildable',
    built: false,
    axes: [
      { label: 'Rewards table', value: 'public' },
      { label: 'Merkle root', value: 'public' },
      { label: 'Claimant identity', value: 'private' },
      { label: 'Claim amount', value: 'public' },
    ],
    what_observer_sees:
      'Everyone can audit the campaign: every recipient and entitlement is public. The privacy gain is on the claim side — the act of claiming runs through a private function, so linking a payout to a specific wallet/session is hidden. Good for transparent incentive programs that still want unlinkable redemption.',
  },
  {
    id: 'r3',
    title: 'Vested / streaming rewards · private periodic claims',
    one_liner:
      'Rewards accrue per epoch; each periodic claim is private and nullified per (leaf, epoch).',
    verdict: 'buildable',
    built: false,
    axes: [
      { label: 'Schedule / epoch', value: 'public' },
      { label: 'Per-claim amount', value: 'private' },
      { label: 'Claimant identity', value: 'private' },
    ],
    new_technique:
      'Per-epoch nullifier domain (same idea as the payroll period) layered on the Merkle-inclusion claim, so the same allocation can be drawn down across epochs without linkable repeats.',
    what_observer_sees:
      'A public epoch counter and root. Each epoch a recipient privately claims their vested slice; observers see a per-epoch claim count, never the schedule-to-wallet mapping or the slice sizes.',
  },
  {
    id: 'r4',
    title: 'Fully private budget · private claims',
    one_liner:
      'Total budget and the leaves are hidden; the contract proves sum(claims) <= budget without revealing the table.',
    verdict: 'research',
    built: false,
    axes: [
      { label: 'Reward budget', value: 'private' },
      { label: 'Merkle root', value: 'private' },
      { label: 'Claimant identity', value: 'private' },
      { label: 'Claim amount', value: 'private' },
    ],
    what_observer_sees:
      'Only an opaque commitment to the root. Nothing about the budget or claims is public.',
    reason:
      'No native way to enforce sum(claims) <= a hidden budget. Each claim would need a recursive proof carrying the running total, or a separate aggregate-conservation circuit — the unified note/nullifier tree does not give cross-claim conservation for free. Research-grade.',
  },
  {
    id: 'r5',
    title: 'Private eligibility from private on-chain activity',
    one_liner:
      'Reward earned by qualifying private activity (e.g., private swaps); claimant proves they did it without revealing the activity.',
    verdict: 'blocked',
    built: false,
    axes: [
      { label: 'Qualifying activity', value: 'private' },
      { label: 'Claimant identity', value: 'private' },
      { label: 'Reward paid', value: 'public' },
    ],
    what_observer_sees:
      'A reward payout, with no link to the private behaviour that earned it.',
    reason:
      "Eligibility derived from a user's private history requires proving over past private notes/nullifiers, which Aztec does not expose to application circuits today (no general note-history proofs). The off-chain root model (r1) sidesteps this by having the app compute eligibility from observable activity; deriving it from the user's OWN private state is not yet possible.",
  },
]
