import assert from 'node:assert/strict'
import http from 'node:http'
import { runWithRequestAbortSignal } from './request-signal.js'

let observeStarted
let abortedResolve
const started = new Promise((resolve) => { observeStarted = resolve })
const providerAborted = new Promise((resolve) => { abortedResolve = resolve })
const server = http.createServer((req, res) => {
  void runWithRequestAbortSignal(req, res, async (signal) => {
    observeStarted(signal)
    await new Promise((resolve) => {
      if (signal.aborted) return resolve()
      signal.addEventListener('abort', resolve, { once: true })
    })
    abortedResolve(signal.aborted)
    if (!signal.aborted) res.end('preview')
  })
})

await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve))
try {
  const port = server.address().port
  const client = http.request({ host: '127.0.0.1', port, method: 'POST', path: '/api/loop-preview' })
  client.on('error', () => {})
  client.end('{"fundingAmount":"1"}')
  const signal = await started
  assert.equal(signal.aborted, false)
  client.destroy()
  let timer
  try {
    assert.equal(await Promise.race([
      providerAborted,
      new Promise((_, reject) => { timer = setTimeout(() => reject(new Error('Provider did not observe client disconnect.')), 1500) }),
    ]), true)
  } finally {
    clearTimeout(timer)
  }
} finally {
  await new Promise((resolve, reject) => server.close((error) => error ? reject(error) : resolve()))
}

console.log('request disconnect cancellation ok')
