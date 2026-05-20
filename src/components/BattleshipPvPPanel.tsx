import { useState } from 'react'
import { initBrowserSandbox, type BrowserSandbox } from '../lib/browser-sandbox'
import type { SandboxState } from '../lib/sandbox-state'
import { PrivacyLeakage } from './ui/PrivacyLeakage'

interface Props {
  state: SandboxState
  onClose: () => void
}

const BOARD = 9 // 3x3
const SHIP_LEN = 2

type Phase = 'setup' | 'playing'
interface Fleet {
  cells: number[]
  salt: string // Fr hex
}
// shot results keyed by `${board}-${cell}` where board is 'A' or 'B'
type ShotMap = Record<string, boolean> // true = hit

async function fleetCommitment(cells: number[], saltHex: string): Promise<bigint> {
  const { Fr } = await import('@aztec/aztec.js/fields')
  const { pedersenHash } = await import('@aztec/foundation/crypto/sync')
  // matches Noir pedersen_hash([c0 as Field, c1 as Field, salt])
  return pedersenHash([
    new Fr(BigInt(cells[0])),
    new Fr(BigInt(cells[1])),
    Fr.fromString(saltHex),
  ]).toBigInt()
}

export function BattleshipPvPPanel({ state, onClose }: Props) {
  const [sandbox, setSandbox] = useState<BrowserSandbox | null>(null)
  const [progress, setProgress] = useState<string | null>(null)
  const [error, setError] = useState<string | null>(null)
  const [busy, setBusy] = useState(false)
  const [phase, setPhase] = useState<Phase>('setup')

  const [placing, setPlacing] = useState<'A' | 'B'>('A')
  const [fleetA, setFleetA] = useState<Fleet>({ cells: [], salt: '' })
  const [fleetB, setFleetB] = useState<Fleet>({ cells: [], salt: '' })

  const [gameId, setGameId] = useState<string | null>(null)
  const [status, setStatus] = useState<number>(1) // 1 active, 2 A won, 3 B won
  const [turn, setTurn] = useState<number>(0) // 0 = A fires, 1 = B fires
  const [hitsA, setHitsA] = useState<number>(0)
  const [hitsB, setHitsB] = useState<number>(0)
  const [shots, setShots] = useState<ShotMap>({})

  async function handleInit() {
    setError(null)
    setBusy(true)
    try {
      const sb = await initBrowserSandbox(state, setProgress)
      if (!sb.battleshipPvp) throw new Error('BattleshipPvP not deployed - re-run sandbox:setup')
      setSandbox(sb)
    } catch (e) {
      setError(formatError(e))
    } finally {
      setBusy(false)
    }
  }

  function toggleCell(board: 'A' | 'B', cell: number) {
    if (board !== placing) return
    const setFleet = board === 'A' ? setFleetA : setFleetB
    // Functional update so rapid clicks don't read stale state.
    setFleet((prev) => {
      const has = prev.cells.includes(cell)
      let cells: number[]
      if (has) cells = prev.cells.filter((c) => c !== cell)
      else if (prev.cells.length < SHIP_LEN) cells = [...prev.cells, cell]
      else cells = prev.cells
      return { ...prev, cells }
    })
  }

  async function refreshStatus(sb: BrowserSandbox, id: string) {
    if (!sb.battleshipPvp) return
    const { Fr } = await import('@aztec/aztec.js/fields')
    const idFr = Fr.fromString(id)
    const [st, tn, ha, hb] = await Promise.all([
      sb.battleshipPvp.methods.get_status(idFr).simulate({ from: sb.admin }),
      sb.battleshipPvp.methods.get_turn(idFr).simulate({ from: sb.admin }),
      sb.battleshipPvp.methods.get_hits_a(idFr).simulate({ from: sb.admin }),
      sb.battleshipPvp.methods.get_hits_b(idFr).simulate({ from: sb.admin }),
    ])
    setStatus(Number(st.result))
    setTurn(Number(tn.result))
    setHitsA(Number(ha.result))
    setHitsB(Number(hb.result))
  }

  async function handleStartGame() {
    if (!sandbox?.battleshipPvp) return
    if (fleetA.cells.length !== SHIP_LEN || fleetB.cells.length !== SHIP_LEN) {
      setError(`place ${SHIP_LEN} cells on each board`)
      return
    }
    setBusy(true)
    setError(null)
    try {
      const { Fr } = await import('@aztec/aztec.js/fields')
      const saltA = Fr.random()
      const saltB = Fr.random()
      const fa = { ...fleetA, salt: saltA.toString() }
      const fb = { ...fleetB, salt: saltB.toString() }
      setFleetA(fa)
      setFleetB(fb)
      const commitA = await fleetCommitment(fa.cells, fa.salt)
      const commitB = await fleetCommitment(fb.cells, fb.salt)
      const gameSalt = Fr.random()
      // create_game returns game_id; pull it from simulation.
      const sim = await sandbox.battleshipPvp.methods
        .create_game(commitA, gameSalt)
        .simulate({ from: sandbox.admin })
      await sandbox.battleshipPvp.methods
        .create_game(commitA, gameSalt)
        .send({ from: sandbox.admin })
      const id = '0x' + (sim.result as bigint).toString(16).padStart(64, '0')
      await sandbox.battleshipPvp.methods
        .join_game(Fr.fromString(id), commitB)
        .send({ from: sandbox.admin })
      setGameId(id)
      setPhase('playing')
      await refreshStatus(sandbox, id)
    } catch (e) {
      setError(formatError(e))
    } finally {
      setBusy(false)
    }
  }

  // Current shooter fires at `cell` on the opponent's board, then the
  // defender auto-answers (this browser knows both fleets) with a ZK
  // hit/miss proof against their commitment.
  async function handleFire(cell: number) {
    if (!sandbox?.battleshipPvp || !gameId || status !== 1) return
    const shooter = turn // 0 = A fires at B, 1 = B fires at A
    const defenderBoard = shooter === 0 ? 'B' : 'A'
    const key = `${defenderBoard}-${cell}`
    if (key in shots) return // already fired here
    setBusy(true)
    setError(null)
    try {
      const { Fr } = await import('@aztec/aztec.js/fields')
      const idFr = Fr.fromString(gameId)
      await sandbox.battleshipPvp.methods.fire(idFr, cell).send({ from: sandbox.admin })
      // Auto-answer as the defender.
      const defFleet = shooter === 0 ? fleetB : fleetA
      await sandbox.battleshipPvp.methods
        .answer(idFr, defFleet.cells[0], defFleet.cells[1], Fr.fromString(defFleet.salt), cell)
        .send({ from: sandbox.admin })
      const isHit = defFleet.cells.includes(cell)
      setShots((prev) => ({ ...prev, [key]: isHit }))
      await refreshStatus(sandbox, gameId)
    } catch (e) {
      setError(formatError(e))
    } finally {
      setBusy(false)
    }
  }

  function renderBoard(board: 'A' | 'B') {
    const fleet = board === 'A' ? fleetA : fleetB
    const isSetup = phase === 'setup'
    // During play, the shooter fires at the OPPONENT board.
    const shooterBoard = turn === 0 ? 'B' : 'A'
    const canFire = phase === 'playing' && status === 1 && board === shooterBoard
    return (
      <div>
        <p className="mb-1 text-xs font-medium">
          Player {board}'s board{' '}
          {isSetup && placing === board && (
            <span className="text-violet-600">(placing {fleet.cells.length}/{SHIP_LEN})</span>
          )}
          {phase === 'playing' && canFire && (
            <span className="text-rose-600">← fire here</span>
          )}
        </p>
        <div className="grid w-32 grid-cols-3 gap-1">
          {Array.from({ length: BOARD }, (_, i) => {
            const isShip = fleet.cells.includes(i)
            const key = `${board}-${i}`
            const fired = key in shots
            const hit = shots[key]
            // During play we always reveal own ships (single-browser demo).
            let cls = 'bg-zinc-100 text-zinc-400'
            let label = `${i}`
            if (fired && hit) { cls = 'bg-rose-600 text-white'; label = '✗' }
            else if (fired && !hit) { cls = 'bg-zinc-300 text-zinc-600'; label = '·' }
            else if (isShip) { cls = 'bg-sky-200 text-sky-900' }
            return (
              <button
                key={i}
                onClick={() => (isSetup ? toggleCell(board, i) : canFire ? handleFire(i) : undefined)}
                disabled={busy || (isSetup && placing !== board) || (!isSetup && !canFire) || fired}
                className={`aspect-square rounded text-xs font-mono ${cls} disabled:opacity-60`}
              >
                {label}
              </button>
            )
          })}
        </div>
      </div>
    )
  }

  const winner = status === 2 ? 'A' : status === 3 ? 'B' : null

  return (
    <section className="mt-10 rounded-2xl border border-black/10 bg-white p-6">
      <div className="flex items-center justify-between">
        <h3 className="text-lg font-semibold">Battleship PvP - variant g3 (trustless)</h3>
        <button onClick={onClose} className="text-sm text-black/50 underline-offset-4 hover:underline">
          Close
        </button>
      </div>
      <p className="mt-2 text-sm text-black/60">
        Two players, two hidden fleets, no contract-side randomness or trusted operator. Each
        player commits a fleet hash; when fired upon, the defender proves hit/miss against that
        commitment in a private function - revealing only the boolean, never the fleet. First to
        sink the opponent's {SHIP_LEN}-cell ship wins.
      </p>
      <p className="mt-2 rounded border border-emerald-200 bg-emerald-50 p-2 text-xs text-emerald-900">
        <strong>Privacy property:</strong> fleet commitment = pedersen(c0, c1, salt). The contract
        + observers only ever see the two commitments + per-shot hit/miss booleans. Neither fleet
        is ever revealed on chain. The defender can't lie about hit/miss without breaking their
        commitment.
      </p>
      <p className="mt-2 rounded border border-amber-200 bg-amber-50 p-2 text-xs text-amber-900">
        <strong>Demo note:</strong> this browser plays BOTH players for convenience, so it knows
        both fleets (shown in blue). That's a UI shortcut - in a real game each player runs their
        own PXE and never sees the other's fleet; the contract enforces it via the commitments.
        Ship-placement validity (adjacency) isn't constrained in this MVP.
      </p>

      {!sandbox ? (
        <div className="mt-4">
          <button
            onClick={handleInit}
            disabled={busy}
            className="rounded-full bg-[var(--color-ink)] px-4 py-2 text-sm font-medium text-[var(--color-paper)] hover:opacity-90 disabled:opacity-50"
          >
            {busy ? 'Initializing...' : 'Initialize browser PXE'}
          </button>
          {progress && busy && <p className="mt-2 text-xs text-black/50">{progress}</p>}
        </div>
      ) : (
        <>
          {phase === 'setup' && (
            <div className="mt-4">
              <p className="text-sm font-medium">
                1 · Place ships ({SHIP_LEN} cells each)
              </p>
              <div className="mt-2 flex items-center gap-2 text-xs">
                <span>Placing for:</span>
                <button
                  onClick={() => setPlacing('A')}
                  className={`rounded-full px-3 py-1 ${placing === 'A' ? 'bg-violet-600 text-white' : 'bg-zinc-100'}`}
                >
                  Player A
                </button>
                <button
                  onClick={() => setPlacing('B')}
                  className={`rounded-full px-3 py-1 ${placing === 'B' ? 'bg-violet-600 text-white' : 'bg-zinc-100'}`}
                >
                  Player B
                </button>
              </div>
              <div className="mt-3 flex gap-8">
                {renderBoard('A')}
                {renderBoard('B')}
              </div>
              <button
                onClick={handleStartGame}
                disabled={busy || fleetA.cells.length !== SHIP_LEN || fleetB.cells.length !== SHIP_LEN}
                className="mt-4 rounded-full bg-violet-600 px-4 py-2 text-sm font-medium text-white hover:opacity-90 disabled:opacity-50"
              >
                {busy ? 'Committing fleets...' : 'Start game (commit both fleets)'}
              </button>
              <PrivacyLeakage
                className="mt-2"
                publicLeaks={['two fleet commitment hashes']}
                staysPrivate={['both fleets (ship positions + salts)']}
              />
            </div>
          )}

          {phase === 'playing' && (
            <div className="mt-4">
              <div className="flex flex-wrap items-center gap-3 text-xs">
                <span className="font-mono">
                  hits — A: {hitsA}/{SHIP_LEN} · B: {hitsB}/{SHIP_LEN}
                </span>
                {winner ? (
                  <span className="rounded-full bg-emerald-100 px-2 py-0.5 text-emerald-900">
                    Player {winner} wins!
                  </span>
                ) : (
                  <span className="rounded-full bg-sky-100 px-2 py-0.5 text-sky-900">
                    Player {turn === 0 ? 'A' : 'B'} to fire
                  </span>
                )}
              </div>
              <div className="mt-3 flex gap-8">
                {renderBoard('A')}
                {renderBoard('B')}
              </div>
              <PrivacyLeakage
                className="mt-3"
                publicLeaks={['fired cell', 'hit/miss boolean', 'hit counters']}
                staysPrivate={['defender fleet (re-proven against commitment each answer)']}
              />
              <p className="mt-2 text-[11px] text-black/50">
                Each shot = 2 txs: fire (public) + answer (private ZK proof of hit/miss). The
                defender re-opens their committed fleet as private inputs; only the boolean lands
                on chain.
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
