import { AMM_VARIATIONS, type Variation } from '../data/variations'
import { VariationCard } from './VariationCard'
import { MatrixHeader } from './ui/MatrixHeader'

interface Props {
  onTry?: (id: Variation['id']) => void
}

export function PrivacyMatrix({ onTry }: Props) {
  return (
    <section>
      <MatrixHeader
        title="Uniswap V2 in Noir — privacy matrix"
        subtitle="Eight design points along the public/private axis. Three ship on testnet today (a, f, lp1); one is in build (h, tornado-style mixer); the rest are blocked or research-grade, each with the technical reason spelled out."
      />
      <div className="grid grid-cols-1 gap-4 md:grid-cols-2 lg:grid-cols-3">
        {AMM_VARIATIONS.map((v) => (
          <VariationCard key={v.id} variation={v} onTry={onTry} />
        ))}
      </div>
    </section>
  )
}
