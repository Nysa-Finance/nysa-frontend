import assert from 'node:assert/strict'
import { readFile } from 'node:fs/promises'
import { createRenderer, nextTick } from 'vue'
import { compileScript, parse } from 'vue/compiler-sfc'
import { applySwapFlowOutcome } from './swap-flow-state.js'
import { assertCanStartLendingAction, canRetryAfterTransactionOutcome, recoverConfirmedSetupTransaction } from './pending-reconciliation.js'

const wallet = 'wallet-a'
const setupAfterTimeout = {
  wallet,
  signature: 'confirmed-setup-signature',
  status: 'relay-unknown',
  final: false,
  market: 'sol-usdy-usdc',
  kind: 'withdraw',
  flow: 'withdraw-sell',
  stage: 'withdraw',
  params: {
    wallet,
    market: 'sol-usdy-usdc',
    kind: 'withdraw',
    token: 'svm-usdy',
    swapFlow: 'withdraw-sell',
    swapFlowStage: 'withdraw',
    amountBaseUnits: '5000000',
  },
}
const recovery = recoverConfirmedSetupTransaction(setupAfterTimeout, { status: 'confirmed' })
assert.equal(recovery.status, 'setup-confirmed', 'a lost relay response recovers to confirmed setup before showing cancel')
const values = new Map([['nysaSetupRecovery', JSON.stringify(recovery)]])
globalThis.localStorage = {
  getItem: (key) => values.get(key) ?? null,
  setItem: (key, value) => values.set(key, String(value)),
  removeItem: (key) => values.delete(key),
}

const store = await import('./store.js')
store.state.address = wallet
store.state.lendingPending = null
store.state.swapOutcome = null

const source = await readFile(new URL('./components/WalletHandoff.vue', import.meta.url), 'utf8')
const { descriptor, errors } = parse(source, { filename: 'WalletHandoff.vue' })
assert.deepEqual(errors, [])
let component = compileScript(descriptor, { id: 'wallet-handoff-test', inlineTemplate: true }).content
component = component
  .replace('from "vue"', `from "${import.meta.resolve('vue')}"`)
  .replace("from 'vue'", `from '${import.meta.resolve('vue')}'`)
  .replace("from '../store.js'", `from '${new URL('./store.js', import.meta.url).href}'`)
  .replace("from '../config.js'", `from '${new URL('./config.js', import.meta.url).href}'`)
const componentUrl = `data:text/javascript;base64,${Buffer.from(component).toString('base64')}`
const { default: WalletHandoff } = await import(componentUrl)

function element(type, text = '') {
  return { type, text, props: {}, children: [], parent: null }
}
const renderer = createRenderer({
  createElement: (type) => element(type),
  createText: (text) => element('#text', text),
  createComment: (text) => element('#comment', text),
  setText: (node, text) => { node.text = text },
  setElementText: (node, text) => { node.text = text; node.children = [] },
  patchProp: (node, key, _previous, next) => { node.props[key] = next },
  parentNode: (node) => node.parent,
  nextSibling(node) {
    if (!node.parent) return null
    return node.parent.children[node.parent.children.indexOf(node) + 1] ?? null
  },
  insert(node, parent, anchor = null) {
    node.parent = parent
    const index = anchor ? parent.children.indexOf(anchor) : -1
    if (index === -1) parent.children.push(node)
    else parent.children.splice(index, 0, node)
  },
  remove(node) {
    if (!node.parent) return
    const index = node.parent.children.indexOf(node)
    if (index !== -1) node.parent.children.splice(index, 1)
    node.parent = null
  },
})
const root = element('root')
const app = renderer.createApp(WalletHandoff)
app.mount(root)
const nodes = (node) => [node, ...node.children.flatMap(nodes)]
const textOf = (node) => `${node.text}${node.children.map(textOf).join('')}`
let cancelButton = nodes(root).find((node) => node.type === 'button' && textOf(node) === 'Cancel action')
assert.ok(cancelButton, 'confirmed setup card offers an explicit Cancel action')
cancelButton.props.onClick()
await nextTick()

