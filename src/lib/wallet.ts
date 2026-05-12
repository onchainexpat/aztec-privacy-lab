// Wallet connection wrapper.
//
// Phase 0 ships a stub: detects whether an Azguard-style in-page RPC provider
// is present on `window.aztec` and surfaces a connect/disconnect API. Real
// WalletConnect wiring lands when the AMM (Phase 1) needs to actually sign.

export interface ConnectedAccount {
  address: string
  source: 'azguard' | 'mock'
}

declare global {
  interface Window {
    aztec?: {
      connect: () => Promise<{ address: string } | string>
      disconnect?: () => Promise<void> | void
    }
  }
}

export function detectInPageWallet(): boolean {
  return typeof window !== 'undefined' && typeof window.aztec?.connect === 'function'
}

export async function connect(): Promise<ConnectedAccount> {
  if (detectInPageWallet()) {
    const res = await window.aztec!.connect()
    const address = typeof res === 'string' ? res : res.address
    return { address, source: 'azguard' }
  }
  throw new Error(
    'No Aztec wallet detected. Install Azguard from the Chrome Web Store and reload.',
  )
}

export async function disconnect(): Promise<void> {
  if (detectInPageWallet() && typeof window.aztec!.disconnect === 'function') {
    await window.aztec!.disconnect!()
  }
}

export function truncateAddress(addr: string): string {
  if (addr.length <= 12) return addr
  return `${addr.slice(0, 6)}…${addr.slice(-4)}`
}
