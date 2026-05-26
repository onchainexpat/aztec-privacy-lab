import { describeTxError } from '../../lib/tx-status'

// Renders a caught testnet-tx error message. Inclusion-lag timeouts and
// transient RPC blips render as amber "submitted / pending — reload" notices
// (the tx likely landed); genuine errors render red. Drop-in replacement for
// the per-panel red <pre>{error}</pre> blocks.
export function TxResult({ message, className = '' }: { message: string; className?: string }) {
  const outcome = describeTxError(message)
  if (outcome.pending) {
    return (
      <p
        className={`mt-3 rounded-lg border border-amber-200 bg-amber-50 p-3 text-xs text-amber-900 ${className}`}
      >
        {outcome.message}
      </p>
    )
  }
  return (
    <pre
      className={`mt-3 max-h-48 overflow-auto rounded-lg border border-rose-200 bg-rose-50 p-3 text-xs text-rose-900 ${className}`}
    >
      {message}
    </pre>
  )
}
