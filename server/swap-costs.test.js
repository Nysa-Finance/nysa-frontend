import assert from 'node:assert/strict'
import { estimateSwapCosts, swapCostDisclosure } from './swap-execution.js'

assert.deepEqual(swapCostDisclosure({ totalNetworkFeeLamports: '9007199254740999', priorityFeeLamports: '123', accountRentLamports: '2039280' }), {
  status: 'known',
  totalNetworkFeeLamports: '9007199254740999',
  baseNetworkFeeLamports: '9007199254740876',
  priorityFeeLamports: '123',
  accountRentLamports: '2039280',
  accountRentEstimateKind: 'upper-bound',
  unavailable: [],
})
assert.deepEqual(swapCostDisclosure({ totalNetworkFeeLamports: null, priorityFeeLamports: null, accountRentLamports: null }), {
  status: 'unavailable', totalNetworkFeeLamports: null, baseNetworkFeeLamports: null,
  priorityFeeLamports: null, accountRentLamports: null, accountRentEstimateKind: 'unavailable',
  unavailable: ['network-fee', 'priority-fee', 'account-rent'],
})
assert.equal(swapCostDisclosure({ totalNetworkFeeLamports: '1', priorityFeeLamports: '2', accountRentLamports: '0' }).baseNetworkFeeLamports, null,
  'invalid fee components must remain unavailable rather than wrap or use Number')
assert.equal(swapCostDisclosure({ accountRentLamports: '0' }).accountRentEstimateKind, 'none')

const computeBudget = 'ComputeBudget111111111111111111111111111111'
const ataProgram = 'ATokenGPvbdGVxr1b2hvZbsiqW5xWH25efTNsLJA8knL'
const tokenProgram = 'TokenkegQfeZyiNwAJbNbGKPFXCWuBvf9Ss623VQ5DA'
const priorityLimit = Uint8Array.from([2, 0x20, 0xa1, 0x07, 0]) // 500,000 CU
const priorityPrice = new Uint8Array(9)
priorityPrice[0] = 3
new DataView(priorityPrice.buffer).setBigUint64(1, 1_000_000n, true) // 1 lamport/CU
const estimated = await estimateSwapCosts({ instructions: [
  { programAddress: computeBudget, accounts: [], data: priorityLimit },
  { programAddress: computeBudget, accounts: [], data: priorityPrice },
  { programAddress: ataProgram, accounts: Array.from({ length: 6 }, (_, index) => ({ address: index === 5 ? tokenProgram : `key-${index}` })), data: Uint8Array.from([1]) },
] }, { messageBytes: Uint8Array.from([1]) }, {
  getFeeForMessage: () => ({ send: async () => ({ value: 505_000n }) }),
  getMinimumBalanceForRentExemption: () => ({ send: async () => ({ value: 2_039_280 }) }),
})
assert.deepEqual(estimated, {
  status: 'known', totalNetworkFeeLamports: '505000', baseNetworkFeeLamports: '5000',
  priorityFeeLamports: '500000', accountRentLamports: '2039280', accountRentEstimateKind: 'upper-bound', unavailable: [],
})

// Jupiter can set a compute-unit price without a limit (seen on mainnet: 3207 micro-lamports). Solana then requests 200k
// units per non-compute-budget instruction, so the priority fee is still known.
const price = Uint8Array.from([3, 0x87, 0x0c, 0, 0, 0, 0, 0, 0])
const costs = await estimateSwapCosts({ instructions: [
  { programAddress: 'ComputeBudget111111111111111111111111111111', data: price, accounts: [] },
  { programAddress: 'JUP6LkbZbjS1jKKwapdHNy74zcZ3tLUZoi5QNyVTaV4', data: Uint8Array.of(1), accounts: [] },
] }, { messageBytes: new Uint8Array() }, { getFeeForMessage: () => ({ send: async () => ({ value: 6283n }) }) })
assert.equal(costs.priorityFeeLamports, '642', 'one route instruction: 3207 * 200k / 1e6 = 641.4, rounded up')
assert.equal(costs.baseNetworkFeeLamports, '5641')
console.log('swap cost disclosure ok')
