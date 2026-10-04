<script setup>
import { ref } from 'vue'
import { acceptTos } from '../store.js'
import { TOS_URL } from '../config.js'
const agreed = ref(false)
</script>

<template>
  <div class="tos" role="dialog" aria-modal="true" aria-labelledby="tos-title">
    <div class="tos__backdrop" />
    <div class="tos__card">
      <img class="tos__mark" src="/brand/logo-mark-128.png" alt="Nysa" />
      <div class="tos__tag">Terms of Service</div>
      <h2 id="tos-title" class="tos__title">Before you <span class="tos__grad">continue</span></h2>
      <p class="tos__text">
        To access the Nysa Finance interface you must read and agree to our Terms of Service. Please review them in full before proceeding.
      </p>
      <a class="tos__link" :href="TOS_URL" target="_blank" rel="noopener noreferrer">Read the Terms of Service ↗</a>
      <label class="tos__check">
        <input v-model="agreed" type="checkbox" />
        <span>I have read and agree to the <a :href="TOS_URL" target="_blank" rel="noopener noreferrer">Terms of Service</a>.</span>
      </label>
      <button class="tos__btn" :disabled="!agreed" @click="acceptTos">Accept &amp; Continue</button>
    </div>
  </div>
</template>

<style scoped>
.tos { position: fixed; inset: 0; z-index: 1100; display: flex; align-items: center; justify-content: center; padding: 24px; }
.tos__backdrop { position: absolute; inset: 0; background: #000000d1; backdrop-filter: blur(6px); }
.tos__card { position: relative; max-width: 480px; width: 100%; text-align: center; background: #0b0b0f; border: 1px solid rgba(255,255,255,.1); border-radius: 20px; padding: 40px 32px; box-shadow: 0 30px 80px -20px #000c; }
.tos__mark { display: block; width: 40px; height: 40px; margin: 0 auto 22px; }
.tos__tag { display: inline-block; font-size: 11px; letter-spacing: .14em; text-transform: uppercase; color: #ffffff8c; border: 1px solid rgba(255,255,255,.16); border-radius: 999px; padding: 6px 12px; margin-bottom: 22px; }
.tos__title { font-family: var(--serif); font-style: italic; font-weight: 400; font-size: 34px; line-height: 1.1; margin-bottom: 16px; }
.tos__grad { background: var(--grad); -webkit-background-clip: text; background-clip: text; color: transparent; }
.tos__text { color: #ffffffb8; font-size: 14px; line-height: 1.6; margin-bottom: 20px; }
.tos__link { display: inline-block; font-size: 13px; font-weight: 600; border: 1px solid rgba(255,255,255,.18); border-radius: 999px; padding: 9px 18px; margin-bottom: 24px; transition: border-color .2s; }
.tos__link:hover { border-color: #fff6; }
.tos__check { display: flex; align-items: flex-start; gap: 10px; text-align: left; font-size: 13px; color: #fffc; margin-bottom: 24px; }
.tos__check input { margin-top: 3px; flex-shrink: 0; }
.tos__check a { color: #fff; text-decoration: underline; }
.tos__btn { width: 100%; font-weight: 600; font-size: 14px; color: #fff; background: var(--grad); padding: 13px 18px; border-radius: 999px; transition: transform .15s, box-shadow .2s, opacity .2s; }
.tos__btn:hover:not(:disabled) { transform: translateY(-1px); box-shadow: 0 12px 30px -8px #ec008cb3; }
.tos__btn:disabled { opacity: .4; cursor: not-allowed; }
</style>
