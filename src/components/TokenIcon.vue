<script setup>
import { computed, ref } from 'vue'
const props = defineProps({ token: Object, size: String, stack: Boolean })
const COLORS = {
  USDC: '#2775CA',
  USDT: '#26A17B',
  USDY: '#122A5F',
  WETH: '#8A92B2',
  WBTC: '#F09242',
  oTFY: '#000000',
  nOPAL: '#fff',
  sUSDai: '#fff',
}
const broken = ref(false)
const bg = computed(() => COLORS[props.token.name] ?? '#EC008C')
// The fallback letter is black or white, whichever reads on the token's colour (relative luminance above ~0.4: black).
const ink = computed(() => {
  const hex = bg.value.replace('#', '').replace(/^(.)(.)(.)$/, '$1$1$2$2$3$3')
  const [r, g, b] = [0, 2, 4].map((i) => {
    const c = parseInt(hex.slice(i, i + 2), 16) / 255
    return c <= 0.03928 ? c / 12.92 : ((c + 0.055) / 1.055) ** 2.4
  })
  return 0.2126 * r + 0.7152 * g + 0.0722 * b > 0.4 ? '#000' : '#fff'
})
</script>

<template>
  <div class="n-tok" :class="[size, { stack }]" :title="token.name" :style="{ background: bg, color: ink }">
    <img v-if="token.icon && !broken" :src="token.icon" :alt="token.name" @error="broken = true" />
    <span v-else>{{ token.name[0] }}</span>
  </div>
</template>
