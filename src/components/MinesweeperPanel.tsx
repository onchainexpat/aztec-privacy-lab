import { useEffect, useState } from 'react'
import { initBrowserSandbox, type BrowserSandbox } from '../lib/browser-sandbox'
import type { SandboxState } from '../lib/sandbox-state'

interface Props {
  state: SandboxState
  onClose: () => void
}

const BOARD_CELLS = 25 // 5x5
const BOARD_SIDE = 5
const ENTRY_FEE = 1000n

interface GameState {
  gameId: string
  revealedMask: bigint
  status: 0 | 1 | 2 // 0 active, 1 won, 2 lost
  safeRevealed: number
  // The seed lets observers recompute the board off-chain. We do the same
  // client-side so the UI can show "actual mines" once the game ends.
  predictedMines: boolean[] // length BOARD_CELLS
}

// Mirror of the Noir compute: pedersen(seed, cell_index), check low 3 bits.
// We use a JS approximation here that uses an HMAC-style hash; it WILL NOT
// match the on-chain Noir Pedersen hash exactly. Used only to color the
// "mines revealed by the contract" view AFTER the game ends. The actual
// reveal outcome (hit/miss) is authoritative because the contract checks it.
function placeholderPredictMines(gameId: string): boolean[] {
  // Deterministic but doesn't match Noir's pedersen. The panel makes this
  // honest: it only shows "actual outcome from contract" cells, never claims
  // to know mines ahead of time. The predictedMines array stays unused unless
  // we add post-game replay; keeping it for future enhancement.
  void gameId
  return new Array(BOARD_CELLS).fill(false)
}

