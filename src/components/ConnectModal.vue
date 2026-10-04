<script setup>
import { ref, onMounted, onUnmounted } from 'vue'
import { state, connectWallet } from '../store.js'

const emit = defineEmits(['close'])

// Mobile browsers (Safari, Chrome) have no wallet extensions: offer to reopen this page inside a wallet app's own browser,
// where the wallet is available as usual. Universal links open the app, or its store page if it isn't installed.
const isMobile = /Android|iPhone|iPad|iPod/i.test(navigator.userAgent) || (navigator.maxTouchPoints > 1 && /Macintosh/.test(navigator.userAgent))
const here = encodeURIComponent(location.href)
const origin = encodeURIComponent(location.origin)
const walletApps = [
  { name: 'Phantom', color: '#ab9ff2', href: `https://phantom.com/ul/browse/${here}?ref=${origin}` },
  { name: 'Solflare', color: '#fc7227', href: `https://solflare.com/ul/v1/browse/${here}?ref=${origin}` },
  { name: 'MetaMask', color: '#f6851b', href: `https://metamask.app.link/dapp/${location.host}${location.pathname}${location.search}` },
]
const busy = ref(null) // name of the wallet being connected
const error = ref(null)

async function connect(w) {
  busy.value = w.name
  error.value = null
  try { await connectWallet(w) } catch (e) { error.value = e.message } finally { busy.value = null }
}
const onKey = (e) => e.key === 'Escape' && emit('close')
onMounted(() => addEventListener('keydown', onKey))
onUnmounted(() => removeEventListener('keydown', onKey))
</script>

<template>
  <div class="cm-overlay" @click.self="emit('close')">
    <div class="cm-modal" role="dialog" aria-modal="true" aria-labelledby="cm-title">
      <div class="cm-head">
        <h3 id="cm-title" class="cm-title">Connect <span class="serif grad">wallet</span></h3>
        <button class="cm-x" aria-label="Close" @click="emit('close')">
          <svg viewBox="0 0 24 24" fill="none" stroke="currentColor"><path stroke-linecap="round" stroke-width="2" d="M6 18L18 6M6 6l12 12" /></svg>
        </button>
      </div>
      <p class="cm-sub">Connect a Solana wallet to continue.</p>
      <div class="cm-tabs single"><button class="cm-tab on">Solana</button></div>
      <div class="cm-list">
        <button v-for="w in state.wallets" :key="w.name" class="cm-wallet" :disabled="!!busy" @click="connect(w)">
          <img class="cm-wallet-img" :src="w.icon" alt="" />
          <span class="cm-wallet-name">{{ w.name }}</span>
          <span v-if="busy === w.name" class="cm-spinner" />
          <span v-else class="cm-arrow">→</span>
        </button>
        <template v-if="!state.wallets.length && isMobile">
          <a v-for="a in walletApps" :key="a.name" class="cm-wallet" :href="a.href">
            <span class="cm-wallet-img cm-initial" :style="{ background: a.color }">{{ a.name[0] }}</span>
            <span class="cm-wallet-name">Open in {{ a.name }}</span>
            <span class="cm-arrow">↗</span>
          </a>
          <div class="cm-hint">Your wallet app opens this page in its own browser, where you can connect.</div>
        </template>
        <div v-else-if="!state.wallets.length" class="cm-empty">No Solana wallet detected. Install Phantom and refresh.</div>
      </div>
      <div v-if="error" class="cm-error"><div class="cm-error-t">Connection failed</div><div class="cm-error-m">{{ error }}</div></div>
      <p class="cm-foot">Nysa on Solana runs on the Kamino Lend market</p>
    </div>
  </div>
</template>

<style scoped>
/* The wallet modal is deliberately light, like the original. */
.cm-overlay { position: fixed; inset: 0; z-index: 100; display: flex; align-items: center; justify-content: center; padding: 16px; background: #0a0a0a99; backdrop-filter: blur(6px); }
.cm-modal { width: 100%; max-width: 420px; background: var(--paper); border: 1px solid var(--line); border-radius: 22px; padding: 24px; box-shadow: 0 40px 100px -20px #0a0a0a80; font-family: var(--sans); color: var(--ink); }
.cm-head { display: flex; align-items: center; justify-content: space-between; }
.cm-title { font-family: var(--display); font-weight: 600; font-size: 22px; }
.cm-title .serif { font-size: 26px; }
.grad { background: var(--grad); -webkit-background-clip: text; background-clip: text; color: transparent; }
.cm-x { color: var(--mute); padding: 4px; border-radius: 8px; display: grid; place-items: center; }
.cm-x:hover { color: var(--ink); background: var(--paper-2); }
.cm-x svg { width: 22px; height: 22px; }
.cm-sub { color: var(--mute); font-size: 13.5px; margin: 8px 0 16px; }
.cm-tabs { display: grid; gap: 4px; padding: 4px; border: 1px solid var(--line); border-radius: 12px; background: var(--paper-2); margin-bottom: 14px; }
.cm-tab { border-radius: 9px; padding: 9px 0; font-family: var(--display); font-weight: 600; font-size: 13.5px; color: var(--mute); }
.cm-tab.on { background: #fff; color: var(--ink); box-shadow: 0 1px 3px #0a0a0a14; }
.cm-list { display: flex; flex-direction: column; gap: 10px; }
.cm-wallet { display: flex; align-items: center; gap: 14px; width: 100%; padding: 14px 16px; border: 1px solid var(--line); border-radius: 14px; background: var(--paper-2); font-family: var(--display); transition: border-color .15s, background .15s, transform .1s; }
.cm-wallet:hover:not(:disabled) { border-color: var(--m1); background: #fff; transform: translateY(-1px); }
.cm-wallet-img { width: 34px; height: 34px; border-radius: 9px; object-fit: contain; }
.cm-wallet-name { flex: 1; text-align: left; font-weight: 600; font-size: 15px; }
.cm-arrow { color: var(--m1); font-family: var(--mono); }
.cm-spinner { width: 18px; height: 18px; border: 2px solid var(--line); border-top-color: var(--m1); border-radius: 50%; animation: spin .7s linear infinite; }
.cm-initial { display: grid; place-items: center; color: #fff; font-weight: 700; font-size: 16px; }
.cm-hint { text-align: center; color: var(--mute); font-size: 12px; padding: 2px 8px 0; }
.cm-empty { text-align: center; color: var(--mute); font-size: 13px; padding: 18px; border: 1px dashed var(--line); border-radius: 14px; }
.cm-error { margin-top: 18px; background: #f9407512; border: 1px solid rgba(249,64,117,.3); border-radius: 12px; padding: 12px 14px; color: var(--m2); }
.cm-error-t { font-weight: 700; font-size: 13px; }
.cm-error-m { font-size: 12px; margin-top: 2px; }
.cm-foot { text-align: center; color: var(--faint); font-size: 11.5px; margin-top: 20px; font-family: var(--mono); }
</style>
