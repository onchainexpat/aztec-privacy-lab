#!/usr/bin/env node
/**
 * Strip absolute local paths baked into the Noir compiler artifacts by
 * `aztec compile`. The compiler records absolute paths for every source file
 * in `file_map.*.path` so its error messages can quote source lines. Those
 * paths leak the local username and home-dir layout into the committed JSON.
 *
 * Replaces:
 *   /home/<user>/.nargo/                         -> ~/.nargo/
 *   /home/<user>/nargo/                          -> ~/.nargo/
 *   <repo-root>/contracts/                       -> contracts/
 *
 * Idempotent. Run after every `aztec compile`. Functional behaviour of the
 * artifacts is unchanged — only the diagnostic path strings get rewritten.
 *
 *   node scripts/normalize-artifact-paths.mjs
 */
import { readFileSync, writeFileSync, readdirSync, statSync } from 'node:fs'
import { resolve, dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

const here = dirname(fileURLToPath(import.meta.url))
const repoRoot = resolve(here, '..')
const targetDir = resolve(repoRoot, 'contracts', 'target')

const HOME_DIR_RE = /\/home\/[^/"\s]+\/(\.?nargo)\//g
const PROJECT_CONTRACTS_PREFIX = `${repoRoot}/contracts/`

let totalReplacements = 0
let touched = 0

for (const name of readdirSync(targetDir)) {
  if (!name.endsWith('.json')) continue
  const path = join(targetDir, name)
  if (!statSync(path).isFile()) continue

  const original = readFileSync(path, 'utf8')
  let next = original.replace(HOME_DIR_RE, '~/.nargo/')
  if (next.includes(PROJECT_CONTRACTS_PREFIX)) {
    next = next.split(PROJECT_CONTRACTS_PREFIX).join('contracts/')
  }
  if (next !== original) {
    writeFileSync(path, next)
    const diff = (original.match(/\/home\//g) ?? []).length
    totalReplacements += diff
    touched += 1
    console.log(`normalized ${name} (~${diff} references)`)
  }
}

console.log(`done — ${touched} files, ~${totalReplacements} references rewritten`)
