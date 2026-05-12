// Wallet connection wrapper.
//
// Uses @azguardwallet/client to talk to the Azguard browser extension via its
// in-page RPC bridge. The extension exposes `window.azguard.createClient()`
// asynchronously after content scripts load — `AzguardClient.create()` waits
// for that with a configurable timeout.
//
// What this surfaces today: detect + connect + show address + disconnect.
// What it does NOT yet do: route the interactive demos' deposit/borrow calls
// through Azguard's `client.execute([{kind: 'send_transaction', ...}])`. The
// per-tab Schnorr account path in browser-testnet.ts is still the only way to
// interact with the contracts. Both can coexist; the Connect button is purely
// informational for now.

import { AzguardClient } from '@azguardwallet/client'

export interface ConnectedAccount {
  /** Plain hex address (the part after the chain prefix). */
  address: string
  /** Full CAIP-2 account identifier, e.g. "aztec:4127419662:0x088514…". */
  caipAccount: string
  source: 'azguard'
}

/** Testnet rollup version (Aztec Alpha v4 on Sepolia). Confirmed via
 *  node_getNodeInfo against rpc.testnet.aztec-labs.com. CaipChain format is
 *  `aztec:<rollupVersion>`, see @azguardwallet/types dapp-session.d.ts. */
const TESTNET_CHAIN = 'aztec:4127419662'

const DAPP_METADATA = {
  name: 'Aztec Privacy Lab',
  description: 'Noir privacy-variation playground on Aztec Alpha v4',
  url: typeof window !== 'undefined' ? window.location.origin : '',
}

/** Operations the dashboard requests permission for. `call` covers simulate;
 *  `send_transaction` lets us submit. `register_contract` so we can register
 *  the testnet AZA / AZB / ld2 instances in the wallet's PXE. */
const REQUIRED_OPS = ['send_transaction', 'simulate_views', 'register_contract', 'call']

let client: AzguardClient | null = null

async function getClient(): Promise<AzguardClient> {
  if (client) return client
  const isInstalled = await AzguardClient.isAzguardInstalled(2000)
  if (!isInstalled) {
    throw new Error(
      'No Aztec wallet detected. Install Azguard from the Chrome Web Store ' +
        '(pliilpflcmabdiapdeihifihkbdfnbmn) and reload.',
    )
  }
  client = await AzguardClient.create()
  return client
}

export async function connect(): Promise<ConnectedAccount> {
  const c = await getClient()
  if (!c.connected) {
    await c.connect(DAPP_METADATA, [{ chains: [TESTNET_CHAIN], methods: REQUIRED_OPS }])
  }
  const caipAccount = c.accounts[0]
  if (!caipAccount) {
    throw new Error('Wallet connected but no accounts approved.')
  }
  // CAIP account format is `aztec:<rollupVersion>:0x<address>`. Strip prefix.
  const address = caipAccount.split(':').at(-1) ?? caipAccount
  return { address, caipAccount, source: 'azguard' }
}

export async function disconnect(): Promise<void> {
  if (!client) return
  try {
    await client.disconnect()
  } catch {
    // ignore
  }
}

export function truncateAddress(addr: string): string {
  if (addr.length <= 12) return addr
  return `${addr.slice(0, 6)}…${addr.slice(-4)}`
}
