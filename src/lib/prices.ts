// Hardcoded "fake market" prices so the demo balances feel real. azETH at
// $2500, azUSDC at $1. The on-chain amounts are unitless — they're just
// integers in the Token contract — so the conversion is purely cosmetic.
//
// Token decimal: 18, but we mint with small absolute amounts (10k, 5k, etc.)
// and treat them as whole units, not 1e-18. So formatUSD(10000n, 'azETH')
// gives $25,000,000 — match what the dashboard already shows for balances.

export const PRICES: Record<string, number> = {
  azETH: 2500,
  azUSDC: 1,
}

export function formatUSD(amount: bigint | number, symbol: string): string {
  const price = PRICES[symbol]
  if (price === undefined) return ''
  const value = Number(amount) * price
  if (value === 0) return '$0'
  if (value < 0.01) return '<$0.01'
  if (value < 1) return `$${value.toFixed(2)}`
  if (value < 1_000) return `$${value.toFixed(value < 10 ? 2 : 0)}`
  if (value < 1_000_000) return `$${(value / 1_000).toFixed(value < 10_000 ? 2 : 1)}k`
  return `$${(value / 1_000_000).toFixed(2)}M`
}
