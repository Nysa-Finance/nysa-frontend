import { getTransactionDecoder, isAddress } from '@solana/kit'
import { createSwapIntentStore, TransactionIntentError } from './tx-intent.js'

const MAX_TX_BYTES = 1232
const ACTIONS = new Set(['loop-open', 'loop-close', 'loop-setup'])
const messageDecoder = getTransactionDecoder()

export class LoopExecutionError extends Error {
  constructor(message, { status = 400, unavailableReasons = [] } = {}) {
    super(message)
    this.status = status
    this.unavailableReasons = unavailableReasons
  }
}

function invalid(message) {
  throw new LoopExecutionError(message)
}

function unavailable(reasons = []) {
  const safeReasons = Array.isArray(reasons) && reasons.length
    ? reasons
    : [{ code: 'loop-execution-unavailable', message: 'The atomic loop action is not available.' }]
  throw new LoopExecutionError(safeReasons.map((item) => item.message).join(' '), { status: 503, unavailableReasons: safeReasons })
}

function assertAtomicBuilderResult(built) {
  if (built?.atomic !== true || Array.isArray(built?.transactions) || built?.final === false
    || !Array.isArray(built?.instructions) || built.instructions.length === 0) {
    throw new LoopExecutionError('Loop actions require a single atomic transaction; split economic fallback is disabled.', { status: 503 })
  }
  if (built.lookupTables != null && !Array.isArray(built.lookupTables)) invalid('Loop transaction lookup tables are invalid.')
}

function assertOwnerPosition(position, wallet, market, positionId) {
  if (!position || position.id !== positionId || position.wallet !== wallet) {
    throw new LoopExecutionError('The selected Multiply position is not owned by this wallet.')
  }
  if (position.market?.id !== market || position.obligation?.type !== 'multiply' || typeof position.obligation?.address !== 'string') {
    throw new LoopExecutionError('The selected position is not a verified Nysa Multiply obligation in this market.')
  }
}

function decodeMessageBytes(tx) {
  if (typeof tx !== 'string' || tx.length > 100_000) throw new LoopExecutionError('Invalid signed loop transaction.')
  try {
    return messageDecoder.decode(Uint8Array.from(Buffer.from(tx, 'base64'))).messageBytes
  } catch {
    throw new LoopExecutionError('Invalid signed loop transaction.')
  }
}

