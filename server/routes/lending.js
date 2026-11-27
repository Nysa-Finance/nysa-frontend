// Lending and vault actions (deposit, withdraw, borrow, repay, claim, liquidate): account reads, transaction build and
// relay, and status. POST /api/tx also takes loop actions, handed to loop.js.
import {
  getBase58Decoder,
  getCompiledTransactionMessageDecoder,
  getPublicKeyFromAddress,
  getTransactionDecoder,
  isAddress,
  verifySignature,
} from '@solana/kit'
import { rpc } from '../rpc.js'
import { refreshMarketForExecution } from '../market.js'
import { getAccount } from '../account.js'
import { readFreshWithdrawalAllowance } from '../withdrawal.js'
import { buildTx, sendSigned, txStatus, liquidationInfo, KINDS, UserError } from '../tx.js'
import { getPositions } from '../analytics.js'
import { isSanctioned } from '../screening.js'
import { marketById } from '../../shared/config.js'
import { createLendingTransactionIntentStore } from '../tx-intent.js'
import { createLendingTransactionIntentService } from '../lending-intents.js'
import { DefiniteSendRefusal, SendOutcomeUnknownError } from '../send-safety.js'
import { explain } from '../errors.js'
import { isLocalWallet, localForkDappEnabled } from '../execution-mode.js'
import { BLOCKED_LOAN, blocked, geoBlocked, GEO_KINDS, GEO_REFUSED, jsonBody, limited, send } from '../http.js'
import { buildLoopTx, LOOP_KINDS, loopTxRefused } from './loop.js'

const lendingIntentStore = createLendingTransactionIntentStore({ ttlMs: 10 * 60_000 })
const lendingTransactions = createLendingTransactionIntentService({
  intentStore: lendingIntentStore,
  build: buildTx,
  relay: ({ tx, wallet, intentStore, intentId, requireIntent }) =>
    sendSigned({ tx, wallet, intentStore, intentId, requireIntent }),
})

