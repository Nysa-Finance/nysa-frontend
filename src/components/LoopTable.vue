<script setup>
// The loops a wallet can open, one row each; a row opens its loop.
import { tok } from '../../shared/config.js'
import { pct, usd, leverageText } from '../../shared/format.js'
import TokenIcon from './TokenIcon.vue'

defineProps({
  rows: { type: Array, required: true }, // { loop, netApy, liquidity, deposited }
  loaded: Boolean, // strategies have loaded: an empty list now means none is open
})
defineEmits(['open'])
</script>

<template>
  <div class="loops">
    <div class="n-thead lp-grid">
      <div>Asset</div>
      <div>Max net APY</div>
      <div>Max leverage</div>
      <div>Available liquidity</div>
      <div>Deposited</div>
      <div>Borrow</div>
    </div>
    <div v-if="loaded && !rows.length" class="n-empty">Loops aren't open on Nysa yet.</div>
    <div
      v-for="{ loop, netApy, liquidity, deposited } in rows"
      :key="loop.id"
      class="n-tr click lp-grid lp-row"
      role="link"
      tabindex="0"
      @click="$emit('open', loop)"
      @keydown.enter="$emit('open', loop)"
    >
      <div class="n-cell n-asset" data-label="Asset">
        <TokenIcon :token="tok(loop.collateral)" /><span class="asset-name"
          ><b>{{ tok(loop.collateral).name }}</b
          ><small>{{ loop.fullName }}</small></span
        >
      </div>
      <div class="n-cell n-num" :class="netApy < 0 ? 'neg' : 'up'" data-label="Max net APY">
        {{ netApy == null ? '—' : pct(netApy) }}
      </div>
      <div class="n-cell n-num" data-label="Max leverage">{{ leverageText(loop.maxLeverage) }}</div>
      <div class="n-cell n-num" data-label="Available liquidity">{{ usd(liquidity) }}</div>
      <div class="n-cell n-num" data-label="Deposited">{{ usd(deposited) }}</div>
      <div class="n-cell" data-label="Borrow"><TokenIcon :token="tok(loop.debt)" size="sm" /></div>
    </div>
  </div>
</template>

<style scoped>
/* Rows as cards, numbers right-aligned */
.loops {
  border: 1px solid var(--n-line);
  border-radius: 12px;
  background: var(--n-bg-2);
  padding: 0 10px 10px;
}
.loops .n-thead {
  border-bottom: 0;
  padding: 14px 18px 6px;
}
.lp-grid {
  grid-template-columns: minmax(0, 1.6fr) 1fr 0.9fr 1fr 1fr 0.6fr;
}
.lp-grid > :not(:first-child) {
  justify-self: end;
  text-align: right;
}
.lp-row {
  background: #000;
  border: 1px solid var(--n-line);
  border-radius: 4px;
  padding: 16px 18px;
  margin-top: 8px;
}
.lp-row:last-child {
  border-bottom: 1px solid var(--n-line);
}
.lp-row:hover,
.lp-row:focus-visible {
  border-color: var(--n-line-2);
  outline: none;
}
.asset-name {
  display: grid;
  line-height: 1.25;
}
.asset-name small {
  color: var(--n-text-3);
  font-weight: 400;
  font-size: 13px;
}
.up {
  color: var(--n-green);
  font-weight: 600;
}
.neg {
  color: var(--n-red);
  font-weight: 600;
} /* a negative yield is a loss: red, so it never reads as a gain */
@media (max-width: 860px) {
  .loops {
    padding: 0 8px 8px;
  }
  .lp-grid > :not(:first-child) {
    justify-self: stretch;
    text-align: left;
  }
}
</style>