/** Server-side application transaction path. It compiles and authorizes one exact atomic message only. */
export function createLoopExecutionService({
  readiness,
  getPreview,
  getPosition,
  metadataReady = async () => true,
  setupRequired = async () => true,
  buildOpen,
  buildClose,
  buildSetup,
  compile,
  simulate,
  verifySimulation,
  intentStore = null,
  decodeMessage = decodeMessageBytes,
  authorize = async () => true,
  authorizeSetup = async () => false,
  send,
  onBuild = async () => {},
  now = Date.now,
} = {}) {
  const intents = intentStore ?? createSwapIntentStore({ now })
  if ([readiness, getPreview, getPosition, metadataReady, setupRequired, buildOpen, buildClose, buildSetup, compile, simulate, verifySimulation, authorize, authorizeSetup, send, onBuild, now]
    .some((dependency) => typeof dependency !== 'function') || !intents
    || typeof intents.issue !== 'function' || typeof intents.assertAndConsume !== 'function'
    || typeof decodeMessage !== 'function') {
    throw new TypeError('Loop execution service requires readiness, atomic builders, simulation, intents and relay dependencies.')
  }

  async function resolveRequest(body, phase) {
    const { kind, wallet, market } = body ?? {}
    if (!ACTIONS.has(kind)) invalid('Unsupported loop action.')
    if (typeof wallet !== 'string' || !isAddress(wallet)) invalid('Invalid wallet address.')
    if (market !== 'sol-usdy-usdc') invalid('Unknown loop strategy.')
    if (kind === 'loop-setup') return { kind, wallet, market, preview: null, position: null, previewAcknowledgementValid: false }
    let preview = null
    let position = null
    let previewAcknowledgementValid = false
    if (kind === 'loop-open') {
      if (typeof body.previewId !== 'string' || !body.previewId) invalid('A current server-side loop preview is required.')
      preview = await getPreview(body.previewId)
      if (!preview || preview.id !== body.previewId || preview.wallet !== wallet || preview.marketId !== market
        || preview.fundingAmount !== body.amount || Number(preview.leverage) !== Number(body.leverage)) {
        throw new LoopExecutionError('Loop preview changed or belongs to another request. Build a fresh preview.')
      }
      if (Number.isFinite(preview.expiresAt) && now() >= preview.expiresAt) {
        throw new LoopExecutionError('Loop preview expired. Build a fresh preview.')
      }
      const expectedAcknowledgement = preview.carry?.acknowledgementKey
      if (preview.carry?.requiresAcknowledgement) {
        if (typeof body.acknowledgementKey !== 'string' || body.acknowledgementKey !== expectedAcknowledgement) {
          throw new LoopExecutionError('A current acknowledgement for this exact loop preview is required.')
        }
        previewAcknowledgementValid = true
      } else if (body.acknowledgementKey != null) {
        if (body.acknowledgementKey !== expectedAcknowledgement) throw new LoopExecutionError('Loop acknowledgement does not match the current preview.')
        previewAcknowledgementValid = true
      }
      if (preview.available !== true) unavailable(preview.unavailableReasons)
      if (await metadataReady({ wallet, market }) !== true) unavailable([
        { code: 'kamino-metadata-setup-required', message: 'Initialize the one-time Kamino UserMetadata account before opening a loop.' },
      ])
    } else {
      if (typeof body.positionId !== 'string' || !/^multiply:[a-f0-9]{64}$/.test(body.positionId)) invalid('An identified Multiply position is required for full close.')
      position = await getPosition({ wallet, positionId: body.positionId, market })
      assertOwnerPosition(position, wallet, market, body.positionId)
    }
    const decision = await readiness({ action: kind, request: body, preview, position, previewAcknowledgementValid, phase })
    if (decision?.executionEnabled !== true) unavailable(decision?.unavailableReasons)
    return { kind, wallet, market, preview, position, previewAcknowledgementValid }
  }

  async function build(body) {
    const context = await resolveRequest(body, 'build')
    const buildAction = context.kind === 'loop-open' ? buildOpen : context.kind === 'loop-close' ? buildClose : buildSetup
    const built = await buildAction({ ...context, request: body })
    if (context.kind === 'loop-setup' && built?.required === false) {
      throw new LoopExecutionError('Kamino UserMetadata is already initialized for this wallet.', { status: 409 })
    }
    assertAtomicBuilderResult(built)
    const compiled = await compile({
      wallet: context.wallet,
      instructions: built.instructions,
      lookupTables: built.lookupTables ?? [],
      built,
    })
    if (typeof compiled?.tx !== 'string' || !(compiled.messageBytes instanceof Uint8Array)
      || !Number.isSafeInteger(compiled.size) || compiled.size <= 0 || compiled.size > MAX_TX_BYTES) {
      throw new LoopExecutionError('Atomic loop transaction could not be compiled within Solana transaction limits.', { status: 503 })
    }
    const simulation = await simulate({ ...context, built, compiled, request: body })
    if (!simulation || simulation.ok !== true) throw new LoopExecutionError('Atomic loop transaction simulation failed.', { status: 503 })
    if (context.kind === 'loop-close' && simulation.remainingDebtBaseUnits !== '0') {
      throw new LoopExecutionError('Full close simulation did not verify zero remaining debt.', { status: 503 })
    }
    if (await verifySimulation({ ...context, built, compiled, simulation, request: body }) !== true) {
      throw new LoopExecutionError('Atomic loop simulation effects are not fully verified.', { status: 503 })
    }
    const expiresAt = Math.min(...[context.preview?.expiresAt, built.expiresAt].filter(Number.isFinite))
    const intent = intents.issue({
      wallet: context.wallet,
      messageBytes: compiled.messageBytes,
      ...(Number.isFinite(expiresAt) ? { expiresAt } : {}),
      metadata: {
        kind: context.kind,
        market: context.market,
        programIds: built.programIds ?? [],
        routeLabels: built.routeLabels ?? [],
        routeProgramIdsByLabel: built.routeProgramIdsByLabel ?? {},
        ...(context.kind === 'loop-open' ? {
          previewId: context.preview.id,
          amount: body.amount,
          leverage: Number(body.leverage),
          acknowledgementKey: context.previewAcknowledgementValid ? context.preview.carry?.acknowledgementKey ?? null : null,
        } : context.kind === 'loop-close' ? { positionId: context.position.id, obligationAddress: context.position.obligation.address } : {}),
      },
    })
    await onBuild(context.wallet)
    return {
      tx: compiled.tx,
      minContextSlot: compiled.minContextSlot,
      intentId: intent.id,
      expiresAt: intent.expiresAt,
      kind: context.kind,
      final: true,
    }
  }

  async function sendSigned({ tx, wallet, intentId } = {}) {
    if (typeof wallet !== 'string' || !isAddress(wallet) || typeof intentId !== 'string') invalid('Invalid signed loop request.')
    const messageBytes = await decodeMessage(tx)
    let intent
    try { intent = intents.assertAndConsume(intentId, wallet, messageBytes) }
    catch (error) {
      if (error instanceof TransactionIntentError) throw new LoopExecutionError(error.message, { status: 400 })
      throw error
    }
    const metadata = intent.metadata ?? {}
    if (!ACTIONS.has(metadata.kind)) throw new LoopExecutionError('Transaction intent is not authorized for a loop action.')
    if (metadata.kind === 'loop-setup') {
      if (metadata.market !== 'sol-usdy-usdc' || await setupRequired({ wallet, market: metadata.market }) !== true) {
        throw new LoopExecutionError('Kamino metadata setup is no longer required; rebuild the setup action.', { status: 503 })
      }
      if (await authorizeSetup({ intent, wallet, market: metadata.market }) !== true) {
        throw new LoopExecutionError('Kamino metadata setup authorization changed after signing.', { status: 503 })
      }
      return send({ tx, wallet, intent })
    }
    const body = metadata.kind === 'loop-open'
      ? { kind: metadata.kind, wallet, market: metadata.market, previewId: metadata.previewId, acknowledgementKey: metadata.acknowledgementKey,
        amount: metadata.amount, leverage: metadata.leverage }
      : { kind: metadata.kind, wallet, market: metadata.market, positionId: metadata.positionId }
    const context = await resolveRequest(body, 'relay')
    if (context.kind === 'loop-open' && (context.preview.id !== metadata.previewId
      || (context.previewAcknowledgementValid ? context.preview.carry?.acknowledgementKey ?? null : null) !== metadata.acknowledgementKey)) {
      throw new LoopExecutionError('Loop preview authorization changed after wallet signing. Rebuild the action.', { status: 503 })
    }
    if (context.kind === 'loop-close' && (context.position.id !== metadata.positionId
      || context.position.obligation.address !== metadata.obligationAddress)) {
      throw new LoopExecutionError('Multiply position ownership changed after wallet signing. Rebuild the action.', { status: 503 })
    }
    if (await authorize({ intent, ...context }) !== true) {
      throw new LoopExecutionError('Loop route, fee or wallet authorization changed after signing. Rebuild the action.', { status: 503 })
    }
    return send({ tx, wallet, intent })
  }

  return { build, send: sendSigned }
}
