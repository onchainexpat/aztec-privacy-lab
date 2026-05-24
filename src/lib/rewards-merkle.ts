// Off-chain Merkle tree for the Rewards contract. MUST match the in-circuit
// verification in contracts/rewards: leaf = poseidon2([address, amount, period]),
// internal node = poseidon2([left, right]), and root_from_sibling_path consumes
// leaf_index as little-endian bits (bit k picks left/right at level k).
//
// Shared by the sandbox/testnet deploy scripts and the browser panel so the
// exact same root + proofs are produced on both sides.

import { Fr } from '@aztec/aztec.js/fields'
import { poseidon2Hash } from '@aztec/foundation/crypto/sync'

export const REWARDS_TREE_DEPTH = 4
export const REWARDS_TREE_LEAVES = 1 << REWARDS_TREE_DEPTH // 16

export interface RewardEntry {
  /** Eligible recipient address (0x field hex). */
  address: string
  /** Reward amount for this (address, period) leaf. */
  amount: string
}

export interface RewardProof {
  leafIndex: number
  amount: string
  /** DEPTH sibling hashes, leaf level first (0x hex). */
  siblingPath: string[]
  /** The leaf hash (0x hex). */
  leaf: string
}

function leafHash(address: string, amount: string, period: bigint): Fr {
  return poseidon2Hash([Fr.fromString(address), new Fr(BigInt(amount)), new Fr(period)])
}

function nodeHash(left: Fr, right: Fr): Fr {
  return poseidon2Hash([left, right])
}

/**
 * Build the rewards tree for a period. Entries beyond REWARDS_TREE_LEAVES are
 * ignored; unused leaves are zero. Returns the root (0x hex) and a proof per
 * entry (in input order).
 */
export function buildRewardsTree(
  entries: RewardEntry[],
  period: bigint,
): { root: string; proofs: RewardProof[] } {
  if (entries.length > REWARDS_TREE_LEAVES) {
    throw new Error(`too many entries (max ${REWARDS_TREE_LEAVES})`)
  }
  // Level 0: leaves (padded with zero).
  const leaves: Fr[] = []
  for (let i = 0; i < REWARDS_TREE_LEAVES; i++) {
    leaves.push(i < entries.length ? leafHash(entries[i].address, entries[i].amount, period) : Fr.ZERO)
  }
  // Build levels bottom-up; keep all levels for sibling lookup.
  const levels: Fr[][] = [leaves]
  let cur = leaves
  while (cur.length > 1) {
    const next: Fr[] = []
    for (let i = 0; i < cur.length; i += 2) {
      next.push(nodeHash(cur[i], cur[i + 1]))
    }
    levels.push(next)
    cur = next
  }
  const root = levels[levels.length - 1][0]

  const proofs: RewardProof[] = entries.map((e, idx) => {
    const siblingPath: string[] = []
    let nodeIdx = idx
    for (let level = 0; level < REWARDS_TREE_DEPTH; level++) {
      const siblingIdx = nodeIdx ^ 1 // flip the low bit to get the sibling
      siblingPath.push(levels[level][siblingIdx].toString())
      nodeIdx = nodeIdx >> 1
    }
    return {
      leafIndex: idx,
      amount: e.amount,
      siblingPath,
      leaf: leaves[idx].toString(),
    }
  })

  return { root: root.toString(), proofs }
}
