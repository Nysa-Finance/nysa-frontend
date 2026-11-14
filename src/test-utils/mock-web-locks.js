export function installMockWebLocks() {
  let queue = Promise.resolve()
  const locks = {
    request(name, options, callback) {
      if (name !== 'nysa-lending-action-reservation' || options?.mode !== 'exclusive') {
        return Promise.reject(new Error('Unexpected Web Lock request.'))
      }
      const result = queue.then(callback)
      queue = result.then(() => undefined, () => undefined)
      return result
    },
  }
  Object.defineProperty(globalThis, 'navigator', {
    configurable: true,
    value: { locks },
  })
  return locks
}