export function MinesweeperPanel({ state, onClose }: Props) {
  const [sandbox, setSandbox] = useState<BrowserSandbox | null>(null)
  const [progress, setProgress] = useState<string | null>(null)
  const [error, setError] = useState<string | null>(null)
  const [busy, setBusy] = useState(false)
  const [privateAza, setPrivateAza] = useState<bigint | null>(null)
  const [game, setGame] = useState<GameState | null>(null)
  const [lastReveal, setLastReveal] = useState<{ cell: number; hit: boolean } | null>(null)

  async function refreshBalance(sb: BrowserSandbox) {
    const { result } = await sb.token0.methods
      .balance_of_private(sb.admin)
      .simulate({ from: sb.admin })
    setPrivateAza(result as bigint)
  }

  async function refreshGame(sb: BrowserSandbox, gameId: string) {
    if (!sb.minesweeper) return
    const { Fr } = await import('@aztec/aztec.js/fields')
    const gameIdFr = new Fr(BigInt(gameId))
    const [maskRes, statusRes, safeRes] = await Promise.all([
      sb.minesweeper.methods.get_revealed_mask(gameIdFr).simulate({ from: sb.admin }),
      sb.minesweeper.methods.get_status(gameIdFr).simulate({ from: sb.admin }),
      sb.minesweeper.methods.get_safe_revealed(gameIdFr).simulate({ from: sb.admin }),
    ])
    setGame({
      gameId,
      revealedMask: maskRes.result as bigint,
      status: Number(statusRes.result) as 0 | 1 | 2,
      safeRevealed: Number(safeRes.result),
      predictedMines: placeholderPredictMines(gameId),
    })
  }

  async function handleInit() {
    setError(null)
    setBusy(true)
    try {
      const sb = await initBrowserSandbox(state, setProgress)
      if (!sb.minesweeper) throw new Error('Minesweeper not deployed — re-run sandbox:setup')
      setSandbox(sb)
      await refreshBalance(sb)
    } catch (e) {
      setError(formatError(e))
    } finally {
      setBusy(false)
    }
  }

  async function handleStart() {
    if (!sandbox?.minesweeper || !sandbox?.token0) return
    setBusy(true)
    setError(null)
    setLastReveal(null)
    try {
      const fieldsMod = await import('@aztec/aztec.js/fields')
      const Fr = fieldsMod.Fr
      const salt = Fr.random()
      const authwitNonce = Fr.random()

      // The contract pulls ENTRY_FEE from the player's private AZA balance
      // via transfer_to_public; embedded wallet auto-injects the inner authwit.
      const result = (await sandbox.minesweeper.methods
        .start_game(salt, authwitNonce)
        .send({ from: sandbox.admin })) as unknown as { receipt: unknown; result: bigint }
      // start_game returns the game_id (= seed). Pull it from the simulation.
      const sim = await sandbox.minesweeper.methods
        .start_game(salt, authwitNonce)
        .simulate({ from: sandbox.admin })
      const gameId = '0x' + (sim.result as bigint).toString(16).padStart(64, '0')
      void result
      await refreshGame(sandbox, gameId)
      await refreshBalance(sandbox)
    } catch (e) {
      setError(formatError(e))
    } finally {
      setBusy(false)
    }
  }

  async function handleReveal(cell: number) {
    if (!sandbox?.minesweeper || !game) return
    const bit = 1n << BigInt(cell)
    if ((game.revealedMask & bit) !== 0n) return
    if (game.status !== 0) return
    setBusy(true)
    setError(null)
    setLastReveal(null)
    try {
      const { Fr } = await import('@aztec/aztec.js/fields')
      const gameIdFr = new Fr(BigInt(game.gameId))
      await sandbox.minesweeper.methods
        .reveal(gameIdFr, cell)
        .send({ from: sandbox.admin })
      await refreshGame(sandbox, game.gameId)
      const newStatus = (
        await sandbox.minesweeper.methods.get_status(gameIdFr).simulate({ from: sandbox.admin })
      ).result as bigint
      setLastReveal({ cell, hit: Number(newStatus) === 2 })
    } catch (e) {
      setError(formatError(e))
    } finally {
      setBusy(false)
    }
  }

  useEffect(() => {
    if (!sandbox) return
    void refreshBalance(sandbox)
  }, [sandbox])

  return (
    <section className="mt-10 rounded-2xl border border-black/10 bg-white p-6">
      <div className="flex items-center justify-between">
        <h3 className="text-lg font-semibold">Minesweeper — variant g1</h3>
        <button onClick={onClose} className="text-sm text-black/50 underline-offset-4 hover:underline">
          Close
        </button>
      </div>
      <p className="mt-2 text-sm text-black/60">
        Pay {Number(ENTRY_FEE).toLocaleString()} AZA from your private balance to start a 5×5 board
        with ~3 mines. Each reveal is a private function call so your address stays out of public
        state; the cell outcome and game status update publicly.
      </p>
      <p className="mt-2 rounded border border-amber-200 bg-amber-50 p-2 text-xs text-amber-900">
        <strong>Trust caveat:</strong> the board is derived from{' '}
        <code className="font-mono text-[10px]">pedersen(player, salt)</code>. Anyone with the
        emitted game_id (= seed) can recompute mine positions off-chain. Honest demo of "private
        gameplay against a public board"; not for stakes.
      </p>

      {!sandbox ? (
        <div className="mt-4">
          <button
            onClick={handleInit}
            disabled={busy}
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
              onClick={handleStart}
              disabled={busy || (privateAza !== null && privateAza < ENTRY_FEE)}
              className="rounded-full bg-violet-600 px-4 py-2 text-sm font-medium text-white hover:opacity-90 disabled:opacity-50"
            >
              {busy ? 'Working…' : `Start game · pay ${Number(ENTRY_FEE).toLocaleString()} AZA`}
            </button>
            <span className="text-xs text-black/60">
              private AZA:{' '}
              <span className="font-mono">
                {privateAza === null ? '—' : Number(privateAza).toLocaleString()}
              </span>
            </span>
          </div>

          {game && (
            <div className="mt-5">
              <div className="flex flex-wrap items-center gap-3 text-xs">
                <span className="font-mono">game_id: {game.gameId.slice(0, 14)}…</span>
                <span className="font-mono">safe revealed: {game.safeRevealed}</span>
                <span
                  className={`rounded-full px-2 py-0.5 ${
                    game.status === 0
                      ? 'bg-sky-100 text-sky-900'
                      : game.status === 1
                        ? 'bg-emerald-100 text-emerald-900'
                        : 'bg-rose-100 text-rose-900'
                  }`}
                >
                  {game.status === 0 ? 'active' : game.status === 1 ? 'won' : 'lost (hit a mine)'}
                </span>
              </div>
              <div
                className="mt-3 grid gap-1.5"
                style={{ gridTemplateColumns: `repeat(${BOARD_SIDE}, minmax(0, 1fr))`, width: 280 }}
              >
                {Array.from({ length: BOARD_CELLS }, (_, i) => {
                  const bit = 1n << BigInt(i)
                  const revealed = (game.revealedMask & bit) !== 0n
                  const isLastHit =
                    lastReveal?.cell === i && lastReveal?.hit && game.status === 2
                  return (
                    <button
                      key={i}
                      onClick={() => handleReveal(i)}
                      disabled={busy || revealed || game.status !== 0}
                      className={`aspect-square rounded text-xs font-mono ${
                        isLastHit
                          ? 'bg-rose-600 text-white'
                          : revealed
                            ? 'bg-emerald-100 text-emerald-900'
                            : 'bg-zinc-100 text-zinc-500 hover:bg-zinc-200 disabled:opacity-50'
                      }`}
                    >
                      {revealed ? (isLastHit ? '✗' : '·') : i}
                    </button>
                  )
                })}
              </div>
            </div>
          )}

          {error && (
            <pre className="mt-3 max-h-48 overflow-auto rounded-lg border border-rose-200 bg-rose-50 p-3 text-xs text-rose-900">
              {error}
            </pre>
          )}
        </>
      )}
    </section>
  )
}

function formatError(e: unknown): string {
  if (e instanceof Error) return `${e.name}: ${e.message}`
  return String(e)
}
