import assert from 'node:assert/strict'
import { evaluateProgramPolicy } from './program-policy.js'

const reviewed = {
  programId: 'SyntheticVerifiedProgram11111111111111111111111',
  network: 'mainnet-beta',
  programVersion: 'v1.2.3',
  deploymentVerified: true,
  auditReports: [{ url: 'https://audit.example/report.pdf', programVersion: 'v1.2.3', coversDeployedVersion: true }],
  routeLabels: ['Synthetic Venue'],
  reviewedBy: 'Nysa security reviewer',
}

assert.deepEqual(evaluateProgramPolicy(['UnknownProgram1111111111111111111111111111111'], []), {
  approved: false,
  unreviewed: [{ programId: 'UnknownProgram1111111111111111111111111111111', reason: 'No evidence record exists.' }],
})
assert.equal(evaluateProgramPolicy([reviewed.programId], [reviewed]).approved, true)
assert.equal(evaluateProgramPolicy([reviewed.programId, 'AnotherProgram11111111111111111111111111111'], [reviewed]).approved, false)
assert.equal(evaluateProgramPolicy([reviewed.programId], [{ ...reviewed, deploymentVerified: false }]).unreviewed[0].reason, 'Deployment is not verified.')
assert.equal(evaluateProgramPolicy([reviewed.programId], [{ ...reviewed, auditReports: [{ ...reviewed.auditReports[0], coversDeployedVersion: false }] }]).unreviewed[0].reason, 'No audit covers the verified deployed version.')
assert.equal(evaluateProgramPolicy([reviewed.programId], [{ ...reviewed, auditReports: [{ ...reviewed.auditReports[0], programVersion: 'v0.9.0' }] }]).approved, false)
assert.equal(evaluateProgramPolicy([reviewed.programId], [{ ...reviewed, reviewedBy: '' }]).unreviewed[0].reason, 'Review owner is missing.')
assert.equal(evaluateProgramPolicy([], [reviewed]).unreviewed[0].reason, 'Route does not identify its invoked programs.')
assert.equal(evaluateProgramPolicy([reviewed.programId], [reviewed], ['Synthetic Venue']).approved, false)
assert.equal(evaluateProgramPolicy([reviewed.programId], [reviewed], ['Synthetic Venue'], {}).approved, false)
assert.equal(evaluateProgramPolicy([reviewed.programId], [reviewed], ['Synthetic Venue'], { 'Synthetic Venue': [reviewed.programId] }).approved, true)
assert.deepEqual(evaluateProgramPolicy([reviewed.programId], [reviewed], ['Unreviewed Venue']), {
  approved: false,
  unreviewed: [{ programId: null, routeLabel: 'Unreviewed Venue', reason: 'Route label does not resolve to an exact DEX program ID.' }],
})

console.log('program-policy ok')
