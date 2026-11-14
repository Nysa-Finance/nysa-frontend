<script setup>
import { computed, ref } from 'vue'
import { state, cancelHandoff, cancelLendingBuildReservation, cancelLendingSetupRecovery, dismissHandoff, reconcileLocalPendingAction, resumeLendingSetupRecovery } from '../store.js'
import { txUrl } from '../config.js'
import TxProgress from './TxProgress.vue'

const pendingAction = computed(() => {
  const pending = state.lendingPending
  if (!pending?.signature || !['signed-pending', 'submitted', 'relay-unknown'].includes(pending.status)) return null
  const labels = {
    'loop-open': 'Open loop', 'loop-close': 'Full close', 'loop-setup': 'Initialize Kamino metadata',
    deposit: 'Supply', withdraw: 'Withdraw', borrow: 'Borrow', repay: 'Repay', claim: 'Claim rewards',
    liquidate: 'Liquidate', 'vault-deposit': 'Deposit', 'vault-withdraw': 'Withdraw',
  }
  let message = pending.status === 'relay-unknown'
    ? 'The relay outcome is unknown. Nysa will keep checking this saved signature before allowing another action.'
    : pending.status === 'signed-pending'
      ? 'The signed transaction is saved and waiting for reconciliation. Do not submit it again.'
      : 'Waiting for transaction confirmation. Nysa will reconcile this signature before allowing another action.'
  if (state.handoff?.status === 'error' && state.handoff.signature === pending.signature) {
    message = state.handoff.error
  }
  return {
    label: labels[pending.kind] ?? pending.params?.kind ?? 'Transaction',
    signature: pending.signature,
    canCheckLocalExpiry: pending.status === 'relay-unknown' && typeof pending.signedTransactionBase64 === 'string',
    message,
    walletMismatch: state.address !== pending.wallet,
  }
})
const handoffTx = computed(() => state.handoff && {
  ...state.handoff, steps: [state.handoff.label], i: 0,
  status: state.handoff.status === 'sending' ? 'running' : state.handoff.status,
})
const checkingLocalExpiry = ref(false)
async function checkLocalExpiry() {
  if (checkingLocalExpiry.value) return
  checkingLocalExpiry.value = true
  try { await reconcileLocalPendingAction() }
  catch (error) {
    state.handoff = { status: 'error', label: pendingAction.value?.label ?? 'Transaction', error: error?.message ?? 'Local transaction status could not be verified.' }
  } finally { checkingLocalExpiry.value = false }
}

</script>

<template>
  <div class="ho-stack">
    <div v-if="!state.lendingActionBusy && state.lendingPending?.status === 'preparing' && state.lendingPending?.phase === 'building'" class="ho error" role="status">
      <div class="ho-label">Transaction build interrupted</div>
      <div class="ho-msg">No wallet was opened and no transaction was sent. Release this reservation to retry.</div>
      <div v-if="!state.lendingBuildCancelable" class="ho-msg">The build lease is still active. You can release it after the lease expires.</div>
      <div class="ho-actions">
        <button class="ho-link" :disabled="!state.lendingBuildCancelable" @click="cancelLendingBuildReservation">Cancel build reservation</button>
      </div>
    </div>
    <div v-if="pendingAction" class="ho error" role="status" data-testid="durable-pending-action">
      <div class="ho-label">{{ pendingAction.label }} pending</div>
      <div class="ho-msg">{{ pendingAction.message }}</div>
      <div v-if="pendingAction.walletMismatch" class="ho-msg">Reconnect the wallet that signed this transaction to continue reconciliation.</div>
      <div class="ho-actions">
        <a class="ho-link" :href="txUrl(pendingAction.signature)" target="_blank" rel="noopener noreferrer">View transaction ↗</a>
        <button v-if="pendingAction.canCheckLocalExpiry" class="ho-link" :disabled="checkingLocalExpiry" @click="checkLocalExpiry">{{ checkingLocalExpiry ? 'Checking Surfpool…' : 'Check dropped local transaction' }}</button>
      </div>
    </div>
    <div v-if="state.lendingSetupRecovery" class="ho error" role="status">
      <div class="ho-label">Account setup confirmed</div>
      <div class="ho-msg">Resume the requested action, or cancel it.</div>
      <div v-if="state.address !== state.lendingSetupRecovery.wallet" class="ho-msg">Reconnect the wallet that confirmed this setup before resuming.</div>
      <div class="ho-actions">
        <button class="ho-btn" :disabled="state.setupRecoveryBusy || !!state.lendingPending || state.address !== state.lendingSetupRecovery.wallet" @click="resumeLendingSetupRecovery">{{ state.setupRecoveryBusy ? 'Waiting for wallet…' : 'Resume action' }}</button>
        <button class="ho-link" :disabled="state.setupRecoveryBusy || !!state.lendingPending" @click="cancelLendingSetupRecovery">Cancel action</button>
      </div>
    </div>
  </div>
  <TxProgress v-if="handoffTx" :tx="handoffTx" handoff @dismiss="dismissHandoff" @cancel="cancelHandoff" />
</template>

<style scoped>
.ho-stack { position: fixed; left: 16px; right: 16px; bottom: 16px; z-index: 90; display: flex; flex-direction: column; gap: 8px; max-width: 440px; max-height: calc(100vh - 32px); overflow-y: auto; margin: 0 auto; pointer-events: none; }
.ho { position: relative; flex: 0 0 auto; width: 100%; margin: 0; padding: 16px 18px; border: 1px solid var(--n-line-2); border-radius: 12px; background: var(--n-bg-2); box-shadow: 0 20px 60px -10px #000c; font-size: 13px; color: var(--n-text-2); pointer-events: auto; }
.ho.error { border-color: #ff5d5d66; }
.ho-label { font-weight: 600; font-size: 14px; color: #fff; }
.ho-msg { margin-top: 4px; display: flex; align-items: center; gap: 8px; }
.ho.error .ho-msg { color: var(--n-red); }
.ho-actions { margin-top: 12px; display: flex; align-items: center; gap: 16px; }
.ho-btn { font-weight: 600; color: #fff; background: var(--grad); padding: 10px 18px; border-radius: 999px; }
.ho-btn:disabled, .ho-link:disabled { opacity: .45; cursor: not-allowed; }
.ho-link { color: var(--n-text-3); font-size: 13px; background: none; border: 0; padding: 0; cursor: pointer; }
</style>
