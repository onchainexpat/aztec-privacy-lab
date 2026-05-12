import { useState } from 'react'
import { initBrowserSandbox, type BrowserSandbox } from '../lib/browser-sandbox'
import type { SandboxState } from '../lib/sandbox-state'

interface Props {
  state: SandboxState
  onClose: () => void
}

interface PendingClaim {
  claimSecret: bigint
  claimSecretHash: bigint
  messageLeafIndex: bigint
  amount: bigint
}

interface PendingWithdraw {
  amount: bigint
  recipient: string
  txHash: string
  messageHash: string
}

interface PendingSwap {
  txHash: string
  amountIn: bigint
  claimSecret: string
  claimSecretHash: string
  transferNonce: string
  feeTier: bigint
  minOut: bigint
  /** Set after the L1 relay step. */
  l1RelayTxHash?: string
  outputLeafIndex?: string
}

const ANVIL_MNEMONIC = 'test test test test test test test test test test test junk'

export function BridgePanel({ state, onClose }: Props) {
  const [progress, setProgress] = useState<string | null>(null)
  const [sandbox, setSandbox] = useState<BrowserSandbox | null>(null)
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const [result, setResult] = useState<string | null>(null)
  const [l1Balance, setL1Balance] = useState<bigint | null>(null)
  const [portalEscrow, setPortalEscrow] = useState<bigint | null>(null)
  const [l2PublicBalance, setL2PublicBalance] = useState<bigint | null>(null)
  const [pendingClaim, setPendingClaim] = useState<PendingClaim | null>(null)
  const [pendingWithdraw, setPendingWithdraw] = useState<PendingWithdraw | null>(null)
  const [pendingSwap, setPendingSwap] = useState<PendingSwap | null>(null)

  const cc = state.crossChain
  const portalReady = !!cc?.l1Portal && !!cc?.l1Token

  async function refresh(sb: BrowserSandbox) {
    if (!cc?.l1Token) return
    const [{ getContract, parseAbi, createPublicClient, http }] = await Promise.all([
      import('viem'),
    ])
    const pub = createPublicClient({ transport: http(cc.l1Rpc ?? 'http://localhost:8545') })
    const erc20 = getContract({
      abi: parseAbi(['function balanceOf(address) view returns (uint256)']),
      address: cc.l1Token as `0x${string}`,
      client: pub,
    })
    const l1Deployer = cc.l1Deployer as `0x${string}`
    const bal = (await erc20.read.balanceOf([l1Deployer])) as bigint
    setL1Balance(bal)
    const escrow = (await erc20.read.balanceOf([cc.l1Portal as `0x${string}`])) as bigint
    setPortalEscrow(escrow)

    const { result: pubBal } = await sb.token0.methods
      .balance_of_public(sb.admin)
      .simulate({ from: sb.admin })
    setL2PublicBalance(pubBal as bigint)
  }

  async function handleInit() {
    setError(null)
    setBusy(true)
    try {
      const sb = await initBrowserSandbox(state, setProgress)
      if (!sb.l2Bridge)
        throw new Error('L2 bridge not in browser sandbox — re-run sandbox:l1-portal')
      setSandbox(sb)
      await refresh(sb)
    } catch (e) {
      setError(formatError(e))
    } finally {
      setBusy(false)
    }
  }

  async function handleBridge() {
    if (!sandbox?.l2Bridge || !cc?.l1Portal || !cc?.l1Token) return
    setBusy(true)
    setError(null)
    setResult(null)
    try {
      const { createExtendedL1Client } = await import('@aztec/ethereum/client')
      const { L1ToL2TokenPortalManager } = await import('@aztec/aztec.js/ethereum')
      const { EthAddress } = await import('@aztec/aztec.js/addresses')
      const { foundry } = await import('viem/chains')
      const { createLogger } = await import('@aztec/foundation/log')

      const AMOUNT = 1_000n
      setResult(`approving ${AMOUNT} on L1 + sending L1→L2 message…`)
      const l1Client = createExtendedL1Client(
        [cc.l1Rpc ?? 'http://localhost:8545'],
        ANVIL_MNEMONIC,
        foundry,
      )
      const portalMgr = new L1ToL2TokenPortalManager(
        EthAddress.fromString(cc.l1Portal),
        EthAddress.fromString(cc.l1Token),
        undefined,
        l1Client,
        createLogger('bridge-panel'),
      )
      const claim = await portalMgr.bridgeTokensPublic(sandbox.admin, AMOUNT, false)
      setPendingClaim({
        claimSecret: BigInt(claim.claimSecret.toString()),
        claimSecretHash: BigInt(claim.claimSecretHash.toString()),
        messageLeafIndex: claim.messageLeafIndex,
        amount: claim.claimAmount,
      })
      setResult(
        `L1→L2 message sent. Wait ~2 L2 blocks for the message to land in the L2 inbox, then claim.`,
      )
      await refresh(sandbox)
    } catch (e) {
      setError(formatError(e))
    } finally {
      setBusy(false)
    }
  }

  async function handleWithdraw() {
    if (!sandbox?.l2Bridge || !cc?.l1Portal || !cc?.l1Deployer || !cc?.l1Token) return
    setBusy(true)
    setError(null)
    setResult(null)
    try {
      const { Fr } = await import('@aztec/aztec.js/fields')
      const { EthAddress } = await import('@aztec/aztec.js/addresses')
      const { SetPublicAuthwitContractInteraction } = await import('@aztec/aztec.js/authorization')
      const { createExtendedL1Client } = await import('@aztec/ethereum/client')
      const { L1TokenPortalManager } = await import('@aztec/aztec.js/ethereum')
      const { createAztecNodeClient } = await import('@aztec/aztec.js/node')
      const { foundry } = await import('viem/chains')
      const { createLogger } = await import('@aztec/foundation/log')

      const AMOUNT = 500n
      const { admin, token0, l2Bridge, wallet } = sandbox
      const recipient = EthAddress.fromString(cc.l1Deployer)
      const nonce = Fr.random()

      // 1) Authorize the L2 bridge to burn from admin's public AZA balance.
      const burnIntent = {
        caller: l2Bridge.address,
        call: await token0.methods.burn_public(admin, AMOUNT, nonce).getFunctionCall(),
      }
      const auth = await SetPublicAuthwitContractInteraction.create(
        wallet,
        admin,
        burnIntent,
        true,
      )
      await auth.send()

      // 2) Burn on L2 and emit the L2→L1 withdrawal message.
      const sendResult = await l2Bridge.methods
        .exit_to_l1_public(recipient, AMOUNT, EthAddress.ZERO, nonce)
        .send({ from: admin })
      const txHashStr =
        (sendResult as unknown as { receipt: { txHash: { toString(): string } } }).receipt.txHash.toString()

      // 3) Compute the expected L2→L1 message leaf so we can query the witness later.
      const node = createAztecNodeClient(state.sandboxUrl)
      const info = await node.getNodeInfo()
      const outboxAddress = EthAddress.fromString(info.l1ContractAddresses.outboxAddress.toString())
      const l1Client = createExtendedL1Client(
        [cc.l1Rpc ?? 'http://localhost:8545'],
        ANVIL_MNEMONIC,
        foundry,
      )
      const portalMgr = new L1TokenPortalManager(
        EthAddress.fromString(cc.l1Portal),
        EthAddress.fromString(cc.l1Token),
        undefined,
        outboxAddress,
        l1Client,
        createLogger('bridge-withdraw'),
      )
      const messageLeaf = await portalMgr.getL2ToL1MessageLeaf(
        AMOUNT,
        recipient,
        l2Bridge.address,
        EthAddress.ZERO,
      )

      setPendingWithdraw({
        amount: AMOUNT,
        recipient: recipient.toString(),
        txHash: txHashStr,
        messageHash: messageLeaf.toString(),
      })
      setResult(
        `burned ${AMOUNT} AZA on L2; L2→L1 message leaf ${messageLeaf.toString().slice(0, 14)}… queued. Wait for the epoch to be proven on L1 before finalising.`,
      )
      await refresh(sandbox)
    } catch (e) {
      setError(formatError(e))
    } finally {
      setBusy(false)
    }
  }

  async function handleFinalizeWithdraw() {
    if (!sandbox?.l2Bridge || !cc?.l1Portal || !cc?.l1Token || !pendingWithdraw) return
    setBusy(true)
    setError(null)
    setResult(null)
    try {
      const { createExtendedL1Client } = await import('@aztec/ethereum/client')
      const { L1TokenPortalManager } = await import('@aztec/aztec.js/ethereum')
      const { createAztecNodeClient } = await import('@aztec/aztec.js/node')
      const { EthAddress } = await import('@aztec/aztec.js/addresses')
      const { Fr } = await import('@aztec/aztec.js/fields')
      const { foundry } = await import('viem/chains')
      const { computeL2ToL1MembershipWitness } = await import('@aztec/stdlib/messaging')
      const { TxHash } = await import('@aztec/stdlib/tx')
      const { createLogger } = await import('@aztec/foundation/log')

      const node = createAztecNodeClient(state.sandboxUrl)
      const info = await node.getNodeInfo()
      const outboxAddress = EthAddress.fromString(info.l1ContractAddresses.outboxAddress.toString())

      const witness = await computeL2ToL1MembershipWitness(
        node,
        new Fr(BigInt(pendingWithdraw.messageHash)),
        TxHash.fromString(pendingWithdraw.txHash),
      )
      if (!witness) {
        setError('Witness not yet available — epoch still in flight. Retry in ~30 s.')
        return
      }

      const l1Client = createExtendedL1Client(
        [cc.l1Rpc ?? 'http://localhost:8545'],
        ANVIL_MNEMONIC,
        foundry,
      )
      const portalMgr = new L1TokenPortalManager(
        EthAddress.fromString(cc.l1Portal),
        EthAddress.fromString(cc.l1Token),
        undefined,
        outboxAddress,
        l1Client,
        createLogger('bridge-withdraw'),
      )
      await portalMgr.withdrawFunds(
        pendingWithdraw.amount,
        EthAddress.fromString(pendingWithdraw.recipient),
        witness.epochNumber,
        witness.leafIndex,
        witness.siblingPath,
      )
      setResult(
        `withdrew ${pendingWithdraw.amount} TestERC20 to ${pendingWithdraw.recipient.slice(0, 8)}… on L1`,
      )
      setPendingWithdraw(null)
      await refresh(sandbox)
    } catch (e) {
      setError(formatError(e))
    } finally {
      setBusy(false)
    }
  }

  async function handleSwapOnL1() {
    if (!sandbox?.l2Uniswap || !sandbox?.l2Bridge || !sandbox?.l2BridgeB) {
      setError('Uniswap stack not wired in sandbox state — run npm run sandbox:uniswap.')
      return
    }
    setBusy(true)
    setError(null)
    setResult(null)
    try {
      const { Fr } = await import('@aztec/aztec.js/fields')
      const { EthAddress } = await import('@aztec/aztec.js/addresses')
      const { SetPublicAuthwitContractInteraction } = await import(
        '@aztec/aztec.js/authorization'
      )
      const { computeSecretHash } = await import('@aztec/stdlib/hash')

      const AMOUNT_IN = 500n
      const FEE_TIER = 3000n
      const MIN_OUT = 1n
      const { admin, token0, l2Bridge, l2BridgeB, l2Uniswap, wallet } = sandbox

      const transferNonce = Fr.random()
      const swapNonce = Fr.random()
      const claimSecret = Fr.random()
      const claimSecretHash = await computeSecretHash(claimSecret)

      // Public authwit so the L2 Uniswap can pull admin's public AZA.
      const intent = {
        caller: l2Uniswap.address,
        call: await token0.methods
          .transfer_in_public(admin, l2Uniswap.address, AMOUNT_IN, transferNonce)
          .getFunctionCall(),
      }
      const auth = await SetPublicAuthwitContractInteraction.create(wallet, admin, intent, true)
      await auth.send()

      const sendResult = await l2Uniswap.methods
        .swap_public(
          admin,
          l2Bridge.address,
          AMOUNT_IN,
          l2BridgeB.address,
          transferNonce,
          new Fr(FEE_TIER),
          MIN_OUT,
          admin,
          claimSecretHash,
          EthAddress.ZERO,
          swapNonce,
        )
        .send({ from: admin })
      const txHash = (sendResult as unknown as { receipt: { txHash: { toString(): string } } })
        .receipt.txHash.toString()
      setPendingSwap({
        txHash,
        amountIn: AMOUNT_IN,
        claimSecret: claimSecret.toString(),
        claimSecretHash: claimSecretHash.toString(),
        transferNonce: transferNonce.toString(),
        feeTier: FEE_TIER,
        minOut: MIN_OUT,
      })
      setResult(
        `L2 swap_public mined. Two L2→L1 messages queued — finish with a UniswapPortal.swapPublic on L1, then claim AZB on the output bridge with the secret above.`,
      )
      await refresh(sandbox)
    } catch (e) {
      setError(formatError(e))
    } finally {
      setBusy(false)
    }
  }

  async function handleRelaySwap() {
    if (!sandbox?.l2Uniswap || !pendingSwap || !cc?.l1UniswapPortal) return
    setBusy(true)
    setError(null)
    setResult(null)
    try {
      const { Fr } = await import('@aztec/aztec.js/fields')
      const { TxHash } = await import('@aztec/stdlib/tx')
      const { computeL2ToL1MembershipWitness } = await import('@aztec/stdlib/messaging')
      const { createAztecNodeClient } = await import('@aztec/aztec.js/node')
      const { createExtendedL1Client } = await import('@aztec/ethereum/client')
      const { UniswapPortalAbi } = await import('@aztec/l1-artifacts/UniswapPortalAbi')
      const { InboxAbi } = await import('@aztec/l1-artifacts/InboxAbi')
      const { foundry } = await import('viem/chains')
      const { getContract, decodeEventLog } = await import('viem')

      const node = createAztecNodeClient(state.sandboxUrl)
      const txhash = TxHash.fromString(pendingSwap.txHash)
      setResult('reading L2→L1 messages from the swap tx effect…')
      let effect: Awaited<ReturnType<typeof node.getTxEffect>>
      for (let i = 0; i < 30; i++) {
        effect = await node.getTxEffect(txhash)
        if (effect?.data.l2ToL1Msgs.length === 2) break
        await new Promise((r) => setTimeout(r, 2000))
      }
      if (!effect || effect.data.l2ToL1Msgs.length !== 2)
        throw new Error('expected 2 L2→L1 msgs, got ' + (effect?.data.l2ToL1Msgs.length ?? 0))

      setResult('computing membership witnesses (waits for outbox to advance)…')
      const witnesses: { epochNumber: number; leafIndex: bigint; siblingPath: unknown }[] = []
      for (const msg of effect.data.l2ToL1Msgs) {
        let w: Awaited<ReturnType<typeof computeL2ToL1MembershipWitness>>
        for (let i = 0; i < 30; i++) {
          w = await computeL2ToL1MembershipWitness(node, msg, txhash)
          if (w) break
          await new Promise((r) => setTimeout(r, 3000))
        }
        if (!w) throw new Error(`no witness for message ${msg.toString()}`)
        witnesses.push({
          epochNumber: w.epochNumber,
          leafIndex: w.leafIndex,
          siblingPath: w.siblingPath,
        })
      }

      setResult(`calling UniswapPortal.swapPublic on L1 (witnesses at epoch ${witnesses[0].epochNumber})…`)
      const l1Client = createExtendedL1Client(
        [cc.l1Rpc ?? 'http://localhost:8545'],
        ANVIL_MNEMONIC,
        foundry,
      )
      const portal = getContract({
        abi: UniswapPortalAbi,
        address: cc.l1UniswapPortal as `0x${string}`,
        client: l1Client,
      })
      const metadataArr = witnesses.map((w) => {
        type SibPath = { toBufferArray: () => Buffer[] }
        const sp = (w.siblingPath as unknown as SibPath).toBufferArray()
        return {
          _epoch: BigInt(w.epochNumber),
          _leafIndex: w.leafIndex,
          _path: sp.map((b) => `0x${b.toString('hex')}` as `0x${string}`),
        }
      })
      const swapArgs = [
        cc.l1Portal as `0x${string}`,
        pendingSwap.amountIn,
        Number(pendingSwap.feeTier),
        cc.l1OutputPortal as `0x${string}`,
        pendingSwap.minOut,
        sandbox.admin.toString() as `0x${string}`,
        pendingSwap.claimSecretHash as `0x${string}`,
        false,
        [metadataArr[0], metadataArr[1]],
      ] as const

      let relayTx: `0x${string}` | undefined
      for (let i = 0; i < 30; i++) {
        try {
          relayTx = await portal.write.swapPublic(swapArgs)
          break
        } catch (e) {
          const msg = e instanceof Error ? e.message : String(e)
          if (msg.includes('reverted')) {
            setResult(`outbox not at epoch ${witnesses[0].epochNumber} yet, retry ${i}/30…`)
            await new Promise((r) => setTimeout(r, 12_000))
          } else {
            throw e
          }
        }
      }
      if (!relayTx) throw new Error('UniswapPortal.swapPublic still reverts — outbox cadence too slow')

      const receipt = await l1Client.waitForTransactionReceipt({ hash: relayTx })
      const inboxAddr = (await node.getNodeInfo()).l1ContractAddresses.inboxAddress
        .toString()
        .toLowerCase()
      const inboxLog = receipt.logs.find((l) => l.address.toLowerCase() === inboxAddr)
      if (!inboxLog) throw new Error('no Inbox log in L1 swap receipt')
      const decoded = decodeEventLog({ abi: InboxAbi, data: inboxLog.data, topics: inboxLog.topics })
      const outputLeafIndex = (decoded.args as unknown as { index: bigint }).index

      setPendingSwap({
        ...pendingSwap,
        l1RelayTxHash: relayTx,
        outputLeafIndex: outputLeafIndex.toString(),
      })
      setResult(
        `L1 swap mined (${relayTx.slice(0, 10)}…). Output mint queued at L1→L2 leaf ${outputLeafIndex.toString()}. Click "Claim AZB" once L2 advances past the message.`,
      )
      void Fr // keep ts-strict happy
    } catch (e) {
      setError(formatError(e))
    } finally {
      setBusy(false)
    }
  }

  async function handleClaimSwap() {
    if (!sandbox?.l2BridgeB || !pendingSwap?.outputLeafIndex) return
    setBusy(true)
    setError(null)
    setResult(null)
    try {
      const { Fr } = await import('@aztec/aztec.js/fields')
      const { admin, l2BridgeB, token0 } = sandbox
      const leaf = new Fr(BigInt(pendingSwap.outputLeafIndex))
      const secret = new Fr(BigInt(pendingSwap.claimSecret))
      // The sandbox proposer skips idle slots; poke L2 with a 1-wei public
      // self-transfer so a block rolls past the message checkpoint before we
      // claim. Retry the claim until the L2 inbox has the message.
      for (let i = 0; i < 10; i++) {
        try {
          await l2BridgeB.methods
            .claim_public(admin, pendingSwap.amountIn, secret, leaf)
            .send({ from: admin })
          break
        } catch (e) {
          const msg = e instanceof Error ? e.message : String(e)
          if (msg.includes('nonexistent L1-to-L2 message')) {
            setResult(`L2 inbox not at message yet (try ${i}/10); poking L2 with a self-transfer to force a block…`)
            try {
              await token0.methods.transfer_in_public(admin, admin, 1n, Fr.ZERO).send({ from: admin })
            } catch {
              // even a revert mines a block
            }
          } else {
            throw e
          }
        }
      }
      setResult(
        `claimed ${pendingSwap.amountIn} AZB on L2 — minted to your public balance. Full Uniswap-from-L2 round-trip closed.`,
      )
      setPendingSwap(null)
      await refresh(sandbox)
    } catch (e) {
      setError(formatError(e))
    } finally {
      setBusy(false)
    }
  }

  async function handleClaim() {
    if (!sandbox?.l2Bridge || !pendingClaim) return
    setBusy(true)
    setError(null)
    setResult(null)
    try {
      const { Fr } = await import('@aztec/aztec.js/fields')
      await sandbox.l2Bridge.methods
        .claim_public(
          sandbox.admin,
          pendingClaim.amount,
          new Fr(pendingClaim.claimSecret),
          new Fr(pendingClaim.messageLeafIndex),
        )
        .send({ from: sandbox.admin })
      setResult(
        `claimed ${pendingClaim.amount} ${state.token0.symbol} on L2 — minted to your public balance`,
      )
      setPendingClaim(null)
      await refresh(sandbox)
    } catch (e) {
      setError(formatError(e))
    } finally {
      setBusy(false)
    }
  }

  return (
    <section className="mt-10 rounded-2xl border border-black/10 bg-white p-6">
      <div className="flex items-center justify-between">
        <h3 className="text-lg font-semibold">L1 → L2 bridge demo</h3>
        <button onClick={onClose} className="text-sm text-black/50 underline-offset-4 hover:underline">
          Close
        </button>
      </div>

      <p className="mt-2 text-sm text-black/60">
        Bridges 1,000 <code className="font-mono text-xs">TestERC20</code> from anvil into your L2
        public AZA balance. The L1 portal escrows the ERC20 and pushes an L1→L2 message; you wait
        for the L2 inbox sync and then redeem the claim on the L2 bridge.
      </p>

      {!portalReady && (
        <p className="mt-3 rounded-lg border border-amber-200 bg-amber-50 p-3 text-xs text-amber-900">
          L1 portal not deployed yet. Run <code className="font-mono">npm run sandbox:l1-portal</code> and reload.
        </p>
      )}

      {!sandbox ? (
        <div className="mt-4">
          <button
            onClick={handleInit}
            disabled={busy || !portalReady}
            className="rounded-full bg-[var(--color-ink)] px-4 py-2 text-sm font-medium text-[var(--color-paper)] hover:opacity-90 disabled:opacity-50"
          >
            {busy ? 'Initializing…' : 'Initialize browser PXE'}
          </button>
          {progress && busy && <p className="mt-2 text-xs text-black/50">{progress}</p>}
        </div>
      ) : (
        <>
          <div className="mt-4 flex flex-wrap items-center gap-3">
            <button
              onClick={handleBridge}
              disabled={busy}
              className="rounded-full bg-[var(--color-public)] px-4 py-2 text-sm font-medium text-white hover:opacity-90 disabled:opacity-50"
            >
              {busy ? 'Bridging…' : 'Bridge 1,000 TestERC20 → L2'}
            </button>
            <button
              onClick={handleClaim}
              disabled={busy || !pendingClaim}
              className="rounded-full border border-[var(--color-public)] px-4 py-2 text-sm font-medium text-[var(--color-public)] hover:bg-[var(--color-public)]/5 disabled:opacity-50"
            >
              Claim on L2
            </button>
            <button
              onClick={handleWithdraw}
              disabled={busy}
              className="rounded-full bg-rose-600 px-4 py-2 text-sm font-medium text-white hover:opacity-90 disabled:opacity-50"
            >
              Withdraw 500 AZA → L1
            </button>
            <button
              onClick={handleFinalizeWithdraw}
              disabled={busy || !pendingWithdraw}
              className="rounded-full border border-rose-600 px-4 py-2 text-sm font-medium text-rose-600 hover:bg-rose-50 disabled:opacity-50"
            >
              Finalise L1 withdraw
            </button>
            {sandbox.l2Uniswap && (
              <>
                <button
                  onClick={handleSwapOnL1}
                  disabled={busy}
                  className="rounded-full bg-violet-600 px-4 py-2 text-sm font-medium text-white hover:opacity-90 disabled:opacity-50"
                >
                  Swap 500 AZA → AZB via L1 Uniswap
                </button>
                <button
                  onClick={handleRelaySwap}
                  disabled={busy || !pendingSwap || !!pendingSwap.l1RelayTxHash}
                  className="rounded-full border border-violet-600 px-4 py-2 text-sm font-medium text-violet-600 hover:bg-violet-50 disabled:opacity-50"
                >
                  Relay swap on L1
                </button>
                <button
                  onClick={handleClaimSwap}
                  disabled={busy || !pendingSwap?.outputLeafIndex}
                  className="rounded-full border border-violet-600 px-4 py-2 text-sm font-medium text-violet-600 hover:bg-violet-50 disabled:opacity-50"
                >
                  Claim AZB on L2
                </button>
              </>
            )}
            <span className="text-xs text-emerald-700">
              PXE ready · admin {sandbox.admin.toString().slice(0, 8)}…
            </span>
          </div>

          <div className="mt-4 grid grid-cols-3 gap-4 rounded-xl border border-black/10 bg-zinc-50 p-3 text-sm">
            <div>
              <p className="flex items-center gap-1.5 text-xs uppercase tracking-wide text-black/40">
                <span className="size-1.5 rounded-full bg-sky-500" />
                L1 deployer balance
              </p>
              <p className="mt-0.5 font-mono">
                {l1Balance === null ? '—' : `${fmt(l1Balance)} TestERC20`}
              </p>
            </div>
            <div>
              <p className="flex items-center gap-1.5 text-xs uppercase tracking-wide text-black/40">
                <span className="size-1.5 rounded-full bg-sky-500" />
                L1 portal escrow
              </p>
              <p className="mt-0.5 font-mono">
                {portalEscrow === null ? '—' : `${fmt(portalEscrow)} TestERC20`}
              </p>
            </div>
            <div>
              <p className="flex items-center gap-1.5 text-xs uppercase tracking-wide text-black/40">
                <span className="size-1.5 rounded-full bg-sky-500" />
                admin L2 public AZA
              </p>
              <p className="mt-0.5 font-mono">
                {l2PublicBalance === null ? '—' : `${fmt(l2PublicBalance)} AZA`}
              </p>
            </div>
          </div>

          <p className="mt-3 text-xs text-black/50">
            The bridge call moves L1 tokens into the portal's escrow immediately (visible above).
            The L2 claim mints AZA to the recipient's public balance once the L2 head crosses the
            message checkpoint — typically ~2 L2 blocks. If you started the sandbox without{' '}
            <code className="font-mono">--sequencer.minTxsPerBlock 0</code> the proposer stalls
            and claims will revert with "Tried to consume nonexistent L1-to-L2 message".
          </p>

          {pendingClaim && (
            <div className="mt-3 rounded-xl border border-amber-200 bg-amber-50 p-3 text-xs text-amber-900">
              pending L1→L2 claim · amount {pendingClaim.amount.toString()} · leaf{' '}
              {pendingClaim.messageLeafIndex.toString()} · wait ~2 L2 blocks before claiming.
            </div>
          )}
          {pendingWithdraw && (
            <div className="mt-3 rounded-xl border border-amber-200 bg-amber-50 p-3 text-xs text-amber-900">
              pending L2→L1 withdraw · amount {pendingWithdraw.amount.toString()} · message{' '}
              {pendingWithdraw.messageHash.slice(0, 14)}… · wait for the epoch to settle on L1
              before finalising.
            </div>
          )}
          {pendingSwap && (
            <div className="mt-3 rounded-xl border border-violet-200 bg-violet-50 p-3 text-xs text-violet-900">
              <p>
                pending L2→L1 swap · {pendingSwap.amountIn.toString()} AZA → ≥{' '}
                {pendingSwap.minOut.toString()} AZB · fee {pendingSwap.feeTier.toString()}bps
              </p>
              <p className="mt-1 font-mono">
                claim_secret_hash: {pendingSwap.claimSecretHash.slice(0, 18)}…
              </p>
              {pendingSwap.l1RelayTxHash && (
                <p className="mt-1 font-mono">
                  L1 relay tx: {pendingSwap.l1RelayTxHash.slice(0, 14)}… · output leaf{' '}
                  {pendingSwap.outputLeafIndex}
                </p>
              )}
              <p className="mt-1">
                Three clicks: <strong>Swap</strong> → <strong>Relay swap on L1</strong> (waits
                for outbox advance, ~1–2 min) → <strong>Claim AZB on L2</strong>.
              </p>
            </div>
          )}
        </>
      )}

      {result && (
        <p className="mt-3 rounded-lg border border-emerald-200 bg-emerald-50 p-2 text-xs text-emerald-900">
          {result}
        </p>
      )}
      {error && (
        <pre className="mt-3 max-h-48 overflow-auto rounded-lg border border-rose-200 bg-rose-50 p-3 text-xs text-rose-900">
{error}
        </pre>
      )}
    </section>
  )
}

function fmt(n: bigint): string {
  return Number(n).toLocaleString('en-US')
}

function formatError(e: unknown): string {
  if (e instanceof Error) return `${e.name}: ${e.message}`
  return String(e)
}
