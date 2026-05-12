/**
 * Per-recipient rate limit backed by SQLite. Keeps the DB at a known path so
 * Docker can mount the file as a volume for persistence.
 */
import Database from 'better-sqlite3'
import { resolve } from 'node:path'

let db: Database.Database | null = null

function getDb(): Database.Database {
  if (db) return db
  const dataDir = process.env.DATA_DIR ?? '/data'
  const path = resolve(dataDir, 'faucet.sqlite')
  db = new Database(path)
  db.pragma('journal_mode = WAL')
  db.exec(
    `CREATE TABLE IF NOT EXISTS mints (
      recipient TEXT NOT NULL,
      token TEXT NOT NULL,
      last_mint_unix INTEGER NOT NULL,
      total_mints INTEGER NOT NULL DEFAULT 0,
      PRIMARY KEY (recipient, token)
    )`,
  )
  return db
}

const COOLDOWN_SECONDS = Number(process.env.MINT_COOLDOWN_SECONDS ?? '3600')

export interface RateLimitDecision {
  allowed: boolean
  retryAfterSeconds?: number
  reason?: string
}

export function checkRateLimit(recipient: string, token: string): RateLimitDecision {
  const row = getDb()
    .prepare(
      `SELECT last_mint_unix, total_mints FROM mints WHERE recipient = ? AND token = ?`,
    )
    .get(recipient, token) as { last_mint_unix: number; total_mints: number } | undefined
  if (!row) return { allowed: true }

  const now = Math.floor(Date.now() / 1000)
  const elapsed = now - row.last_mint_unix
  if (elapsed >= COOLDOWN_SECONDS) return { allowed: true }
  return {
    allowed: false,
    retryAfterSeconds: COOLDOWN_SECONDS - elapsed,
    reason: `cooldown active — try again in ${COOLDOWN_SECONDS - elapsed} s`,
  }
}

export function recordMint(recipient: string, token: string): void {
  const now = Math.floor(Date.now() / 1000)
  getDb()
    .prepare(
      `INSERT INTO mints (recipient, token, last_mint_unix, total_mints)
       VALUES (?, ?, ?, 1)
       ON CONFLICT(recipient, token) DO UPDATE SET
         last_mint_unix = excluded.last_mint_unix,
         total_mints = total_mints + 1`,
    )
    .run(recipient, token, now)
}
