// Off-chain eligible-voter Merkle tree for the AnonymousVoting contract. MUST
// match the in-circuit verification: leaf = poseidon2([secret]), internal node
// = poseidon2([left, right]), consumed by root_from_sibling_path (leaf_index as
// little-endian bits). Shared by the deploy scripts and the voting panel.

import { Fr } from '@aztec/aztec.js/fields'
import { poseidon2Hash } from '@aztec/foundation/crypto/sync'

export const ELIGIBLE_TREE_DEPTH = 4
export const ELIGIBLE_TREE_LEAVES = 1 << ELIGIBLE_TREE_DEPTH // 16

export interface VoterProof {
  leafIndex: number
  /** The credential secret (0x hex) — the private witness the holder votes with. */
  secret: string
  /** DEPTH sibling hashes, leaf level first (0x hex). */
  siblingPath: string[]
  /** The leaf hash (0x hex). */
  leaf: string
}

function leafHash(secret: string): Fr {
  return poseidon2Hash([Fr.fromString(secret)])
}

/**
 * Build the eligible-voter tree from credential secrets. Returns the root and a
 * proof per secret (in input order). Unused leaves are zero.
 */
export function buildEligibleTree(secrets: string[]): { root: string; proofs: VoterProof[] } {
  if (secrets.length > ELIGIBLE_TREE_LEAVES) {
    throw new Error(`too many voters (max ${ELIGIBLE_TREE_LEAVES})`)
  }
  const leaves: Fr[] = []
  for (let i = 0; i < ELIGIBLE_TREE_LEAVES; i++) {
    leaves.push(i < secrets.length ? leafHash(secrets[i]) : Fr.ZERO)
  }
  const levels: Fr[][] = [leaves]
  let cur = leaves
  while (cur.length > 1) {
    const next: Fr[] = []
    for (let i = 0; i < cur.length; i += 2) next.push(poseidon2Hash([cur[i], cur[i + 1]]))
    levels.push(next)
    cur = next
  }
  const root = levels[levels.length - 1][0].toString()

  const proofs: VoterProof[] = secrets.map((secret, idx) => {
    const siblingPath: string[] = []
    let nodeIdx = idx
    for (let level = 0; level < ELIGIBLE_TREE_DEPTH; level++) {
      siblingPath.push(levels[level][nodeIdx ^ 1].toString())
      nodeIdx = nodeIdx >> 1
    }
    return { leafIndex: idx, secret, siblingPath, leaf: leaves[idx].toString() }
  })

  return { root, proofs }
}
