import type { Verdict, VariationAxis } from './variations'

export interface LaunchpadVariation {
  id: 'lp1' | 'lp2' | 'lp3'
  title: string
  one_liner: string
  verdict: Verdict
  axes: VariationAxis[]
  what_observer_sees: string
  reason?: string
}

export const LAUNCHPAD_VARIATIONS: LaunchpadVariation[] = [
  {
    id: 'lp1',
    title: 'Fully private raise',
    one_liner:
      'Total raised, contributor identities, and per-contributor amounts all stored as private notes.',
    verdict: 'buildable',
    axes: [
      { label: 'Total raised', value: 'private' },
      { label: 'Contributor identity', value: 'private' },
      { label: 'Contribution amount', value: 'private' },
    ],
    what_observer_sees:
      'A donation tx happened against the Crowdfunding address. The amount, the donor, and the running total all stay in private notes. The operator alone can sum the notes when withdrawing.',
  },
  {
    id: 'lp2',
    title: 'Public total · private contributors',
    one_liner:
      "Running total accumulates publicly so anyone can verify the raise; donors stay private.",
    verdict: 'buildable',
    axes: [
      { label: 'Total raised', value: 'public' },
      { label: 'Contributor identity', value: 'private' },
      { label: 'Contribution amount', value: 'public' },
    ],
    what_observer_sees:
      'Each donation lands in the contract\'s public AZA balance and bumps a public total_raised counter. The donor calls a private function that pulls from their private balance via transfer_to_public — their address never appears in any public log. Custom Noir contract (PublicTotalCrowdfunding) authored in this repo.',
  },
  {
    id: 'lp3',
    title: 'Public total · public per-contributor amounts · private identities',
    one_liner: 'Public per-contributor receipts (hashed addresses) so contributors can prove participation later.',
    verdict: 'buildable',
    axes: [
      { label: 'Total raised', value: 'public' },
      { label: 'Amount per contributor', value: 'public' },
      { label: 'Contributor identity', value: 'private' },
    ],
    what_observer_sees:
      'Each donation writes a public receipt slot keyed by pedersen_hash(donor_addr, donor_salt) -> amount. Anyone can read every receipt; linking a receipt to a wallet requires the donor\'s salt. Custom Noir contract (PerDonorReceipts) authored in this repo.',
  },
]
