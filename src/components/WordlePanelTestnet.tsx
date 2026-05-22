import { useEffect, useState } from 'react'
import {
  getResolvedTestnetClient,
  subscribeTestnetClient,
  type TestnetClient,
} from '../lib/browser-testnet'
import type { SandboxState } from '../lib/sandbox-state'
import { PrivacyLeakage } from './ui/PrivacyLeakage'
import type { WordleContract } from '../contracts/Wordle'

interface Props {
  state: SandboxState
  onClose: () => void
}

interface LocalGuess {
  word: string
  salt: string // hex Fr
}

function packWord(word: string): bigint {
  if (word.length !== 5) throw new Error('word must be 5 letters')
  let packed = 0n
  for (let i = 0; i < 5; i++) {
    packed = packed * 256n + BigInt(word.charCodeAt(i))
  }
  return packed
}

function unpackWord(packed: bigint): string {
  let s = ''
  for (let i = 0; i < 5; i++) {
    const c = Number(packed & 0xffn)
    s = String.fromCharCode(c) + s
    packed >>= 8n
  }
  return s
}

function formatTime(seconds: number): string {
  if (seconds <= 0) return 'closed'
  const m = Math.floor(seconds / 60)
  const s = seconds % 60
  return `${m}m ${s}s`
}

export function WordlePanelTestnet({ state, onClose }: Props) {
  const [client, setClient] = useState<TestnetClient | null>(getResolvedTestnetClient())
  const [contract, setContract] = useState<WordleContract | null>(null)
  const [error, setError] = useState<string | null>(null)
  const [busy, setBusy] = useState(false)
  const [guessInput, setGuessInput] = useState<string>('')
  const [guesses, setGuesses] = useState<LocalGuess[]>([])
  const [attempts, setAttempts] = useState<number>(0)
  const [solvedOn, setSolvedOn] = useState<number>(0)
  const [revealedWord, setRevealedWord] = useState<string | null>(null)
  const [now, setNow] = useState<number>(Math.floor(Date.now() / 1000))

  const cfg = state.wordle
  const guessDeadline = cfg ? Number(cfg.guessDeadline) : 0
  const revealDeadline = cfg ? Number(cfg.revealDeadline) : 0
  const inGuessWindow = now < guessDeadline
  const inRevealWindow = now >= guessDeadline && now < revealDeadline

  useEffect(() => subscribeTestnetClient(setClient), [])

  useEffect(() => {
    let cancelled = false
    async function poll() {
      try {
        const res = await fetch(state.sandboxUrl, {
          method: 'POST',
          headers: { 'content-type': 'application/json' },
          body: JSON.stringify({
            jsonrpc: '2.0', id: 1, method: 'node_getBlockHeader', params: [],
          }),
        })
        const data = (await res.json()) as {
          result?: { globalVariables?: { timestamp?: string | number | bigint } }
        }
        const ts = data?.result?.globalVariables?.timestamp
        if (ts != null && !cancelled) {
          setNow(Number(ts))
          return
        }
      } catch {
        // fall through to wall-clock fallback
      }
      if (!cancelled) setNow(Math.floor(Date.now() / 1000))
    }
    void poll()
    const tick = setInterval(poll, 5000)
    return () => {
      cancelled = true
      clearInterval(tick)
    }
  }, [state.sandboxUrl])

  // Attach the Wordle contract to the per-tab wallet.
  useEffect(() => {
    if (!client || !cfg) return
    let cancelled = false
    ;(async () => {
      try {
        const [{ jsonParseWithSchema }, { ContractInstanceWithAddressSchema }, mod, { AztecAddress }] =
          await Promise.all([
            import('@aztec/foundation/json-rpc'),
            import('@aztec/stdlib/contract'),
            import('../contracts/Wordle'),
            import('@aztec/aztec.js/addresses'),
          ])
        const inst = jsonParseWithSchema(
          JSON.stringify(cfg.instance),
          ContractInstanceWithAddressSchema,
        )
        await (client.wallet as unknown as {
          registerContract: (i: unknown, a: unknown) => Promise<void>
        }).registerContract(inst, mod.WordleContractArtifact)
        const c = await mod.WordleContract.at(AztecAddress.fromString(cfg.address), client.wallet)
        if (!cancelled) setContract(c as unknown as WordleContract)
      } catch (e) {
        if (!cancelled) setError(formatError(e))
      }
    })()
    return () => {
      cancelled = true
    }
  }, [client, cfg])

  async function refreshStatus(c: WordleContract, cl: TestnetClient) {
    const [attemptsR, solvedR, revealedR] = await Promise.all([
      c.methods.get_attempts(cl.address).simulate({ from: cl.address }),
      c.methods.get_solved_on(cl.address).simulate({ from: cl.address }),
      c.methods.get_challenge_revealed().simulate({ from: cl.address }),
    ])
    setAttempts(Number(attemptsR.result))
    setSolvedOn(Number(solvedR.result))
    const packed = revealedR.result as { toBigInt?: () => bigint } | bigint
    const packedBig =
      typeof packed === 'bigint' ? packed : (packed as { toBigInt: () => bigint }).toBigInt()
    if (packedBig === 0n) setRevealedWord(null)
    else setRevealedWord(unpackWord(packedBig))
  }

  useEffect(() => {
    if (contract && client) void refreshStatus(contract, client)
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [contract, client])

  async function handleSubmitGuess() {
    if (!contract || !client) return
    setBusy(true)
    setError(null)
    try {
      const word = guessInput.trim().toLowerCase()
      if (word.length !== 5) throw new Error('must be exactly 5 letters')
      if (!/^[a-z]{5}$/.test(word)) throw new Error('letters a-z only')
      const packed = packWord(word)
      const { Fr } = await import('@aztec/aztec.js/fields')
      const salt = Fr.random()
      await contract.methods
        .submit_guess(packed, salt)
        .send({ from: client.address, fee: client.feeOpts })
      setGuesses((prev) => [...prev, { word, salt: salt.toString() }])
      setGuessInput('')
      await refreshStatus(contract, client)
    } catch (e) {
      setError(formatError(e))
    } finally {
      setBusy(false)
    }
  }

  async function handleProveSolve(g: LocalGuess) {
    if (!contract || !client) return
    setBusy(true)
    setError(null)
    try {
      const packed = packWord(g.word)
      const { Fr } = await import('@aztec/aztec.js/fields')
      const salt = Fr.fromString(g.salt)
      await contract.methods
        .prove_solve(packed, salt)
        .send({ from: client.address, fee: client.feeOpts })
      await refreshStatus(contract, client)
    } catch (e) {
      setError(formatError(e))
    } finally {
      setBusy(false)
    }
  }

  const winningGuess = revealedWord ? guesses.find((g) => g.word === revealedWord) : null

  return (
    <section className="mt-10 rounded-2xl border border-black/10 bg-white p-6">
      <div className="flex items-center justify-between">
        <h3 className="text-lg font-semibold">Wordle — variant g6 (testnet)</h3>
        <button onClick={onClose} className="text-sm text-black/50 underline-offset-4 hover:underline">
          Close
        </button>
      </div>
      <p className="mt-2 text-sm text-black/60">
        Live on Aztec testnet. Guess the 5-letter word with your per-tab account. Each guess emits
        a commitment hash on chain — the actual letters stay private. When the operator reveals the
        target, you can prove on which attempt you got it right without showing any of your other
        tries. Up to 6 guesses.
      </p>
      <p className="mt-2 rounded border border-emerald-200 bg-emerald-50 p-2 text-xs text-emerald-900">
        <strong>Privacy property:</strong> per-guess commitment = pedersen(your_address, word_packed, salt).
        Observers see your attempt counter tick from 0 to N, but the words themselves stay
        encrypted in your PXE.
      </p>
      <p className="mt-2 rounded border border-amber-200 bg-amber-50 p-2 text-xs text-amber-900">
        <strong>Honest caveat:</strong> no per-guess green/yellow/gray feedback. That would
        require the contract to know the target word mid-round, which would leak it. Here you guess
        blind; the target reveals at end-of-round.
      </p>

      {!client ? (
        <p className="mt-4 rounded border border-amber-200 bg-amber-50 p-3 text-sm text-amber-900">
          Initialize your testnet account in the wallet panel above first (the per-tab Schnorr
          account funded by SponsoredFPC). Then this panel activates.
        </p>
      ) : !contract ? (
        <p className="mt-4 text-sm text-black/50">Attaching contract…</p>
      ) : (
        <>
          <div className="mt-4 grid grid-cols-1 gap-3 md:grid-cols-3">
            <div className="rounded-xl border border-black/10 bg-zinc-50 p-3 text-xs">
              <p className="text-[10px] uppercase tracking-wide text-black/40">Guess window</p>
              <p className="mt-1 font-mono text-sm">
                {inGuessWindow ? formatTime(guessDeadline - now) + ' left' : 'closed'}
              </p>
            </div>
            <div className="rounded-xl border border-black/10 bg-zinc-50 p-3 text-xs">
              <p className="text-[10px] uppercase tracking-wide text-black/40">Reveal window</p>
              <p className="mt-1 font-mono text-sm">
                {inRevealWindow
                  ? formatTime(revealDeadline - now) + ' left'
                  : now < guessDeadline
                    ? 'opens when guess window closes'
                    : 'closed'}
              </p>
            </div>
            <div className="rounded-xl border border-black/10 bg-zinc-50 p-3 text-xs">
              <p className="text-[10px] uppercase tracking-wide text-black/40">Your state</p>
              <p className="mt-1 font-mono text-sm">attempts: {attempts} / 6</p>
              <p className="mt-1 font-mono text-xs">
                solved on: {solvedOn === 0 ? '-' : `attempt ${solvedOn}`}
              </p>
            </div>
          </div>

          <div className="mt-5 rounded-xl border border-black/10 p-4">
            <p className="text-sm font-medium">Submit a guess</p>
            <div className="mt-2 flex flex-wrap items-center gap-3">
              <input
                type="text"
                maxLength={5}
                value={guessInput}
                onChange={(e) => setGuessInput(e.target.value)}
                disabled={!inGuessWindow || busy || attempts >= 6}
                placeholder="apple"
                className="w-32 rounded border border-black/15 px-2 py-1 font-mono text-sm uppercase disabled:opacity-40"
              />
              <button
                onClick={handleSubmitGuess}
                disabled={!inGuessWindow || busy || attempts >= 6 || guessInput.length !== 5}
                className="rounded-full bg-violet-600 px-4 py-2 text-sm font-medium text-white hover:opacity-90 disabled:opacity-50"
              >
                {busy ? 'Working…' : 'Submit guess'}
              </button>
              {!inGuessWindow && (
                <span className="text-xs text-black/50">Guess window closed.</span>
              )}
              {inGuessWindow && attempts >= 6 && (
                <span className="text-xs text-black/50">All 6 attempts used.</span>
              )}
            </div>
            <PrivacyLeakage
              className="mt-2"
              publicLeaks={['your attempt counter +1', 'opaque commitment hash']}
              staysPrivate={['guessed word', 'salt']}
            />
          </div>

          <div className="mt-4 rounded-xl border border-black/10 p-4">
            <p className="text-sm font-medium">
              Your local guess history ({guesses.length})
            </p>
            <p className="mt-1 text-xs text-black/50">
              Saved client-side only. Words + salts needed to prove your winning attempt later.
            </p>
            {guesses.length === 0 ? (
              <p className="mt-2 text-xs text-black/40">no guesses yet</p>
            ) : (
              <ul className="mt-2 space-y-1">
                {guesses.map((g, i) => (
                  <li key={i} className="flex items-center justify-between text-xs">
                    <span className="font-mono">
                      #{i + 1} {g.word.toUpperCase()}{' '}
                      {revealedWord && g.word === revealedWord && (
                        <span className="ml-1 rounded bg-emerald-100 px-1 py-0.5 text-emerald-900">
                          target!
                        </span>
                      )}
                    </span>
                    <span className="font-mono text-[10px] text-black/40">
                      salt {g.salt.slice(0, 10)}…
                    </span>
                  </li>
                ))}
              </ul>
            )}
          </div>

          {/* Operator reveal — operator-only on testnet */}
          {inRevealWindow && !revealedWord && (
            <div className="mt-4 rounded-xl border border-amber-200 bg-amber-50/40 p-4">
              <p className="text-sm font-medium text-amber-950">Operator reveal</p>
              <p className="mt-1 text-xs text-amber-900/80">
                The operator (the demo issuer, not you) reveals the target word + salt; the
                contract verifies pedersen(word, salt) == committed challenge_hash. On testnet this
                is operator-only, so the button is disabled for a visitor.
              </p>
              <button
                disabled
                className="mt-2 rounded-full bg-amber-600 px-3 py-1.5 text-xs font-medium text-white opacity-50"
                title="operator-only — the demo issuer reveals the target after the guess window"
              >
                Reveal target (operator-only)
              </button>
            </div>
          )}

          {revealedWord && (
            <div className="mt-4 rounded-xl border border-emerald-200 bg-emerald-50/40 p-4">
              <p className="text-sm font-medium text-emerald-950">
                Target revealed: <span className="font-mono uppercase">{revealedWord}</span>
              </p>
              {winningGuess && solvedOn === 0 ? (
                <>
                  <p className="mt-1 text-xs text-emerald-900/80">
                    One of your guesses matches. Prove your solve to update the leaderboard — this
                    publishes only the winning (guess, salt) and the attempt number. Other guesses
                    stay private.
                  </p>
                  <button
                    onClick={() => handleProveSolve(winningGuess)}
                    disabled={busy}
                    className="mt-2 rounded-full bg-emerald-600 px-3 py-1.5 text-xs font-medium text-white hover:opacity-90 disabled:opacity-50"
                  >
                    {busy ? 'Working…' : 'Prove solve'}
                  </button>
                  <PrivacyLeakage
                    className="mt-2"
                    publicLeaks={['your address', 'winning attempt #']}
                    staysPrivate={['failed guesses', 'their salts']}
                  />
                </>
              ) : winningGuess && solvedOn > 0 ? (
                <p className="mt-1 text-xs text-emerald-900/80">
                  You proved a solve on attempt #{solvedOn}. Other attempts stayed private.
                </p>
              ) : (
                <p className="mt-1 text-xs text-emerald-900/80">
                  None of your guesses matched. Better luck next round.
                </p>
              )}
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
