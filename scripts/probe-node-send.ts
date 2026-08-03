/**
 * Probe whether tx SENDS propagate, by deploying a fresh ephemeral account
 * (a real tx that must reach a sequencer to mine) through different node setups:
 *
 *   MODE=ours   npx tsx scripts/probe-node-send.ts   # our node only — expect HANG (P2P off)
 *   MODE=split  npx tsx scripts/probe-node-send.ts   # split: reads→ours, sends→public — expect MINE
 *   MODE=public npx tsx scripts/probe-node-send.ts   # public RPC — baseline, expect MINE
 *
 * Confirms (a) our P2P-disabled node can't propagate sends, and (b) the split
 * node fix actually mines a send while reading state from our node.
 */
import { EmbeddedWallet } from '@aztec/wallets/embedded'
import { createAztecNodeClient } from '@aztec/aztec.js/node'
import { Fr, Fq } from '@aztec/aztec.js/fields'
import { SponsoredFPCContract } from '@aztec/noir-contracts.js/SponsoredFPC'
import { SponsoredFeePaymentMethod } from '@aztec/aztec.js/fee'
import { getContractInstanceFromInstantiationParams } from '@aztec/aztec.js/contracts'
import { SPONSORED_FPC_SALT } from '@aztec/constants'
import { NO_FROM } from '@aztec/aztec.js/account'

const OUR_NODE = process.env.OUR_NODE ?? 'http://localhost:8091'
const PUBLIC = 'https://v5.testnet.rpc.aztec-labs.com'
const MODE = (process.env.MODE ?? 'public') as 'ours' | 'split' | 'public'
const WAIT_SECONDS = Number(process.env.WAIT_SECONDS ?? 150)

const SEND_METHODS = new Set([
  'sendTx', 'getTxReceipt', 'getTxEffect', 'getPendingTxs',
  'getPendingTxCount', 'getTxsByHash', 'isValidTx',
])
// eslint-disable-next-line @typescript-eslint/no-explicit-any
function splitNode(readUrl: string): any {
  const read = createAztecNodeClient(readUrl)
  const send = createAztecNodeClient(PUBLIC)
  return new Proxy(read, {
    get(t, p, r) {
      if (typeof p === 'string' && SEND_METHODS.has(p)) {
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        const f = (send as any)[p]
        return typeof f === 'function' ? f.bind(send) : f
      }
      const v = Reflect.get(t, p, r)
      return typeof v === 'function' ? v.bind(t) : v
    },
  })
}

function log(...a: unknown[]) {
  // eslint-disable-next-line no-console
  console.log(`[probe:${MODE}]`, ...a)
}

async function main() {
  const node =
    MODE === 'ours' ? createAztecNodeClient(OUR_NODE)
    : MODE === 'split' ? splitNode(OUR_NODE)
    : createAztecNodeClient(PUBLIC)

  const info = await node.getNodeInfo()
  log('node', info.nodeVersion, '· reads from', MODE === 'public' ? PUBLIC : OUR_NODE,
      MODE === 'split' ? '· sends → public RPC' : '')

  const wallet = await EmbeddedWallet.create(node, { ephemeral: true, pxe: { proverEnabled: true } })
  const inst = await getContractInstanceFromInstantiationParams(SponsoredFPCContract.artifact, {
    salt: new Fr(SPONSORED_FPC_SALT),
  })
  await wallet.registerContract(inst, SponsoredFPCContract.artifact)
  const feeOpts = { paymentMethod: new SponsoredFeePaymentMethod(inst.address) }

  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const am: any = await (wallet as any).createSchnorrAccount(Fr.random(), Fr.random(), Fq.random())
  log('ephemeral account', am.address.toString())
  log(`deploying account (proving ~1-2min, wait cap ${WAIT_SECONDS}s)…`)

  const deploy = await am.getDeployMethod()
  const t0 = Date.now()
  try {
    // .send() may return a SentTx (with .wait()) or a promise that resolves on
    // mining (as browser-testnet awaits it). Handle both, with our own timeout
    // race so a non-propagating send fails fast instead of hanging.
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const sent: any = deploy.send({ from: NO_FROM, fee: feeOpts })
    const mined = typeof sent?.wait === 'function' ? sent.wait() : sent
    await Promise.race([
      mined,
      new Promise((_, rej) =>
        setTimeout(() => rej(new Error(`wait cap ${WAIT_SECONDS}s exceeded`)), WAIT_SECONDS * 1000),
      ),
    ])
    log(`✅ MINED in ${Math.round((Date.now() - t0) / 1000)}s — sends propagate in this mode`)
    process.exit(0)
  } catch (e) {
    const secs = Math.round((Date.now() - t0) / 1000)
    log(`✗ did NOT mine within ${secs}s — ${(e as Error).message?.slice(0, 120)}`)
    log(MODE === 'ours'
      ? '   → confirms our P2P-disabled node cannot propagate sends'
      : '   → unexpected; investigate')
    process.exit(2)
  }
}

main().catch((e) => { console.error('[probe] FAILED:', e); process.exit(1) })
