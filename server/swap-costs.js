const raw = (value) => {
  if (typeof value === 'bigint' && value >= 0n) return String(value)
  if (typeof value === 'string' && /^\d+$/.test(value)) return value
  return null
}

/** Cost estimates remain decimal strings so lamport values never pass through floating point. */
export function swapCostDisclosure({ totalNetworkFeeLamports, priorityFeeLamports, accountRentLamports } = {}) {
  const total = raw(totalNetworkFeeLamports)
  const priority = raw(priorityFeeLamports)
  const rent = raw(accountRentLamports)
  const base = total != null && priority != null && BigInt(total) >= BigInt(priority)
    ? String(BigInt(total) - BigInt(priority))
    : null
  const unavailable = []
  if (base == null) unavailable.push('network-fee')
  if (priority == null || total != null && BigInt(priority) > BigInt(total)) unavailable.push('priority-fee')
  if (rent == null) unavailable.push('account-rent')
  return {
    status: unavailable.length ? 'unavailable' : 'known',
    totalNetworkFeeLamports: total,
    baseNetworkFeeLamports: base,
    priorityFeeLamports: priority != null && (total == null || BigInt(priority) <= BigInt(total)) ? priority : null,
    accountRentLamports: rent,
    accountRentEstimateKind: rent == null ? 'unavailable' : BigInt(rent) === 0n ? 'none' : 'upper-bound',
    unavailable,
  }
}
