import assert from 'node:assert/strict'
import { APPROVED_PROGRAMS, evaluateProgramPolicy } from './program-policy.js'

const jupiter = 'JUP6LkbZbjS1jKKwapdHNy74zcZ3tLUZoi5QNyVTaV4'
const whirlpool = 'whirLbMiicVdio4qvUfM5KAg6Ct8VwpYzGff3uctyCc'
const unknown = 'UnknownProgram1111111111111111111111111111111'

assert.equal(APPROVED_PROGRAMS.size, 4, 'only the reviewed swap programs are approved')
assert.equal(evaluateProgramPolicy([jupiter, whirlpool], ['Whirlpool'], { Whirlpool: [whirlpool] }).approved, true)
assert.deepEqual(evaluateProgramPolicy([jupiter, unknown]), {
  approved: false,
  unreviewed: [{ programId: unknown, reason: 'Program is not on Nysa’s approved list.' }],
})
assert.equal(evaluateProgramPolicy([]).unreviewed[0].reason, 'Route does not identify its invoked programs.')
assert.equal(evaluateProgramPolicy([jupiter], ['Other Venue']).approved, false, 'a route label without an exact program fails')
assert.equal(evaluateProgramPolicy([jupiter], ['Whirlpool'], { Whirlpool: [whirlpool] }).approved, false,
  'a mapped DEX program must be present in the route program set')
assert.equal(evaluateProgramPolicy([unknown], [], {}, new Set([unknown])).approved, true, 'the approved list is injectable for tests')

// A loop's programs pass the loop list, not the swap one (the relay refused every signed loop with the swap list).
{
  const { LOOP_PROGRAMS } = await import('./program-policy.js')
  const loop = ['ComputeBudget111111111111111111111111111111', 'ATokenGPvbdGVxr1b2hvZbsiqW5xWH25efTNsLJA8knL',
    'KLend2g3cP87fffoy8q1mQqGKjrxjC8boSyAYavgmjD', 'TokenkegQfeZyiNwAJbNbGKPFXCWuBvf9Ss623VQ5DA', jupiter, whirlpool]
  assert.equal(evaluateProgramPolicy(loop, ['Whirlpool'], { Whirlpool: [whirlpool] }).approved, false)
  assert.equal(evaluateProgramPolicy(loop, ['Whirlpool'], { Whirlpool: [whirlpool] }, LOOP_PROGRAMS).approved, true)
  assert.equal(evaluateProgramPolicy([...loop, unknown], ['Whirlpool'], { Whirlpool: [whirlpool] }, LOOP_PROGRAMS).approved, false)
}

console.log('program policy ok')
