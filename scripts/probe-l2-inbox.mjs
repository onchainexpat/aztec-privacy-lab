async function rpc(method, params) {
  const r = await fetch('http://localhost:8090', {
    method: 'POST', headers: {'content-type':'application/json'},
    body: JSON.stringify({jsonrpc:'2.0',id:1,method,params}),
  })
  return (await r.json())
}
const info = await rpc('node_getNodeInfo', [])
console.log('chainId:', info.result.l1ChainId, 'rollupVersion:', info.result.rollupVersion)
const block = await rpc('node_getBlockNumber', [])
console.log('L2 block:', block.result)
// Try fetching pending messages
const pending = await rpc('node_getPendingL1ToL2MessageCount', [])
console.log('pending L1->L2 messages:', JSON.stringify(pending).slice(0, 200))
