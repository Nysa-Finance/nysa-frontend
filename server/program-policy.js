// No mainnet route program has been approved for this feature yet. Route admission therefore fails closed.
export const PROGRAM_EVIDENCE = Object.freeze([])

// Provider labels are not program identities. These mappings are candidates only and cannot admit a route without an
// exact reviewed evidence record. `Whirlpool` was resolved from the owner of a live USDY/USDC route pool account.
export const ROUTE_PROGRAM_IDS_BY_LABEL = Object.freeze({
  Whirlpool: Object.freeze(['whirLbMiicVdio4qvUfM5KAg6Ct8VwpYzGff3uctyCc']),
})

function evidenceFailure(record) {
  if (!record) return 'No evidence record exists.'
  if (record.network !== 'mainnet-beta' || record.deploymentVerified !== true) return 'Deployment is not verified.'
  if (typeof record.programVersion !== 'string' || !record.programVersion.trim()) return 'Verified program version is missing.'
  if (!Array.isArray(record.auditReports) || !record.auditReports.some((audit) =>
    typeof audit?.url === 'string'
      && audit.url.startsWith('https://')
      && audit.programVersion === record.programVersion
      && audit.coversDeployedVersion === true)) return 'No audit covers the verified deployed version.'
  if (typeof record.reviewedBy !== 'string' || !record.reviewedBy.trim()) return 'Review owner is missing.'
  return null
}

export function evaluateProgramPolicy(programIds, evidence = PROGRAM_EVIDENCE, routeLabels = [], routeProgramIdsByLabel = {}) {
  if (!Array.isArray(programIds) || programIds.length === 0) {
    return { approved: false, unreviewed: [{ programId: null, reason: 'Route does not identify its invoked programs.' }] }
  }
  const records = new Map((Array.isArray(evidence) ? evidence : []).filter((record) => typeof record?.programId === 'string').map((record) => [record.programId, record]))
  const uniqueProgramIds = [...new Set(programIds)]
  const unreviewed = uniqueProgramIds.flatMap((programId) => {
    if (typeof programId !== 'string' || !programId.trim()) return [{ programId: String(programId), reason: 'Invalid program identity.' }]
    const record = records.get(programId)
    const failure = evidenceFailure(record)
    return failure ? [{ programId, reason: failure }] : []
  })
  for (const routeLabel of new Set(routeLabels)) {
    const mapped = routeProgramIdsByLabel?.[routeLabel]
    if (!Array.isArray(mapped) || mapped.length === 0) {
      unreviewed.push({
        programId: null,
        routeLabel,
        reason: 'Route label does not resolve to an exact DEX program ID.',
      })
      continue
    }
    for (const programId of new Set(mapped)) {
      const record = records.get(programId)
      if (!programIds.includes(programId)) {
        unreviewed.push({ programId, routeLabel, reason: 'Resolved DEX program is absent from the route program set.' })
      } else if (!record || !Array.isArray(record.routeLabels) || !record.routeLabels.includes(routeLabel)) {
        unreviewed.push({ programId, routeLabel, reason: 'Exact program evidence does not cover this route label.' })
      } else {
        const failure = evidenceFailure(record)
        if (failure) unreviewed.push({ programId, routeLabel, reason: failure })
      }
    }
  }
  return { approved: unreviewed.length === 0, unreviewed }
}
