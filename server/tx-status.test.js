import assert from 'node:assert/strict'
import { resolveTransactionStatus } from './tx.js'

const confirmed = { slot: 42, err: null, confirmationStatus: 'confirmed' }
const failed = { slot: 43, err: { InstructionError: [0, 'Custom'] }, confirmationStatus: 'finalized' }

async function runHistorical(signature, historyStatus, transaction = null) {
  const calls = []
  const result = await resolveTransactionStatus(signature, {
    getSignatureStatuses: async (signatures, config) => {
      calls.push({ signatures, config })
      return { value: [config?.searchTransactionHistory ? historyStatus : null] }
    },
    getTransaction: async (sig, config) => {
      calls.push({ transaction: sig, config })
      return transaction
    },
  })
  return { result, calls }
}

const landedTransaction = { slot: 42, meta: { err: null, preTokenBalances: [], postTokenBalances: [] } }
const landed = await runHistorical('old-confirmed', confirmed, landedTransaction)
assert.deepEqual(landed.result, { status: 'confirmed', slot: 42, transactionSlot: 42, tokenDeltas: [] })
assert.equal(landed.calls.length, 3, 'recent-cache miss triggers historical lookup and reads landed transaction details')
assert.equal(landed.calls[1].config.searchTransactionHistory, true)

const rejected = await runHistorical('old-failed', failed)
assert.deepEqual(rejected.result, { status: 'failed', error: JSON.stringify(failed.err) })
assert.equal(rejected.calls.length, 2, 'historical failure is definitive and needs no transaction-detail fetch')

const unknown = await runHistorical('never-seen', null)
assert.deepEqual(unknown.result, { status: 'pending' }, 'no recent or historical record remains pending, never assumed failed')
assert.equal(unknown.calls.length, 2)

const historyUnavailable = await resolveTransactionStatus('history-unavailable', {
  getSignatureStatuses: async (_signatures, config) => {
    if (config?.searchTransactionHistory) throw new Error('history unavailable')
    return { value: [null] }
  },
  getTransaction: async () => { throw new Error('must not query transaction details without a status') },
})
assert.deepEqual(historyUnavailable, { status: 'pending' }, 'history RPC errors preserve an unknown pending outcome')

console.log('historical transaction status reconciliation ok')
