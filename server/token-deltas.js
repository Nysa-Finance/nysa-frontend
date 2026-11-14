export function confirmedTokenDeltas(meta) {
  if (!meta || !Array.isArray(meta.preTokenBalances) || !Array.isArray(meta.postTokenBalances)) return []
  const pre = new Map(meta.preTokenBalances.map((item) => [item.accountIndex, item]))
  const post = new Map(meta.postTokenBalances.map((item) => [item.accountIndex, item]))
  const changes = new Map()
  for (const index of new Set([...pre.keys(), ...post.keys()])) {
    const before = pre.get(index), after = post.get(index)
    const owner = after?.owner ?? before?.owner
    const mint = after?.mint ?? before?.mint
    if (typeof owner !== 'string' || typeof mint !== 'string') continue
    if (before?.mint && after?.mint && before.mint !== after.mint) continue
    const beforeAmount = before?.uiTokenAmount?.amount ?? '0'
    const afterAmount = after?.uiTokenAmount?.amount ?? '0'
    if (typeof beforeAmount !== 'string' || !/^\d+$/.test(beforeAmount)
      || typeof afterAmount !== 'string' || !/^\d+$/.test(afterAmount)) continue
    const key = `${owner}:${mint}`
    changes.set(key, {
      owner,
      mint,
      delta: (changes.get(key)?.delta ?? 0n) + BigInt(afterAmount) - BigInt(beforeAmount),
    })
  }
  return [...changes.values()]
    .map(({ owner, mint, delta }) => ({ owner, mint, deltaBaseUnits: String(delta) }))
    .sort((a, b) => a.owner.localeCompare(b.owner) || a.mint.localeCompare(b.mint))
}
