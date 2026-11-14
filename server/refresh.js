// Requests can only bring the next read forward, never postpone it, and post-transaction reads are at least `minGap`
// ms apart: a client polling confirmations can neither freeze the cache nor make it hammer the RPC.
export function createRefresher(read, { every, soon, minGap }) {
  let timer = null, dueAt = 0, inflight = null, startedAt = -Infinity, again = false

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

  // A read serves every request made before it started.
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

  function soonRead() { arm(Math.max(soon, startedAt + minGap - Date.now())) }

  return { run, soon: soonRead }
}

// Only the newest-started successful read is published: a slow stale request cannot overwrite newer chain state.
export function createLatestReadPublisher(publish) {
  if (typeof publish !== 'function') throw new TypeError('A read publisher callback is required.')
  let generation = 0
  let latestPublished = 0
  return async function readAndPublish(read) {
    if (typeof read !== 'function') throw new TypeError('A read callback is required.')
    const current = ++generation
    const value = await read()
    if (current >= latestPublished) {
      latestPublished = current
      publish(value)
    }
    return value
  }
}
