import { useState } from 'react'
import type { Fr as FrType } from '@aztec/aztec.js/fields'
import { initBrowserSandbox, type BrowserSandbox } from '../lib/browser-sandbox'
import type { SandboxState } from '../lib/sandbox-state'
import {
  buildDeck,
  cardLabel,
  handTotal,
  type Deck,
  DEALER_BASE,
  PLAYER_BASE,
  MAX_CARDS,
  DECK_DEPTH,
} from '../lib/blackjack-deck'
import { PrivacyLeakage } from './ui/PrivacyLeakage'

interface Props {
  state: SandboxState
  onClose: () => void
}

type Phase = 'idle' | 'dealing' | 'playing' | 'settling' | 'done'

interface Game {
  gameId: string
  deck: Deck
  playerCards: number[] // deck positions consumed by player (0..)
  dealerCards: number[]
}

const OUTCOMES = ['Dealer wins', 'You win', 'Push'] // index = on-chain outcome

export function BlackjackPanel({ state, onClose }: Props) {
  const [sandbox, setSandbox] = useState<BrowserSandbox | null>(null)
  const [progress, setProgress] = useState<string | null>(null)
  const [error, setError] = useState<string | null>(null)
  const [busy, setBusy] = useState(false)
  const [phase, setPhase] = useState<Phase>('idle')
  const [game, setGame] = useState<Game | null>(null)
  const [result, setResult] = useState<{ outcome: number; pTotal: number; dTotal: number } | null>(null)
  const [gamesSettled, setGamesSettled] = useState<number>(0)

  async function handleInit() {
    setError(null)
    setBusy(true)
    try {
      const sb = await initBrowserSandbox(state, setProgress)
      if (!sb.blackjack) throw new Error('Blackjack not deployed - re-run sandbox:setup')
      setSandbox(sb)
      const gs = await sb.blackjack.methods.get_games_settled().simulate({ from: sb.admin })
      setGamesSettled(Number(gs.result))
    } catch (e) {
      setError(formatError(e))
    } finally {
      setBusy(false)
    }
  }

  // New game: player + dealer commit entropy; dealer publishes the committed
  // shuffled deck root. Two txs (commit, start_hand).
  async function newGame() {
    if (!sandbox?.blackjack) return
    setBusy(true)
    setError(null)
    setResult(null)
    setPhase('dealing')
    try {
      const { Fr } = await import('@aztec/aztec.js/fields')
      const { poseidon2Hash } = await import('@aztec/foundation/crypto/sync')
      const gameId = Fr.random()
      const playerSeed = Fr.random()
      const dealerSeed = Fr.random()
      const deckSalt = Fr.random()
      const playerCommit = poseidon2Hash([playerSeed])
      const dealerCommit = poseidon2Hash([dealerSeed])
      // Combined entropy → deck. (Off-chain the player would reveal playerSeed to
      // the dealer here; in this single-session demo we hold both.)
      const combined = poseidon2Hash([playerSeed, dealerSeed])
      const deck = buildDeck(combined.toString(), deckSalt.toString())

      await sandbox.blackjack.methods
        .commit(gameId, playerCommit)
        .send({ from: sandbox.admin })
      await sandbox.blackjack.methods
        .start_hand(gameId, dealerCommit, Fr.fromString(deck.root), deckSalt)
        .send({ from: sandbox.admin })

      setGame({
        gameId: gameId.toString(),
        deck,
        playerCards: [PLAYER_BASE, PLAYER_BASE + 1], // hole cards
        dealerCards: [DEALER_BASE], // dealer up-card only for now
      })
      setPhase('playing')
    } catch (e) {
      setError(formatError(e))
      setPhase('idle')
    } finally {
      setBusy(false)
    }
  }

  function hit() {
    if (!game || phase !== 'playing') return
    if (game.playerCards.length >= MAX_CARDS) return
    const next = game.playerCards.length // next player position
    const updated = { ...game, playerCards: [...game.playerCards, PLAYER_BASE + next] }
    setGame(updated)
    const total = handTotal(updated.playerCards.map((p) => updated.deck.order[p]))
    if (total > 21) void stand(updated) // auto-stand on bust
  }

  // Stand → dealer plays deterministically (hit until 17), then settle on-chain.
  async function stand(g?: Game) {
    const cur = g ?? game
    if (!sandbox?.blackjack || !cur) return
    setBusy(true)
    setError(null)
    setPhase('settling')
    try {
      const { Fr } = await import('@aztec/aztec.js/fields')
      // Dealer auto-play from positions DEALER_BASE.. until total >= 17 or 5 cards.
      const dealerCards = [DEALER_BASE, DEALER_BASE + 1]
      while (
        handTotal(dealerCards.map((p) => cur.deck.order[p])) < 17 &&
        dealerCards.length < MAX_CARDS
      ) {
        dealerCards.push(DEALER_BASE + dealerCards.length)
      }

      const ZERO_PATH: FrType[] = Array(DECK_DEPTH).fill(Fr.ZERO)
      const pad = (positions: number[]) => {
        const cards: bigint[] = []
        const paths: FrType[][] = []
        for (let i = 0; i < MAX_CARDS; i++) {
          if (i < positions.length) {
            const pos = positions[i]
            cards.push(BigInt(cur.deck.order[pos]))
            paths.push(cur.deck.proofs[pos].siblingPath.map((s) => Fr.fromString(s)))
          } else {
            cards.push(0n)
            paths.push(ZERO_PATH)
          }
        }
        return { cards, paths }
      }
      const p = pad(cur.playerCards)
      const d = pad(dealerCards)

      await sandbox.blackjack.methods
        .settle(
          Fr.fromString(cur.gameId),
          Fr.fromString(cur.deck.root),
          Fr.fromString(cur.deck.saltHex),
          p.cards,
          cur.playerCards.length,
          p.paths,
          d.cards,
          dealerCards.length,
          d.paths,
        )
        .send({ from: sandbox.admin })

      const [oc, pt, dt, gs] = await Promise.all([
        sandbox.blackjack.methods.get_outcome(Fr.fromString(cur.gameId)).simulate({ from: sandbox.admin }),
        sandbox.blackjack.methods.get_player_total(Fr.fromString(cur.gameId)).simulate({ from: sandbox.admin }),
        sandbox.blackjack.methods.get_dealer_total(Fr.fromString(cur.gameId)).simulate({ from: sandbox.admin }),
        sandbox.blackjack.methods.get_games_settled().simulate({ from: sandbox.admin }),
      ])
      setGame({ ...cur, dealerCards })
      setResult({ outcome: Number(oc.result), pTotal: Number(pt.result), dTotal: Number(dt.result) })
      setGamesSettled(Number(gs.result))
      setPhase('done')
    } catch (e) {
      setError(formatError(e))
      setPhase('playing')
    } finally {
      setBusy(false)
    }
  }

  const playerVals = game ? game.playerCards.map((p) => game.deck.order[p]) : []
  const playerTotal = handTotal(playerVals)
  const dealerUp = game ? game.deck.order[game.dealerCards[0]] : null

  return (
    <section className="mt-10 rounded-2xl border border-black/10 bg-white p-6">
      <div className="flex items-center justify-between">
        <h3 className="text-lg font-semibold">Blackjack — fair + private (variant g4)</h3>
        <button onClick={onClose} className="text-sm text-black/50 underline-offset-4 hover:underline">
          Close
        </button>
      </div>
      <p className="mt-2 text-sm text-black/60">
        Player and dealer each commit entropy; the combined seed shuffles a deck the dealer commits
        as a Merkle root. You can&apos;t see future cards (you never learn the dealer&apos;s seed
        mid-hand); the dealer can&apos;t swap cards (committed). At showdown your hand is a{' '}
        <strong>private witness</strong> — the circuit Merkle-verifies every card and publishes only
        your total + the outcome, never your cards.
      </p>
      <p className="mt-2 rounded border border-emerald-200 bg-emerald-50 p-2 text-xs text-emerald-900">
        <strong>Fairness:</strong> neither side alone chooses the shuffle (combined commit-reveal);
        the dealer reveals its seed afterward so the shuffle is auditable. <strong>Privacy:</strong>{' '}
        your cards stay off public state; settle proves your total in zero-knowledge.
      </p>
      <p className="mt-2 rounded border border-amber-200 bg-amber-50 p-2 text-xs text-amber-900">
        <strong>Demo note:</strong> one browser session plays both player and dealer (like the PvP
        battleship variant), so it necessarily knows both seeds — the no-cheat + fairness properties
        are still enforced by the contract. A real deployment runs the dealer as a separate online
        operator that hands you cards one at a time.
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
          <div className="mt-4 flex items-center gap-3 text-xs">
            <span className="rounded-full border border-black/10 bg-zinc-50 px-3 py-1">
              games settled: <span className="font-mono">{gamesSettled}</span>
            </span>
            {phase === 'idle' || phase === 'done' ? (
              <button
                onClick={newGame}
                disabled={busy}
                className="rounded-full bg-violet-600 px-4 py-1.5 font-medium text-white hover:opacity-90 disabled:opacity-50"
              >
                {busy ? 'Dealing…' : 'New hand'}
              </button>
            ) : null}
          </div>

          {game && (
            <div className="mt-4 grid grid-cols-1 gap-3 md:grid-cols-2">
              <div className="rounded-xl border border-black/10 bg-zinc-50 p-4">
                <p className="text-[10px] uppercase tracking-wide text-black/40">Your hand (private)</p>
                <p className="mt-1 font-mono text-2xl">
                  {playerVals.map((c) => cardLabel(c)).join('  ')}
                </p>
                <p className="mt-1 text-sm text-black/60">total {playerTotal}{playerTotal > 21 ? ' · bust' : ''}</p>
              </div>
              <div className="rounded-xl border border-black/10 bg-zinc-50 p-4">
                <p className="text-[10px] uppercase tracking-wide text-black/40">Dealer</p>
                <p className="mt-1 font-mono text-2xl">
                  {phase === 'done'
                    ? game.dealerCards.map((p) => cardLabel(game.deck.order[p])).join('  ')
                    : dealerUp !== null
                      ? `${cardLabel(dealerUp)}  ??`
                      : '—'}
                </p>
                <p className="mt-1 text-sm text-black/60">
                  {phase === 'done' && result ? `total ${result.dTotal}` : 'one card hidden'}
                </p>
              </div>
            </div>
          )}

          {phase === 'playing' && (
            <div className="mt-3 flex gap-3">
              <button
                onClick={hit}
                disabled={busy || playerTotal > 21 || (game?.playerCards.length ?? 0) >= MAX_CARDS}
                className="rounded-full bg-violet-600 px-4 py-2 text-sm font-medium text-white hover:opacity-90 disabled:opacity-40"
              >
                Hit
              </button>
              <button
                onClick={() => stand()}
                disabled={busy}
                className="rounded-full border border-violet-600 bg-violet-50 px-4 py-2 text-sm font-medium text-violet-700 hover:bg-violet-100 disabled:opacity-40"
              >
                Stand
              </button>
            </div>
          )}

          {phase === 'settling' && (
            <p className="mt-3 text-sm text-black/50">
              Proving your hand in zero-knowledge + settling…
            </p>
          )}

          {phase === 'done' && result && (
            <p
              className={`mt-4 rounded-lg border p-3 text-sm ${
                result.outcome === 1
                  ? 'border-emerald-200 bg-emerald-50 text-emerald-900'
                  : result.outcome === 2
                    ? 'border-amber-200 bg-amber-50 text-amber-900'
                    : 'border-rose-200 bg-rose-50 text-rose-900'
              }`}
            >
              {OUTCOMES[result.outcome]} — you {result.pTotal}, dealer {result.dTotal}. Only these
              totals + the outcome reached public state; your individual cards never did.
            </p>
          )}

          <PrivacyLeakage
            className="mt-4"
            publicLeaks={['final totals', 'win/lose/push outcome', 'dealer hand (at showdown)']}
            staysPrivate={['your cards (ZK witness)', 'your hit/stand decisions', 'the deck during play']}
          />

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
