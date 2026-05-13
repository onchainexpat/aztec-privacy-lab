export type Visibility = 'public' | 'private' | 'na'

export type Verdict = 'buildable' | 'hard' | 'research' | 'blocked'

export interface VariationAxis {
  label: string
  value: Visibility
}

export interface Variation {
  id: 'a' | 'b' | 'c' | 'd' | 'e' | 'f' | 'g' | 'h'
  title: string
  one_liner: string
  verdict: Verdict
  axes: VariationAxis[]
  what_l1_sees: string
  what_observer_sees_on_l2: string
  reason?: string
  source?: { label: string; href: string }
}

export const VERDICTS: Record<Verdict, { label: string; tone: string }> = {
  buildable: { label: 'Buildable today', tone: 'bg-emerald-50 text-emerald-700 border-emerald-200' },
  hard: { label: 'Hard but possible', tone: 'bg-amber-50 text-amber-700 border-amber-200' },
  research: { label: 'Research-grade', tone: 'bg-violet-50 text-violet-700 border-violet-200' },
  blocked: { label: 'Not yet possible', tone: 'bg-rose-50 text-rose-700 border-rose-200' },
}

export const AMM_VARIATIONS: Variation[] = [
  {
    id: 'a',
    title: 'Public reserves · public amounts · private parties',
    one_liner: 'Standard UTXO swap: anyone can see the trade size but not who traded.',
    verdict: 'buildable',
    axes: [
      { label: 'Pool reserves', value: 'public' },
      { label: 'Swap amount in', value: 'public' },
      { label: 'Swap amount out', value: 'public' },
      { label: 'Sender', value: 'private' },
      { label: 'Receiver', value: 'private' },
    ],
    what_l1_sees: 'Nothing — no L1 round-trip in this variation.',
    what_observer_sees_on_l2: 'A pool reserve update of known size. The note commitment that was nullified and the new commitment(s) created, but not who owns them.',
  },
  {
    id: 'f',
    title: 'Public reserves · private LP identity & amount',
    one_liner: 'Total pool depth is public; who deposited how much stays hidden.',
    verdict: 'buildable',
    axes: [
      { label: 'Total reserves', value: 'public' },
      { label: 'LP identity', value: 'private' },
      { label: 'LP amount', value: 'private' },
    ],
    what_l1_sees: 'Nothing.',
    what_observer_sees_on_l2: 'Reserves grow/shrink by a public delta. No address-keyed LP balance map; LP shares live as encrypted notes only the depositor can decrypt.',
  },
  {
    id: 'c',
    title: 'Public reserves · public parties · private amounts',
    one_liner: 'Everyone can see who swapped, no one can see how much.',
    verdict: 'blocked',
    axes: [
      { label: 'Pool reserves', value: 'public' },
      { label: 'Sender', value: 'public' },
      { label: 'Receiver', value: 'public' },
      { label: 'Swap amount', value: 'private' },
    ],
    what_l1_sees: 'N/A',
    what_observer_sees_on_l2: 'Reserves shift by the swap amount on every trade, so observers can subtract `reserves(t+1) - reserves(t)` and recover the supposedly-private size.',
    reason: 'The only way around the reserve-diff leak is batched settlement, where N orders accumulate privately and a single `settle()` aggregates them so reserves jump by the sum (not the individuals). Doing that *trustlessly* needs threshold decryption (validators jointly decrypt sealed bids per epoch, like Penumbra ZSwap) or MPC aggregation — neither of which Aztec ships natively today. With an operator-decryptor it would be a buildable dark pool, but that\'s no longer "no centralized party". Variant h below shows what plain Noir *can* do trustlessly on the same axes.',
  },
  {
    id: 'b',
    title: 'Public reserves · public sender · private amounts',
    one_liner: 'Hide just the trade size, leave the trader visible.',
    verdict: 'blocked',
    axes: [
      { label: 'Pool reserves', value: 'public' },
      { label: 'Sender', value: 'public' },
      { label: 'Amount', value: 'private' },
    ],
    what_l1_sees: 'N/A',
    what_observer_sees_on_l2: 'Pool reserve deltas — which directly reveal the swap size, defeating the privacy goal.',
    reason: 'AMM math (x·y=k) needs the input to deterministically compute the output. With reserves public, hiding the input is impossible without an alternate hidden-state mechanism (see variant c).',
  },
  {
    id: 'd',
    title: 'Everything private (parties, amounts, both tokens)',
    one_liner: 'Pool selection, parties, and amounts all hidden.',
    verdict: 'blocked',
    axes: [
      { label: 'Input token', value: 'private' },
      { label: 'Output token', value: 'private' },
      { label: 'Amount', value: 'private' },
      { label: 'Sender', value: 'private' },
      { label: 'Receiver', value: 'private' },
    ],
    what_l1_sees: 'N/A',
    what_observer_sees_on_l2: 'A single private function call against *some* AMM — observers would see a state update on one specific pool, leaking the token pair.',
    reason: 'Routing in an on-chain AMM requires identifying the pool, which reveals the token pair. Truly hidden routing needs multi-pool batching + an intent layer; that\'s an L2 protocol, not a single contract.',
  },
  {
    id: 'e',
    title: 'Private reserves · slippage-bounded trades',
    one_liner: 'Pool depth hidden; users still get a swap that respects their slippage.',
    verdict: 'research',
    axes: [
      { label: 'Total reserves', value: 'private' },
      { label: 'Per-trade slippage bound', value: 'public' },
    ],
    what_l1_sees: 'N/A',
    what_observer_sees_on_l2: 'A swap occurred and respected some slippage tolerance — but the actual reserves and exchange rate stay hidden behind a Pedersen commitment.',
    reason: 'Open problem: proving "this swap respects the curve" without revealing the curve\'s position. Possible direction: recursive ZK proof of fair pricing against a committed reserve state. Research project, not a contract you can write in an afternoon.',
  },
  {
    id: 'h',
    title: 'Tornado-style swap · fixed denomination · unlinked sender → receiver',
    one_liner:
      'Mixer pool with fixed-size deposits; swap output goes to a fresh address that observers cannot link back to the depositor.',
    verdict: 'buildable',
    axes: [
      { label: 'Pool reserves', value: 'public' },
      { label: 'Swap denomination', value: 'public' },
      { label: 'Depositor address', value: 'public' },
      { label: 'Output recipient address', value: 'public' },
      { label: 'Link depositor → recipient', value: 'private' },
    ],
    what_l1_sees: 'N/A',
    what_observer_sees_on_l2:
      'A deposit tx from Alice (commitment leaf added). Some blocks later, a withdraw-and-swap tx to Bob (nullifier consumed) that updates pool reserves by the fixed denomination. Observers see both endpoints but cannot tell which deposit funded which swap once the anonymity set is non-trivial.',
    reason:
      'Trustless construction: fixed-denomination deposits keep amounts uniform across the anonymity set; a Noir Merkle proof of inclusion lets the recipient prove "I funded one of the N pending deposits" without revealing which one; a nullifier prevents double-spend. No operator, no MPC. The privacy boundary is the size of the anonymity set — small pools leak via timing correlation.',
  },
  {
    id: 'g',
    title: 'Fully private pool (reserves, depositors, swaps)',
    one_liner: 'Total reserves hidden, LP positions hidden, swaps hidden.',
    verdict: 'blocked',
    axes: [
      { label: 'Total reserves', value: 'private' },
      { label: 'LP identity', value: 'private' },
      { label: 'LP amount', value: 'private' },
      { label: 'Swap amount', value: 'private' },
      { label: 'Parties', value: 'private' },
    ],
    what_l1_sees: 'N/A',
    what_observer_sees_on_l2: 'Nothing — but also nothing enforces the invariant.',
    reason: 'Without public reserves, no on-chain logic can enforce x·y=k. The pool collapses to "trust the contract\'s ZK proofs end-to-end," which requires a per-swap recursive proof aggregating all prior pool state — not currently practical at hackathon scale.',
  },
]
