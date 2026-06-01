import type { Verdict, VariationAxis } from './variations'

export interface LendingVariation {
  id: 'ld1' | 'ld2' | 'ld3' | 'ld4'
  title: string
  one_liner: string
  verdict: Verdict
  axes: VariationAxis[]
  what_observer_sees: string
  reason?: string
}

export const LENDING_VARIATIONS: LendingVariation[] = [
  {
    id: 'ld1',
    title: 'Private collateral · private debt (secret-keyed position)',
    one_liner:
      'Position keyed by a secret only the borrower holds. Anyone with the secret can deposit, borrow, repay, withdraw.',
    verdict: 'buildable',
    axes: [
      { label: 'Borrower identity', value: 'private' },
      { label: 'Collateral amount', value: 'private' },
      { label: 'Debt amount', value: 'private' },
    ],
    what_observer_sees:
      'A private tx hit the Lending contract. The on-chain position is keyed by hash(secret, on_behalf_of, msg_sender) — no address-keyed map. Observers cannot link the position to a wallet without the secret.',
  },
  {
    id: 'ld2',
    title: 'Public collateral · private debt (shielded debt)',
    one_liner:
      'Deposit collateral publicly against a commitment, then borrow privately against the same commitment. Debt amounts and borrower identity stay hidden.',
    verdict: 'buildable',
    axes: [
      { label: 'Depositor identity', value: 'public' },
      { label: 'Collateral amount', value: 'public' },
      { label: 'Borrower identity', value: 'private' },
      { label: 'Debt amount', value: 'private' },
    ],
    what_observer_sees:
      'Public deposit event: depositor address + amount + commitment. Public LTV update on borrow: commitment + new total debt. Hidden: which wallet drew the debt, that the depositor and borrower are the same person (unless the commitment is reused observably).',
    reason:
      'Custom Noir contract: position is keyed by commitment = pedersen(secret, owner). Deposits transfer collateral publicly. The borrow function takes the secret privately, reconstructs the commitment, enqueues a public LTV check, and uses Token.mint_to_private to issue the debt as a private note. Bundled Lending can\'t do this in one position — slots for deposit_public and borrow_private have incompatible keys.',
  },
  {
    id: 'ld3',
    title: 'Fully public lending (Aave baseline)',
    one_liner:
      'Standard public deposit + borrow. No privacy. Useful as the control case to demonstrate the privacy delta.',
    verdict: 'buildable',
    axes: [
      { label: 'Borrower identity', value: 'public' },
      { label: 'Collateral amount', value: 'public' },
      { label: 'Debt amount', value: 'public' },
    ],
    what_observer_sees:
      'Address-keyed positions in public state — full Aave-style transparency. Liquidations trivial to compute.',
  },
  {
    id: 'ld4',
    title: 'Fully private · public-only liquidation triggers',
    one_liner:
      'Positions and amounts hidden, but anyone can liquidate an under-collateralized position via a ZK proof.',
    verdict: 'research',
    axes: [
      { label: 'Borrower identity', value: 'private' },
      { label: 'Collateral amount', value: 'private' },
      { label: 'Debt amount', value: 'private' },
      { label: 'Liquidation trigger', value: 'public' },
    ],
    what_observer_sees:
      'A liquidation tx with a ZK proof that "some position is under-collateralized at current oracle price" but no information about which one. Requires a fresh in-circuit price and a recursive position-scan circuit — open research.',
    reason:
      'No production implementation on Aztec yet, and the missing primitive is now better understood. Liquidating a hidden position needs a fresh price inside the circuit, but private oracle reads on Aztec face a privacy / freshness / contention trilemma (per Nethermind\'s Q1 2026 oracle exploration): a push oracle (price written to a contract) leaks read patterns and contends on a shared public slot, while a pull oracle (consumer fetches) struggles to prove the price is fresh without revealing the read. Combined with the recursive position-scan circuit an anonymous liquidator would need, this stays research-grade — the bundled Lending contract supports private positions but not anonymous-liquidator scanning.',
  },
]