export const lendingRoutes = [
  [
    'GET',
    /^\/api\/account\/(\w+)$/,
    async (req, res, [wallet]) => {
      if (!isAddress(wallet)) return send(res, 400, { error: 'Invalid wallet address' })
      if (limited(req, 'account', 60)) return send(res, 429, { error: 'Too many requests' })
      if (blocked(res, wallet, { failClosed: false })) return
      const fresh = new URL(req.url, 'http://x').searchParams.has('fresh')
      send(res, 200, await getAccount(wallet, fresh))
    },
  ],
  [
    'GET',
    /^\/api\/withdrawal-allowance\/(\w+)$/,
    async (req, res, [wallet]) => {
      if (!isAddress(wallet)) return send(res, 400, { error: 'Invalid wallet address' })
      if (limited(req, 'withdrawal-allowance', 20)) return send(res, 429, { error: 'Too many requests' })
      if (blocked(res, wallet, { failClosed: true })) return
      try {
        const allowance = await readFreshWithdrawalAllowance({
          wallet,
          refreshMarket: refreshMarketForExecution,
          getAccount,
        })
        return send(res, 200, { market: 'sol-usdy-usdc', token: 'svm-usdy', ...allowance })
      } catch (error) {
        console.warn('[withdrawal] fresh allowance unavailable', error?.message)
        return send(res, 503, {
          error: 'Fresh free-withdrawal allowance is unavailable. Retry after market data refreshes.',
        })
      }
    },
  ],
  [
    'POST',
    /^\/api\/tx$/,
    async (req, res) => {
      if (limited(req, 'tx', 20)) return send(res, 429, { error: 'Too many requests' })
      const b = await jsonBody(req)
      if (!KINDS.includes(b.kind)) throw new UserError('Unknown action')
      if (!isAddress(String(b.wallet))) throw new UserError('Invalid wallet address')
      if (LOOP_KINDS.has(b.kind) && loopTxRefused(res, b)) return
      if (b.kind === 'liquidate' && !isAddress(String(b.borrower))) throw new UserError('Invalid borrower address')
      if (blocked(res, b.wallet, { failClosed: true })) return
      if (b.kind === 'liquidate' && isSanctioned(b.borrower)) return send(res, 403, BLOCKED_LOAN)
      if (GEO_KINDS.has(b.kind) && marketById(b.market)?.geoBlocked && geoBlocked(req))
        return send(res, 403, GEO_REFUSED)
      if (LOOP_KINDS.has(b.kind)) return buildLoopTx(res, b)
      try {
        send(
          res,
          200,
          await lendingTransactions.build({
            kind: b.kind,
            wallet: b.wallet,
            market: b.market,
            token: b.token,
            amount: b.amount,
            amountBaseUnits: b.amountBaseUnits,
            all: !!b.all,
            borrower: b.borrower,
            preview: !!b.preview,
            vault: b.vault,
            swapFlow: b.swapFlow,
            swapFlowStage: b.swapFlowStage,
            flowAmountBaseUnits: b.flowAmountBaseUnits,
            beforeBalanceBaseUnits: b.beforeBalanceBaseUnits,
          }),
        )
      } catch (e) {
        if (e instanceof UserError) throw e
        const { status, error: message } = explain(
          e,
          `tx build ${b.kind}`,
          'Could not build the transaction, please try again.',
        )
        send(res, status, { error: message })
      }
    },
  ],
  [
    'POST',
    /^\/api\/tx\/send$/,
    async (req, res) => {
      if (limited(req, 'send', 20)) return send(res, 429, { error: 'Too many requests' })
      const b = await jsonBody(req)
      if (
        !isAddress(String(b.wallet)) ||
        typeof b.tx !== 'string' ||
        b.tx.length > 2000 ||
        typeof b.intentId !== 'string' ||
        !b.intentId
      )
        throw new UserError('Invalid request')
      if (blocked(res, b.wallet, { failClosed: true })) return
      try {
        return send(res, 200, await lendingTransactions.send({ tx: b.tx, wallet: b.wallet, intentId: b.intentId }))
      } catch (error) {
        if (error instanceof DefiniteSendRefusal) return send(res, 400, { error: error.message, outcome: 'rejected' })
        if (error instanceof SendOutcomeUnknownError)
          return send(res, 502, { error: error.message, signature: error.signature, outcome: 'unknown' })
        throw error
      }
    },
  ],
  [
    'POST',
    /^\/api\/tx\/reconcile-local$/,
    async (req, res) => {
      if (limited(req, 'tx-reconcile-local', 10)) return send(res, 429, { error: 'Too many reconciliation checks.' })
      const body = await jsonBody(req)
      if (!localForkDappEnabled || !isLocalWallet(body.wallet)) {
        return send(res, 403, {
          error: 'Local dropped-transaction reconciliation is available only for generated Surfpool wallets.',
        })
      }
      if (typeof body.signature !== 'string' || typeof body.tx !== 'string' || body.tx.length > 100_000) {
        return send(res, 400, { error: 'Invalid local transaction reconciliation request.' })
      }
      try {
        const wire = Uint8Array.from(Buffer.from(body.tx, 'base64'))
        const transaction = getTransactionDecoder().decode(wire)
        const message = getCompiledTransactionMessageDecoder().decode(transaction.messageBytes)
        const wallet = String(body.wallet)
        const signatureBytes = transaction.signatures?.[wallet]
        if (
          String(message.staticAccounts?.[0]) !== wallet ||
          !(signatureBytes instanceof Uint8Array) ||
          signatureBytes.length !== 64 ||
          getBase58Decoder().decode(signatureBytes) !== body.signature ||
          !(await verifySignature(await getPublicKeyFromAddress(wallet), signatureBytes, transaction.messageBytes))
        ) {
          return send(res, 400, {
            error: 'The saved transaction signature or fee payer does not match the connected local wallet.',
          })
        }
        const recent = await rpc.getSignatureStatuses([body.signature], { searchTransactionHistory: true }).send()
        if (recent?.value?.[0]) return send(res, 200, await txStatus(body.signature))
        const historical = await rpc
          .getTransaction(body.signature, { commitment: 'confirmed', maxSupportedTransactionVersion: 1 })
          .send()
        if (historical) return send(res, 200, await txStatus(body.signature))
        const blockhash = String(message.lifetimeToken ?? '')
        if (!blockhash) return send(res, 400, { error: 'The saved local transaction has no recent blockhash.' })
        const blockhashStatus = await rpc.isBlockhashValid(blockhash, { commitment: 'confirmed' }).send()
        return send(
          res,
          200,
          blockhashStatus?.value === true
            ? { status: 'pending' }
            : {
                status: 'failed',
                error:
                  'Surfpool found no landed transaction for this signature and its recent blockhash expired; it can no longer be submitted.',
              },
        )
      } catch (error) {
        console.warn('[tx] local reconciliation unavailable', error?.message)
        return send(res, 503, { error: 'Surfpool could not conclusively reconcile this signed transaction.' })
      }
    },
  ],
  [
    'GET',
    /^\/api\/liquidation\/([\w-]+)\/(\w+)$/,
    async (req, res, [marketId, borrower]) => {
      const m = marketById(marketId)
      if (!m || !isAddress(borrower)) return send(res, 400, { error: 'Invalid market or wallet' })
      if (limited(req, 'liquidation', 60)) return send(res, 429, { error: 'Too many requests' })
      if (isSanctioned(borrower)) return send(res, 403, BLOCKED_LOAN)
      const info = await liquidationInfo(m, borrower)
      // The cached list (a minute old at most) still shows this loan as liquidatable, but it no longer is (just
      // liquidated, prices moved): drop the list so the next read is fresh. Only then, so this can't force rereads.
      if (
        !info.liquidatable &&
        (await getPositions().catch(() => [])).some((p) => p.market === m.id && p.owner === borrower && p.hf < 1)
      )
        getPositions.clear()
      send(res, 200, info)
    },
  ],
  [
    'GET',
    /^\/api\/tx\/(\w{64,90})$/,
    async (req, res, [signature]) => {
      if (limited(req, 'status', 120)) return send(res, 429, { error: 'Too many requests' })
      send(res, 200, await txStatus(signature))
    },
  ],
]
