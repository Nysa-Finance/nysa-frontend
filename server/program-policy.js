// Programs a swap route may invoke, at the top level or through the router. A route that calls anything else is not
// executable. Add a program here only after reviewing it (and its route label below, for a DEX).
export const APPROVED_PROGRAMS = new Set([
  'JUP6LkbZbjS1jKKwapdHNy74zcZ3tLUZoi5QNyVTaV4', // Jupiter V6 router
  'whirLbMiicVdio4qvUfM5KAg6Ct8VwpYzGff3uctyCc', // Orca Whirlpool
  'ComputeBudget111111111111111111111111111111', // Compute Budget (Solana native)
  'ATokenGPvbdGVxr1b2hvZbsiqW5xWH25efTNsLJA8knL', // Associated Token Account
])

// Provider labels are not program identities: each admitted route label maps to its exact program.
// `Whirlpool` was resolved from the owner of a live USDY/USDC route pool account.
export const ROUTE_PROGRAM_IDS_BY_LABEL = Object.freeze({
  Whirlpool: Object.freeze(['whirLbMiicVdio4qvUfM5KAg6Ct8VwpYzGff3uctyCc']),
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
