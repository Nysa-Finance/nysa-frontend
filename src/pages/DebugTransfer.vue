<script setup>
// TEMPORARY page for Phantom's domain review: a plain SOL transfer from this domain. Not linked anywhere; remove after the test.
import { state, sendTestTransfer, useTx } from '../store.js'
import TxProgress from '../components/TxProgress.vue'

const { tx, run, reset } = useTx()
const send = () => run([{ label: 'Transfer 0.000001 SOL to yourself', run: sendTestTransfer }])
</script>

<template>
  <div class="dbg">
    <h1>Wallet <span class="serif">test</span></h1>
    <p>Sends 0.000001 SOL from your wallet to your own address (only the network fee is spent).</p>
    <button v-if="!state.address" class="dbg-btn" @click="state.connectOpen = true">Connect wallet</button>
    <button v-else class="dbg-btn" :disabled="tx.status === 'running'" @click="send">Send 0.000001 SOL to myself</button>
    <TxProgress :tx="tx" @dismiss="reset" />
  </div>
</template>

<style scoped>
.dbg { max-width: 520px; margin: 60px auto; padding: 0 16px; text-align: center; }
.dbg h1 { font-weight: 600; font-size: 30px; }
.dbg h1 .serif { color: var(--m1); }
.dbg p { color: var(--n-text-3); font-size: 14px; margin: 12px 0 24px; }
.dbg-btn { font-weight: 600; font-size: 14px; color: #fff; background: var(--grad); padding: 13px 24px; border-radius: 999px; border: 0; cursor: pointer; }
.dbg-btn:disabled { opacity: .5; cursor: default; }
</style>
