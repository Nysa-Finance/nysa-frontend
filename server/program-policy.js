// A route that calls anything else is not executable. Add a program only after reviewing it (and its route label
// below, for a DEX).
export const APPROVED_PROGRAMS = new Set([
  'JUP6LkbZbjS1jKKwapdHNy74zcZ3tLUZoi5QNyVTaV4', // Jupiter V6 router
  'whirLbMiicVdio4qvUfM5KAg6Ct8VwpYzGff3uctyCc', // Orca Whirlpool
  'CAMMCzo5YL8w4VFF8KVHrK22GGUsp5VTaW7grrKgrWqK', // Raydium CLMM (oTFY's only pool)
  'ComputeBudget111111111111111111111111111111', // Compute Budget
  'ATokenGPvbdGVxr1b2hvZbsiqW5xWH25efTNsLJA8knL', // Associated Token Account
])

// A loop transaction calls these on top of its swap route (Kamino's flash loan, deposit, borrow and farm refresh; token
// accounts; Orca's v2 swap passes the Memo program). The relay checks a signed loop against this list, not the swap one.
export const LOOP_PROGRAMS = new Set([
  ...APPROVED_PROGRAMS,
  'KLend2g3cP87fffoy8q1mQqGKjrxjC8boSyAYavgmjD', // Kamino Lend
  'FarmsPZpWu9i7Kky8tPN37rs2TpmMrAZrC7S7vJa91Hr', // Kamino Farms
  'TokenkegQfeZyiNwAJbNbGKPFXCWuBvf9Ss623VQ5DA', // SPL Token
  'TokenzQdBNbLqP5VEhdkAS6EPFLC1PHnBqCXEpPxuEb', // Token-2022 (sUSDai; its transfer hook is unset, a hook program would be refused)
  '11111111111111111111111111111111', // System
  'MemoSq4gqABAXKb96qnH8TysNcWxMyWCqXgDLGmfcHr', // Memo
])

// Provider labels are not program identities: each admitted route label maps to its exact program.
// `Whirlpool` was resolved from the owner of a live USDY/USDC route pool account, `Raydium CLMM` from the owner of the
// oTFY/USDC pool 7GzGBjKG8Y326tpiNQ83CA5oePy8qZqfXgz2dLBn7qyq.
export const ROUTE_PROGRAM_IDS_BY_LABEL = Object.freeze({
  Whirlpool: Object.freeze(['whirLbMiicVdio4qvUfM5KAg6Ct8VwpYzGff3uctyCc']),
  'Raydium CLMM': Object.freeze(['CAMMCzo5YL8w4VFF8KVHrK22GGUsp5VTaW7grrKgrWqK']),
})

export function evaluateProgramPolicy(programIds, routeLabels = [], routeProgramIdsByLabel = {}, approved = APPROVED_PROGRAMS) {
  if (!Array.isArray(programIds) || programIds.length === 0) {
    return { approved: false, unreviewed: [{ programId: null, reason: 'Route does not identify its invoked programs.' }] }
  }
  const unreviewed = [...new Set(programIds)].filter((programId) => !approved.has(programId))
    .map((programId) => ({ programId, reason: 'Program is not on Nysa’s approved list.' }))
  for (const routeLabel of new Set(routeLabels)) {
    const mapped = routeProgramIdsByLabel?.[routeLabel]
    if (!Array.isArray(mapped) || mapped.length === 0) {
      unreviewed.push({ programId: null, routeLabel, reason: 'Route label does not resolve to an exact DEX program ID.' })
      continue
    }
    for (const programId of new Set(mapped)) {
      if (!programIds.includes(programId)) unreviewed.push({ programId, routeLabel, reason: 'Resolved DEX program is absent from the route program set.' })
    }
  }
  return { approved: unreviewed.length === 0, unreviewed }
}
