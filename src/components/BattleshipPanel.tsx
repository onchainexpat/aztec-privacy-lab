import { useEffect, useState } from 'react'
import { initBrowserSandbox, type BrowserSandbox } from '../lib/browser-sandbox'
import type { SandboxState } from '../lib/sandbox-state'

interface Props {
  state: SandboxState
  onClose: () => void
}

const BOARD_CELLS = 64 // 8x8
const BOARD_SIDE = 8
const SHIP_LEN = 3
const ENTRY_FEE = 1000n

interface GameState {
  gameId: string
  shotsMask: bigint
  shotsFired: number
  hits: number
  status: 0 | 1 // 0 active, 1 won (sunk)
}

export function BattleshipPanel({ state, onClose }: Props) {
  const [sandbox, setSandbox] = useState<BrowserSandbox | null>(null)
  const [progress, setProgress] = useState<string | null>(null)
  const [error, setError] = useState<string | null>(null)
  const [busy, setBusy] = useState(false)
  const [privateAza, setPrivateAza] = useState<bigint | null>(null)
  const [game, setGame] = useState<GameState | null>(null)
  const [lastShot, setLastShot] = useState<{ cell: number; hit: boolean } | null>(null)

  async function refreshBalance(sb: BrowserSandbox) {
    const { result } = await sb.token0.methods
      .balance_of_private(sb.admin)
      .simulate({ from: sb.admin })
    setPrivateAza(result as bigint)
  }

  async function refreshGame(sb: BrowserSandbox, gameId: string) {
    if (!sb.battleship) return
    const { Fr } = await import('@aztec/aztec.js/fields')
    const gameIdFr = new Fr(BigInt(gameId))
    const [maskRes, shotsRes, hitsRes, statusRes] = await Promise.all([
      sb.battleship.methods.get_shots_mask(gameIdFr).simulate({ from: sb.admin }),
      sb.battleship.methods.get_status(gameIdFr).simulate({ from: sb.admin }),
      sb.battleship.methods.get_hits(gameIdFr).simulate({ from: sb.admin }),
      sb.battleship.methods.get_status(gameIdFr).simulate({ from: sb.admin }),
    ])
    void shotsRes
    setGame({
      gameId,
      shotsMask: maskRes.result as bigint,
      shotsFired: 0, // not surfaced by this view; left at zero
      hits: Number(hitsRes.result),
      status: Number(statusRes.result) as 0 | 1,
    })
  }

  async function handleInit() {
    setError(null)
    setBusy(true)
    try {
      const sb = await initBrowserSandbox(state, setProgress)
      if (!sb.battleship) throw new Error('Battleship not deployed — re-run sandbox:setup')
      setSandbox(sb)
      await refreshBalance(sb)
    } catch (e) {
      setError(formatError(e))
    } finally {
      setBusy(false)
    }
  }

  async function handleStart() {
    if (!sandbox?.battleship || !sandbox?.token0) return
    setBusy(true)
    setError(null)
    setLastShot(null)
    try {
      const fieldsMod = await import('@aztec/aztec.js/fields')
      const Fr = fieldsMod.Fr
      const salt = Fr.random()
      const authwitNonce = Fr.random()

      const sim = await sandbox.battleship.methods
        .start_game(salt, authwitNonce)
        .simulate({ from: sandbox.admin })
      await sandbox.battleship.methods
        .start_game(salt, authwitNonce)
        .send({ from: sandbox.admin })
      const gameId = '0x' + (sim.result as bigint).toString(16).padStart(64, '0')
      await refreshGame(sandbox, gameId)
      await refreshBalance(sandbox)
    } catch (e) {
      setError(formatError(e))
    } finally {
      setBusy(false)
    }
  }

  async function handleFire(cell: number) {
    if (!sandbox?.battleship || !game) return
    const bit = 1n << BigInt(cell)
    if ((game.shotsMask & bit) !== 0n) return
    if (game.status !== 0) return
    setBusy(true)
    setError(null)
    setLastShot(null)
    try {
      const { Fr } = await import('@aztec/aztec.js/fields')
      const gameIdFr = new Fr(BigInt(game.gameId))
      const hitsBefore = game.hits
      await sandbox.battleship.methods
        .fire(gameIdFr, cell)
        .send({ from: sandbox.admin })
      await refreshGame(sandbox, game.gameId)
      const hitsAfter = (
        await sandbox.battleship.methods.get_hits(gameIdFr).simulate({ from: sandbox.admin })
      ).result as bigint
      setLastShot({ cell, hit: Number(hitsAfter) > hitsBefore })
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
        <h3 className="text-lg font-semibold">Battleship — variant g2</h3>
        <button onClick={onClose} className="text-sm text-black/50 underline-offset-4 hover:underline">
          Close
        </button>
      </div>
      <p className="mt-2 text-sm text-black/60">
        Pay {Number(ENTRY_FEE).toLocaleString()} AZA from your private balance to start an 8×8
        board. One 3-cell ship is placed horizontally somewhere on the grid. Each shot is a private
        function call so your address stays out of public state; the contract checks the hit
        publicly. Sink the ship ({SHIP_LEN} hits) to win.
      </p>
      <p className="mt-2 rounded border border-amber-200 bg-amber-50 p-2 text-xs text-amber-900">
        <strong>Trust caveat:</strong> ship position is derived from{' '}
        <code className="font-mono text-[10px]">pedersen(player, salt)</code>. Anyone with the
        emitted game_id (= seed) can recompute the ship's position off-chain. Honest demo of
        private-action / public-state separation; not for stakes.
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
                <span className="font-mono">
                  hits: {game.hits} / {SHIP_LEN}
                </span>
                <span
                  className={`rounded-full px-2 py-0.5 ${
                    game.status === 0
                      ? 'bg-sky-100 text-sky-900'
                      : 'bg-emerald-100 text-emerald-900'
                  }`}
                >
                  {game.status === 0 ? 'active' : 'won (ship sunk)'}
                </span>
              </div>
              <div
                className="mt-3 grid gap-1.5"
                style={{ gridTemplateColumns: `repeat(${BOARD_SIDE}, minmax(0, 1fr))`, width: 360 }}
              >
                {Array.from({ length: BOARD_CELLS }, (_, i) => {
                  const bit = 1n << BigInt(i)
                  const fired = (game.shotsMask & bit) !== 0n
                  const wasHit = lastShot?.cell === i && lastShot?.hit
                  const wasMiss = lastShot?.cell === i && !lastShot?.hit
                  return (
                    <button
                      key={i}
                      onClick={() => handleFire(i)}
                      disabled={busy || fired || game.status !== 0}
                      className={`aspect-square rounded text-xs font-mono ${
                        wasHit
                          ? 'bg-rose-600 text-white'
                          : wasMiss
                            ? 'bg-zinc-300 text-zinc-700'
                            : fired
                              ? 'bg-zinc-200 text-zinc-500'
                              : 'bg-sky-100 text-sky-700 hover:bg-sky-200 disabled:opacity-50'
                      }`}
                    >
                      {fired ? (wasHit ? '✗' : '·') : i}
                    </button>
                  )
                })}
              </div>
              <p className="mt-2 text-[10px] text-black/50">
                ✗ = hit · · = miss · numbers = unshot cells. Win when all {SHIP_LEN} ship cells are
                hit.
              </p>
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
