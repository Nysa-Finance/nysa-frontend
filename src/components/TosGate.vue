<script setup>
import { ref } from 'vue'
import { acceptTos } from '../store.js'
import { TOS_URL } from '../config.js'
const agreed = ref(false)
</script>

<template>
  <div class="overlay tos" role="dialog" aria-modal="true" aria-labelledby="tos-title">
    <div class="n-dialog tos__card">
      <img class="tos__mark" src="/brand/logo-mark-128.png" alt="Nysa" />
      <div class="tos__tag">Terms of Service</div>
      <h2 id="tos-title" class="n-dialog-title tos__title">Before you <span class="tos__grad">continue</span></h2>
      <p class="tos__text">
        To access the Nysa Finance interface you must read and agree to our Terms of Service. Please review them in full before proceeding.
      </p>
      <a class="tos__link" :href="TOS_URL" target="_blank" rel="noopener noreferrer">Read the Terms of Service ↗&#xFE0E;</a>
      <label class="tos__check">
        <input v-model="agreed" type="checkbox" />
        <span>I have read and agree to the <a :href="TOS_URL" target="_blank" rel="noopener noreferrer">Terms of Service</a>.</span>
      </label>
      <button class="tos__btn" :disabled="!agreed" @click="acceptTos">Accept &amp; Continue</button>
    </div>
  </div>
</template>

<style scoped>
/* Blocking: a stronger scrim, and no Esc or outside click until the terms are accepted. */
.tos { z-index: 1100; background: #000000d1; }
.tos__card { text-align: center; }
.tos__mark { display: block; width: 40px; height: 40px; margin: 0 auto 22px; }
.tos__tag { display: inline-block; font-size: 11px; letter-spacing: .14em; text-transform: uppercase; color: var(--n-text-3); border: 1px solid var(--n-line-2); border-radius: 999px; padding: 6px 12px; margin-bottom: 22px; }
.tos__title { margin-bottom: 16px; }
.tos__grad { background: var(--grad); -webkit-background-clip: text; background-clip: text; color: transparent; }
.tos__text { color: var(--n-text-2); font-size: 14px; line-height: 1.6; margin-bottom: 20px; }
.tos__link { display: inline-block; font-size: 13px; font-weight: 600; border: 1px solid var(--n-line-2); border-radius: 999px; padding: 9px 18px; margin-bottom: 24px; transition: border-color .2s; }
.tos__link:hover { border-color: #5a5a5a; }
.tos__check { display: flex; align-items: flex-start; gap: 10px; text-align: left; font-size: 13px; color: var(--n-text-2); margin-bottom: 24px; }
.tos__check input { margin-top: 3px; flex-shrink: 0; }
.tos__check a { color: #fff; text-decoration: underline; }
.tos__btn { width: 100%; font-weight: 600; font-size: 14px; color: #fff; background: var(--grad); padding: 13px 18px; border-radius: 999px; transition: filter .15s, box-shadow .2s, opacity .2s; }
.tos__btn:hover:not(:disabled) { filter: brightness(1.1); box-shadow: 0 12px 30px -8px #ec008cb3; }
.tos__btn:disabled { opacity: .4; cursor: not-allowed; }
</style>
