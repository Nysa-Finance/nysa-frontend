export async function runWithRequestAbortSignal(req, res, operation) {
  const controller = new AbortController()
  const abort = () => {
    if (!controller.signal.aborted) controller.abort(new DOMException('Client disconnected.', 'AbortError'))
  }
  const onResponseClose = () => {
    if (!res.writableEnded) abort()
  }
  req.once('aborted', abort)
  res.once('close', onResponseClose)
  try {
    return await operation(controller.signal)
  } finally {
    req.off('aborted', abort)
    res.off('close', onResponseClose)
  }
}
