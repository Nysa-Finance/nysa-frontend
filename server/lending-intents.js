import { transactionMessageBytesFromBase64 } from './tx-intent.js'

/** Bind ordinary and optional borrower-flow builds to the exact message returned to the wallet. */
export function createLendingTransactionIntentService({ intentStore, build, relay, onBuild = () => {} } = {}) {
  if (!intentStore || typeof intentStore.issue !== 'function' || typeof intentStore.assertAndConsume !== 'function'
    || typeof build !== 'function' || typeof relay !== 'function' || typeof onBuild !== 'function') {
    throw new TypeError('Lending transaction intent service requires a store, build, relay, and build callback.')
  }
  return {
    async build(request) {
      const built = await build(request)
      if (typeof built?.tx !== 'string') return built
      const intent = intentStore.issue({
        wallet: request.wallet,
        messageBytes: transactionMessageBytesFromBase64(built.tx),
        metadata: {
          kind: 'lending-build',
          action: request.kind,
          marketId: request.market ?? null,
          tokenId: request.token ?? null,
          flow: request.swapFlow ?? null,
          stage: request.swapFlowStage ?? null,
          flowAmountBaseUnits: request.flowAmountBaseUnits ?? null,
        },
      })
      onBuild(request.wallet)
      return { ...built, intentId: intent.id, intentExpiresAt: intent.expiresAt }
    },
    async send({ tx, wallet, intentId } = {}) {
      if (typeof tx !== 'string' || typeof wallet !== 'string' || typeof intentId !== 'string' || !intentId) {
        throw new Error('An exact transaction intent is required to relay this transaction.')
      }
      return await relay({ tx, wallet, intentId, intentStore, requireIntent: true })
    },
  }
}
