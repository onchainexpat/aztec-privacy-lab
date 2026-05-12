import { createPublicClient, http, parseAbi, getContract } from 'viem'
import { readFileSync } from 'node:fs'
const state = JSON.parse(readFileSync('/home/fervor/projects/aztec-experiments/public/sandbox-state.json', 'utf8'))
const c = createPublicClient({ transport: http(state.crossChain.l1Rpc) })
const erc20 = getContract({
  abi: parseAbi(['function balanceOf(address) view returns (uint256)']),
  address: state.crossChain.l1Token,
  client: c,
})
const portal = await erc20.read.balanceOf([state.crossChain.l1Portal])
const deployer = await erc20.read.balanceOf([state.crossChain.l1Deployer])
console.log('portal escrow:', portal.toString(), 'deployer:', deployer.toString())
const r = await fetch('http://localhost:8090', {
  method: 'POST', headers: {'content-type':'application/json'},
  body: JSON.stringify({jsonrpc:'2.0',id:1,method:'node_getBlockNumber',params:[]}),
})
console.log('L2 block:', (await r.json()).result)
