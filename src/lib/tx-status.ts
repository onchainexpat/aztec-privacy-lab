// Classify an error thrown by a testnet transaction send.
//
// On Aztec Alpha v4 testnet, block inclusion can lag past the aztec.js
// mine-wait (DefaultWaitOpts.timeout = 300s), so `interaction.send(...)` can
// throw `Timeout awaiting isMined` even though the tx was accepted and will
// land a bit later (observed repeatedly: txs that "timed out" still mined).
// Transient RPC `Failed to fetch` blips are similar. Surfacing these as red
// errors makes a working demo look broken — so callers should treat them as
// PENDING (amber) and tell the visitor to reload, not as failures.

export interface TxOutcome {
  /** True = submitted/in-flight, not a real failure. Show amber, suggest reload. */
  pending: boolean
  message: string
}

export function describeTxError(e: unknown): TxOutcome {
  const raw = e instanceof Error ? `${e.name}: ${e.message}` : String(e)
  const low = raw.toLowerCase()

  // Inclusion lag: the tx was sent but didn't mine within the wait window.
  if (
    low.includes('ismined') ||
    low.includes('timeout awaiting') ||
    low.includes('timeouterror') ||
    low.includes('timed out')
  ) {
    return {
      pending: true,
      message:
        'Submitted — but Aztec testnet inclusion is slow right now, so it did not confirm within the wait window. Your transaction should land within a few minutes; reload the panel to see it. (Nothing failed.)',
    }
  }

  // Transient RPC connectivity.
  if (
    low.includes('failed to fetch') ||
    low.includes('fetch failed') ||
    low.includes('econnrefused') ||
    low.includes('network error') ||
    low.includes('socket hang up')
  ) {
    return {
      pending: true,
      message:
        'Network hiccup talking to the testnet RPC. Your transaction may still have been submitted — reload in a minute to check before retrying.',
    }
  }

  return { pending: false, message: raw }
}
