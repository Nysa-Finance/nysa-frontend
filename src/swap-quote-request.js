// A late result must not overwrite a newer form state.
export function createLatestRequestGate() {
  let generation = 0
  let active = null
  function invalidate() {
    generation++
    active?.abort()
    active = null
  }
  return {
    begin(key) {
      invalidate()
      const version = generation
      const controller = new AbortController()
      active = controller
      return {
        signal: controller.signal,
        isCurrent: (currentKey) => generation === version && currentKey === key && !controller.signal.aborted,
        cancel() {
          if (active === controller) invalidate()
          else controller.abort()
        },
      }
    },
    invalidate,
  }
}
