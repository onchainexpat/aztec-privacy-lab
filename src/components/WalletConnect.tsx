import { useState } from 'react'
import { connect, disconnect, truncateAddress, type ConnectedAccount } from '../lib/wallet'

interface Props {
  account: ConnectedAccount | null
  onChange: (account: ConnectedAccount | null) => void
}

export function WalletConnect({ account, onChange }: Props) {
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<string | null>(null)

  async function handleConnect() {
    setError(null)
    setBusy(true)
    try {
      const acc = await connect()
      onChange(acc)
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e))
    } finally {
      setBusy(false)
    }
  }

  async function handleDisconnect() {
    setBusy(true)
    try {
      await disconnect()
      onChange(null)
    } finally {
      setBusy(false)
    }
  }

  if (account) {
    return (
      <button
        onClick={handleDisconnect}
        disabled={busy}
        className="rounded-full border border-black/10 bg-white px-3 py-1.5 font-mono text-sm hover:bg-black/5"
        title="Click to disconnect"
      >
        <span className="mr-2 inline-block size-2 rounded-full bg-[var(--color-private)]" />
        {truncateAddress(account.address)}
      </button>
    )
  }

  return (
    <div className="flex flex-col items-end">
      <button
        onClick={handleConnect}
        disabled={busy}
        className="rounded-full bg-[var(--color-ink)] px-4 py-1.5 text-sm font-medium text-[var(--color-paper)] hover:opacity-90 disabled:opacity-50"
      >
        {busy ? 'Connecting…' : 'Connect wallet'}
      </button>
      {error && <p className="mt-1 max-w-xs text-right text-xs text-[var(--color-blocked)]">{error}</p>}
    </div>
  )
}
