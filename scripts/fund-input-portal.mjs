import { readFileSync } from 'node:fs'
import { createExtendedL1Client } from '@aztec/ethereum/client'
import { foundry } from 'viem/chains'
import { getContract, parseAbi } from 'viem'
const ANVIL_MNEMONIC = 'test test test test test test test test test test test junk'
const state = JSON.parse(readFileSync('public/sandbox-state.json', 'utf8'))
const c = createExtendedL1Client(['http://localhost:8545'], ANVIL_MNEMONIC, foundry)
const tx = await getContract({
  abi: parseAbi(['function mint(address to, uint256 amount) external']),
  address: state.crossChain.l1Token,
  client: c,
}).write.mint([state.crossChain.l1Portal, 100_000n])
console.log('fund tx:', tx)
