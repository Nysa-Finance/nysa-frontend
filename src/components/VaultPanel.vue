<script setup>
// Deposit into / withdraw from an Earn vault (kVault). Amounts are in the vault's token; the backend turns a withdrawal
// into shares and invests new deposits in the vault's markets (server/tx.js).
import { ref, computed, watch } from 'vue'
import { state, sendVaultAction, useTx } from '../store.js'
import { tok } from '../config.js'
import { pct, amt, usdFull, num, floorTo, coversAll } from '../logic.js'
import TxProgress from './TxProgress.vue'

const props = defineProps({ vault: Object, live: Object, initialTab: String })
const { tx, run, reset } = useTx()

const tab = ref(props.initialTab === 'withdraw' ? 'withdraw' : 'deposit')
const amount = ref('')
const token = computed(() => tok(props.live?.tokenId ?? 'svm-usdc'))
const on = computed(() => !!state.address)
const position = computed(() => state.vaultPositions[props.vault.id]?.value ?? 0)
const wallet = computed(() => state.balances[token.value.token_id] ?? 0)
const available = computed(() => (tab.value === 'deposit' ? wallet.value : position.value))
const price = computed(() => state.reserves[token.value.token_id]?.price ?? 1)
const capRoom = computed(() => Math.max((props.live?.depositCap ?? Infinity) - (props.live?.total ?? 0), 0))

const warning = computed(() => {
  if (!on.value) return 'Connect a Solana wallet to continue.'
  if (!props.live) return 'Vault data could not be read — actions are disabled until it recovers.'
  const a = num(amount.value)
  if (!a) return null
  if (a > available.value + 10 ** -token.value.decimals) return tab.value === 'deposit' ? `You only hold ${amt(available.value)} ${token.value.name}.` : `Your deposit is worth ${amt(available.value)} ${token.value.name}.`
  if (tab.value === 'deposit' && a < props.live.minDeposit) return `The minimum deposit is ${props.live.minDeposit} ${token.value.name}.`
  if (tab.value === 'deposit' && a > capRoom.value) return `The vault's deposit cap leaves room for ${amt(capRoom.value)} ${token.value.name}.`
  return null
})
const canSubmit = computed(() => on.value && num(amount.value) > 0 && !warning.value && tx.status !== 'running')
// Withdrawing (within one unit) everything redeems every share, so no dust is left in the vault.
const all = computed(() => tab.value === 'withdraw' && coversAll(num(amount.value), position.value, token.value.decimals))
const quick = (p) => {
  const v = floorTo((available.value * p) / 100, token.value.decimals)
  amount.value = v > 0 ? String(v) : ''
}
watch(tab, () => { amount.value = ''; reset() })

async function submit() {
  const kind = tab.value === 'deposit' ? 'vault-deposit' : 'vault-withdraw'
  const label = `${tab.value === 'deposit' ? 'Deposit' : 'Withdraw'} ${token.value.name}`
  if (await run([{ label, run: () => sendVaultAction(kind, props.vault, { amount: num(amount.value), all: all.value }) }])) amount.value = ''
}
</script>

<template>
  <div class="n-panel">
    <div class="n-seg" style="margin-bottom: 22px">
      <button :class="{ on: tab === 'deposit' }" @click="tab = 'deposit'">Deposit</button>
      <button :class="{ on: tab === 'withdraw' }" @click="tab = 'withdraw'">Withdraw</button>
    </div>
    <div class="n-kv" style="margin-bottom: 10px"><span class="k">Vault APY</span><span class="v accent">{{ live ? pct(live.apy) : '—' }}</span></div>
    <div class="n-kv" style="margin-bottom: 10px"><span class="k">Your deposit</span><span class="v">{{ on ? `${amt(position)} ${token.name}` : '—' }}</span></div>
    <div class="n-kv" style="margin-bottom: 20px">
      <span class="k">{{ tab === 'deposit' ? 'Wallet balance' : 'Available to withdraw' }}</span>
      <span class="v">{{ on ? `${amt(available)} ${token.name}` : '—' }}</span>
    </div>
    <div class="n-label">Amount ({{ token.name }})</div>
    <input v-model="amount" class="n-input" type="number" inputmode="decimal" min="0" step="any" placeholder="0.00" :disabled="!on" style="margin-bottom: 10px" />
    <div class="n-quick" style="margin-bottom: 14px">
      <button v-for="p in [25, 50, 75, 100]" :key="p" :disabled="!on" @click="quick(p)">{{ p === 100 ? 'MAX' : p + '%' }}</button>
    </div>
    <div class="n-kv" style="margin-bottom: 10px"><span class="k">Value</span><span class="v">{{ usdFull(num(amount) * price) }}</span></div>
    <div v-if="live && (live.withdrawPenaltyPct || live.withdrawPenaltyFixed)" class="n-kv" style="margin-bottom: 18px">
      <span class="k">Withdrawal fee</span><span class="v">{{ pct(live.withdrawPenaltyPct, 2) }}<template v-if="live.withdrawPenaltyFixed"> + {{ live.withdrawPenaltyFixed }} {{ token.name }}</template></span>
    </div>
    <div v-else style="margin-bottom: 8px" />
    <p v-if="all && !warning" class="n-note" style="margin-bottom: 16px">Withdrawing in full: every share is redeemed.</p>
    <p v-if="warning" class="n-warn" style="margin-bottom: 16px">{{ warning }}</p>
    <button class="n-btn-block" :disabled="!canSubmit" @click="submit">{{ tab === 'deposit' ? 'Deposit' : 'Withdraw' }} {{ token.name }}</button>
    <TxProgress :tx="tx" @dismiss="reset" />
  </div>
</template>
