// Refresh timer of the market cache (market.js): a regular read every `every` ms, and an earlier one after a confirmed
// transaction. Requests can only bring the next read forward, never postpone it, and post-transaction reads are at
// least `minGap` ms apart, so a client polling confirmations can neither freeze the cache nor make it hammer the RPC.
export function createRefresher(read, { every, soon, minGap }) {
  let timer = null, dueAt = 0, inflight = null, startedAt = -Infinity, again = false

  // Next read in `ms`, unless one is already due sooner.
  function arm(ms) {
    if (timer && dueAt <= Date.now() + ms) return
    clearTimeout(timer)
    dueAt = Date.now() + ms
    timer = setTimeout(fire, ms)
    timer.unref?.()
  }
  function fire() {
    timer = null
    if (inflight) again = true // the running read may predate the request: read once more when it ends
    else run()
  }

  // Reads now; concurrent callers share one read. A read serves every request made before it started.
  function run() {
    if (inflight) return inflight
    clearTimeout(timer)
    timer = null
    startedAt = Date.now()
    inflight = new Promise((ok) => ok(read())).finally(() => {
      inflight = null
      if (again) { again = false; soonRead() }
      arm(every)
    })
    return inflight
  }

  // After a confirmed transaction: read shortly, but not within minGap of the last read's start.
  function soonRead() { arm(Math.max(soon, startedAt + minGap - Date.now())) }

  return { run, soon: soonRead }
}
