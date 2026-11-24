import assert from 'node:assert/strict'
import { chainError, explain, isTransient } from './errors.js'

const KLEND = 'KLend2g3cP87fffoy8q1mQqGKjrxjC8boSyAYavgmjD'
const KVAULT = 'KvauGMspG5k6rtzrqqn7WNn3oZdyKqLKwK2XWQ8FLjd'
const JUP = 'JUP6LkbZbjS1jKKwapdHNy74zcZ3tLUZoi5QNyVTaV4'
const ORCA = 'whirLbMiicVdio4qvUfM5KAg6Ct8VwpYzGff3uctyCc'
const TOKEN = 'TokenkegQfeZyiNwAJbNbGKPFXCWuBvf9Ss623VQ5DA'
const fail = (program, code) => `Program ${program} failed: custom program error: 0x${code.toString(16)}`

// Kamino borrow above the utilization limit (seen in production loop builds).
assert.match(chainError([`Program ${KLEND} invoke [1]`, 'Program log: Instruction: BorrowObligationLiquidity', fail(KLEND, 6098)]), /borrowing limit/)
assert.match(chainError([fail(KLEND, 6008)]), /enough liquidity/)
assert.match(chainError([fail(KLEND, 6039)]), /price feed/)
assert.match(chainError([fail(KLEND, 6011)]), /more than you can withdraw/)
// Uncurated Kamino code still reads as Kamino's own reason, not a hex code.
assert.equal(chainError([fail(KLEND, 6057)]), 'Kamino refused this transaction: The obligation has one collateral with an LTV set to 0. Withdraw it before withdrawing other collaterals.')
// The innermost program owns the code: a vault calling Kamino Lend reports Kamino's reason.
assert.match(chainError([fail(KLEND, 6008), fail(KVAULT, 6008)]), /enough liquidity/)
assert.match(chainError([fail(KVAULT, 7000)]), /^The Kamino vault refused this transaction: Cannot deposit zero tokens\.$/)
// Jupiter slippage, and an Orca pool's own minimum-out check inside a Jupiter route.
assert.match(chainError([fail(JUP, 6001)]), /slippage/)
assert.match(chainError([
  'Program log: AnchorError occurred. Error Code: TokenMinSubceeded. Error Number: 6036. Error Message: Token min subceeded.',
  fail(ORCA, 6036), fail(JUP, 6036),
]), /slippage/)
assert.equal(chainError(['Program log: AnchorError occurred. Error Code: InvalidTickArray. Error Number: 6023. Error Message: Invalid tick array.', fail(ORCA, 6023)]),
  'The transaction was refused on-chain: Invalid tick array.')
// Token balance, missing SOL, compute, expired blockhash.
assert.match(chainError(['Program log: Error: insufficient funds', fail(TOKEN, 1)]), /doesn't hold enough/)
assert.match(chainError([], 'InsufficientFundsForFee'), /needs a little SOL/)
assert.match(chainError(['Transfer: insufficient lamports 100, need 2039280']), /needs a little SOL/)
assert.match(chainError(['Program KLend... consumed 200000 of 200000 compute units', 'exceeded CUs meter at BPF instruction']), /compute/)
assert.match(chainError([], 'BlockhashNotFound'), /expired/)
assert.match(chainError([], { InstructionError: [3, 'ProgramFailedToComplete'] }), /compute/)
assert.equal(chainError(['Program log: something odd'], { InstructionError: [0, 'Custom'] }), null)

// Network hiccups are transient; anything else gets a searchable reference.
assert.ok(isTransient({ message: 'Block not available for slot 123', context: { __code: -32004 } }))
assert.ok(isTransient(new Error('fetch failed')))
assert.ok(isTransient(new Error('HTTP error (429): Too Many Requests')))
assert.ok(isTransient(new Error('Swap provider is temporarily unavailable.')), 'a rate-limited Jupiter quote is retried')
assert.ok(!isTransient(new Error('Cannot read properties of undefined')))
const quiet = console.error; const warn = console.warn
console.error = console.warn = () => {}
assert.equal(explain(new Error('fetch failed'), 't', 'x').status, 503)
const simulated = explain({ message: 'preflight', context: { logs: [fail(KLEND, 6098)] } }, 't', 'x')
assert.deepEqual([simulated.status, /borrowing limit/.test(simulated.error)], [409, true])
const unknown = explain(new TypeError('boom'), 't', 'Could not build the transaction.')
console.error = quiet; console.warn = warn
assert.equal(unknown.status, 502)
assert.match(unknown.error, /^Could not build the transaction\. \(ref [0-9A-F]{6}\)$/)

console.log('error translation ok')
