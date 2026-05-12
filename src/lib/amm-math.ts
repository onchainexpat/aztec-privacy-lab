// Constant-product (Uniswap V2) helpers for the dashboard. Mirrors what the
// bundled AMM's get_amount_out_for_exact_in computes on-chain, so we can show
// price impact + spot price in the UI without round-tripping to the contract
// for every keystroke.
//
// The bundled AMM uses a 0.3% fee (997/1000 multiplier) on swaps, same as
// classic Uniswap V2.

const FEE_NUMERATOR = 997n
const FEE_DENOMINATOR = 1000n

/** Spot price = how many `out` tokens per 1 unit of `in` token, ignoring fees
 *  and slippage. Returned as a decimal number for UI display. */
export function spotPrice(reserveIn: bigint, reserveOut: bigint): number {
  if (reserveIn === 0n) return 0
  return Number(reserveOut) / Number(reserveIn)
}

/** Uniswap V2 output amount for an exact input, after the 0.3% fee. */
export function getAmountOut(
  amountIn: bigint,
  reserveIn: bigint,
  reserveOut: bigint,
): bigint {
  if (amountIn <= 0n || reserveIn <= 0n || reserveOut <= 0n) return 0n
  const amountInWithFee = amountIn * FEE_NUMERATOR
  const numerator = amountInWithFee * reserveOut
  const denominator = reserveIn * FEE_DENOMINATOR + amountInWithFee
  return numerator / denominator
}

/** Effective execution price = amountOut / amountIn. */
export function effectivePrice(amountIn: bigint, amountOut: bigint): number {
  if (amountIn === 0n) return 0
  return Number(amountOut) / Number(amountIn)
}

/** Price impact as a positive number 0..1, where 0 = "took spot price, no
 *  slippage" and 0.05 = "5% worse than spot". This is the headline number to
 *  surface to traders — "your trade moves the price by X %". */
export function priceImpact(
  amountIn: bigint,
  reserveIn: bigint,
  reserveOut: bigint,
): number {
  const spot = spotPrice(reserveIn, reserveOut)
  if (spot === 0) return 0
  const out = getAmountOut(amountIn, reserveIn, reserveOut)
  const effective = effectivePrice(amountIn, out)
  return Math.max(0, 1 - effective / spot)
}

/** Pretty 4-significant-figures string for a decimal price. */
export function formatPrice(p: number): string {
  if (!Number.isFinite(p) || p === 0) return '—'
  if (p >= 1000) return p.toFixed(0)
  if (p >= 100) return p.toFixed(1)
  if (p >= 10) return p.toFixed(2)
  if (p >= 1) return p.toFixed(3)
  if (p >= 0.01) return p.toFixed(4)
  return p.toExponential(2)
}

export function formatPct(p: number): string {
  const pct = p * 100
  if (pct < 0.01) return '<0.01%'
  if (pct < 1) return `${pct.toFixed(3)}%`
  if (pct < 10) return `${pct.toFixed(2)}%`
  return `${pct.toFixed(1)}%`
}