assert.equal(store.state.lendingSetupRecovery, null, 'cancel removes only the confirmed setup marker')
assert.equal(values.has('nysaSetupRecovery'), false)
assert.equal(store.state.swapOutcome.status, 'rejected', 'cancel settles the matching withdrawal as a refusal')
assert.equal(store.state.swapOutcome.signature, null, 'the setup signature is never presented as a withdrawal signature')
assert.equal(store.state.swapOutcome.amountBaseUnits, null, 'cancel never claims withdrawn USDY')
assert.equal(canRetryAfterTransactionOutcome(store.state.swapOutcome.status), true)
assert.doesNotThrow(() => assertCanStartLendingAction(store.state.lendingPending, { kind: 'withdraw' }))
const retryState = applySwapFlowOutcome({
  primaryStatus: 'pending', primaryAmountBaseUnits: null, followUpStatus: null,
  inputId: 'svm-usdy', outputId: 'svm-usdc',
}, store.state.swapOutcome, wallet, 'withdraw-sell')
assert.equal(retryState.primaryStatus, 'rejected', 'mounted Swap state becomes retryable after cancel')
assert.equal(retryState.primaryAmountBaseUnits, null)
assert.equal(nodes(root).some((node) => node.type === 'button' && textOf(node) === 'Cancel action'), false,
  'the setup recovery card disappears after cancellation')

store.state.lendingPending = {
  wallet,
  signature: 'pending-loop-signature',
  status: 'relay-unknown',
  kind: 'loop-close',
  params: { wallet, kind: 'loop-close', loopAction: true, positionId: 'multiply:position-1' },
}
store.state.handoff = { status: 'sending', label: 'Full close' }
await nextTick()
assert.ok(nodes(root).some((node) => textOf(node).includes('Full close')),
  'a pending loop action remains visible after the app reloads')
assert.ok(nodes(root).some((node) => textOf(node).includes('Sending and confirming')),
  'the iOS sending handoff remains visible beside the durable signature')
assert.ok(nodes(root).some((node) => node.type === 'a' && node.props.href === 'https://solscan.io/tx/pending-loop-signature'),
  'the durable card exposes the saved signature for reconciliation')
let stack = nodes(root).find((node) => node.props.class === 'ho-stack')
let stackedCards = nodes(root).filter((node) => node.type === 'div' && node.props.class?.includes('ho '))
assert.equal(stackedCards.length, 2, 'the sending handoff and durable pending signature remain visible as separate cards')
assert.ok(stackedCards.every((node) => node.parent === stack),
  'the sending handoff and pending signature use normal-flow stacked cards')
store.state.handoff = {
  status: 'error', label: 'Full close',
  error: 'Relay outcome is unknown; Nysa is checking the saved signature.',
}
await nextTick()
assert.ok(nodes(root).some((node) => textOf(node).includes('Relay outcome is unknown; Nysa is checking the saved signature.')),
  'a signatureless relay error remains visible beside the durable signature')
assert.ok(nodes(root).some((node) => textOf(node).includes('outcome is unknown')),
  'a signatureless same-label error does not replace the current signature status with stale error text')
stack = nodes(root).find((node) => node.props.class === 'ho-stack')
stackedCards = nodes(root).filter((node) => node.type === 'div' && node.props.class?.includes('ho '))
assert.equal(stackedCards.length, 2, 'the signatureless error and pending signature remain separate cards')
assert.ok(stackedCards.every((node) => node.parent === stack),
  'the signatureless error and pending signature do not overlap')
store.state.handoff = null
await nextTick()
assert.ok(nodes(root).some((node) => textOf(node).includes('outcome is unknown')),
  'the durable card explains an ambiguous relay outcome when no send handoff is active')

store.state.lendingSetupRecovery = {
  wallet,
  signature: 'confirmed-setup-signature',
  status: 'setup-confirmed',
  requiresUserAction: true,
  params: { wallet, kind: 'loop-open', market: 'sol-usdy-usdc' },
}
await nextTick()
stackedCards = nodes(root).filter((node) => node.type === 'div' && node.props.class?.includes('ho '))
stack = nodes(root).find((node) => node.props.class === 'ho-stack')
assert.ok(stack, 'wallet recovery cards share a single stack container')
assert.ok(stackedCards.includes(nodes(root).find((node) => node.props.class === 'ho error' && textOf(node).includes('Full close pending'))),
  'the unresolved economic signature remains visible beside setup recovery')
assert.ok(stackedCards.some((node) => textOf(node).includes('Account setup confirmed')),
  'the separate setup recovery card remains visible')
assert.ok(stackedCards.every((node) => node.parent === stack),
  'setup recovery and pending signatures use normal-flow stacked cards')
assert.equal(nodes(root).find((node) => node.type === 'button' && textOf(node) === 'Resume action').props.disabled, true,
  'setup continuation stays disabled while an economic signature is unresolved')
app.unmount()

console.log('wallet handoff cancel restores retryable withdrawal state')
