<script setup>
import { ref } from 'vue'
defineProps({ token: Object, size: String, stack: Boolean })
const COLORS = { USDC: '#2775CA', USDT: '#26A17B', USDY: '#4B6BFB', WETH: '#8A92B2', WBTC: '#F09242' }
const broken = ref(false)
</script>

<template>
  <div class="n-tok" :class="[size, { stack }]" :title="token.name" :style="{ background: COLORS[token.name] ?? '#EC008C' }">
    <img v-if="token.icon && !broken" :src="token.icon" :alt="token.name" @error="broken = true" />
    <span v-else>{{ token.name[0] }}</span>
  </div>
</template>
