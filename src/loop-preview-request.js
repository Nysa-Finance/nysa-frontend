export function loopPreviewRequestMatches({ request, current, requestId, currentRequestId } = {}) {
  return Number.isSafeInteger(requestId) && requestId === currentRequestId
    && typeof request?.fundingAmount === 'string' && request.fundingAmount === current?.fundingAmount
    && Number.isFinite(Number(request?.leverage)) && Number(request.leverage) === Number(current?.leverage)
    && (request?.wallet ?? null) === (current?.wallet ?? null)
}
