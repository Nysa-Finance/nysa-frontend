<script setup>
import { ref, onMounted, onUnmounted } from 'vue'
import { state, connectWallet, deeplinkWallets, connectDeeplink } from '../store.js'
import { MWA_NAME as MWA } from '../wallets.js'

const emit = defineEmits(['close'])

const busy = ref(null)
const error = ref(state.connectError) // e.g. WalletConnect failed after this window had closed
state.connectError = null

async function connect(w) {
  // WalletConnect opens Reown's own modal: this window steps aside, and comes back on an error.
  if (w.walletconnect) {
    emit('close')
    try {
      await connectWallet(w)
    } catch (e) {
      if (!/cancelled/i.test(e.message)) {
        state.connectError = e.message
        state.connectOpen = true
      }
    }
    return
  }
  busy.value = w.name
  error.value = null
  try {
    await connectWallet(w)
  } catch (e) {
    error.value = e.message
  } finally {
    busy.value = null
  }
}
const onKey = (e) => e.key === 'Escape' && emit('close')
onMounted(() => addEventListener('keydown', onKey))
onUnmounted(() => removeEventListener('keydown', onKey))
</script>

<template>
  <div class="overlay" @click.self="emit('close')">
    <div class="n-dialog cm-modal" role="dialog" aria-modal="true" aria-labelledby="cm-title">
      <div class="n-dialog-head">
        <h3 id="cm-title" class="n-dialog-title">Connect <span class="grad">wallet</span></h3>
        <button class="x-btn" aria-label="Close" @click="emit('close')">
          <svg viewBox="0 0 24 24" fill="none" stroke="currentColor">
            <path stroke-linecap="round" stroke-width="2" d="M6 18L18 6M6 6l12 12" />
          </svg>
        </button>
      </div>
      <p class="n-dialog-sub cm-sub">Connect a Solana wallet to continue.</p>
      <div class="cm-list">
        <button v-for="w in state.wallets" :key="w.name" class="cm-wallet" :disabled="!!busy" @click="connect(w)">
          <span v-if="w.name === MWA" class="cm-wallet-img cm-pair"
            ><img src="/wallets/phantom.svg" alt="" /><img src="/wallets/solflare.svg" alt=""
          /></span>
          <img v-else class="cm-wallet-img" :src="w.icon" alt="" />
          <span class="cm-wallet-name">{{ w.name === MWA ? 'Phantom, Solflare & other apps' : w.name }}</span>
          <span v-if="busy === w.name" class="cm-spinner" />
          <span v-else class="cm-arrow">→</span>
        </button>
        <button v-for="w in deeplinkWallets()" :key="w.name" class="cm-wallet" @click="connectDeeplink(w.name)">
          <img class="cm-wallet-img" :src="w.icon" alt="" />
          <span class="cm-wallet-name">{{ w.name }}</span>
          <span class="cm-arrow">→</span>
        </button>
        <div v-if="deeplinkWallets().length" class="cm-hint">
          Approve in the app, then you'll come back here automatically.
        </div>
        <div v-if="!state.wallets.length && !deeplinkWallets().length" class="cm-empty">
          No Solana wallet detected. Install Phantom and refresh.
        </div>
      </div>
      <div v-if="error" class="cm-error">
        <div class="cm-error-t">Connection failed</div>
        <div class="cm-error-m">{{ error }}</div>
      </div>
      <p class="cm-foot">Nysa on Solana runs on the Kamino Lend market</p>
    </div>
  </div>
</template>

<style scoped>
.cm-modal {
  max-width: 420px;
}
.grad {
  background: var(--grad);
  -webkit-background-clip: text;
  background-clip: text;
  color: transparent;
}
.cm-sub {
  margin: 6px 0 18px;
}
.cm-list {
  display: flex;
  flex-direction: column;
  gap: 10px;
}
.cm-wallet {
  display: flex;
  align-items: center;
  gap: 14px;
  width: 100%;
  padding: 14px 16px;
  border: 1px solid var(--n-line);
  border-radius: 12px;
  background: #000;
  color: var(--n-text);
  transition:
    border-color 0.15s,
    background 0.15s;
}
.cm-wallet:hover:not(:disabled) {
  border-color: #5a5a5a;
  background: var(--n-bg-3);
}
.cm-wallet:disabled {
  opacity: 0.4;
  cursor: not-allowed;
}
.cm-wallet-img {
  width: 34px;
  height: 34px;
  border-radius: 9px;
  object-fit: contain;
}
.cm-wallet-name {
  flex: 1;
  text-align: left;
  font-weight: 600;
  font-size: 15px;
}
.cm-arrow {
  color: var(--n-pink);
}
.cm-spinner {
  width: 18px;
  height: 18px;
  border: 2px solid var(--n-line-2);
  border-top-color: var(--n-pink);
  border-radius: 50%;
  animation: spin 0.7s linear infinite;
}
.cm-pair {
  display: flex;
  gap: 4px;
  width: auto;
  height: auto;
  flex-shrink: 0;
}
.cm-pair img {
  width: 30px;
  height: 30px;
  border-radius: 8px;
}
.cm-hint {
  text-align: center;
  color: var(--n-text-4);
  font-size: 12px;
  padding: 2px 8px 0;
}
.cm-empty {
  text-align: center;
  color: var(--n-text-3);
  font-size: 13px;
  padding: 18px;
  border: 1px dashed var(--n-line-2);
  border-radius: 12px;
}
.cm-error {
  margin-top: 18px;
  background: #ff5d5d14;
  border: 1px solid #ff5d5d59;
  border-radius: 4px;
  padding: 12px 14px;
  color: var(--n-red);
}
.cm-error-t {
  font-weight: 600;
  font-size: 13px;
}
.cm-error-m {
  font-size: 12px;
  margin-top: 2px;
  color: var(--n-text-2);
}
.cm-foot {
  text-align: center;
  color: var(--n-text-4);
  font-size: 11px;
  margin-top: 20px;
  font-family: var(--mono);
}
</style>
