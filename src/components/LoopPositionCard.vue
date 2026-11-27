<script setup>
// One open loop: its value, yield, leverage and risk, and the button that closes it.
import { tok } from '../../shared/config.js'
import { pct, usdFull, hfText, leverageText, healthLevel } from '../../shared/format.js'
import TokenIcon from './TokenIcon.vue'

defineProps({
  position: { type: Object, required: true },
  view: { type: Object, required: true }, // net, netApy, leverage, liqPrice, hf, readiness (Loop.vue positionView)
  picked: Boolean, // just opened, or linked to from the portfolio
  acting: Boolean, // a transaction is running
})
defineEmits(['close'])
</script>

<template>
  <section class="n-panel position" :class="{ picked }">
    <div class="panel-h">
      <span class="pair"
        ><TokenIcon :token="tok(position.collateral.tokenId)" size="sm" />{{ tok(position.collateral.tokenId).name }} /
        <TokenIcon :token="tok(position.liability.tokenId)" size="sm" />{{ tok(position.liability.tokenId).name }}</span
      >
    </div>
    <div class="n-stats pos-stats">
      <div class="n-stat">
        <div class="k">Net value</div>
        <div class="v">{{ usdFull(view.net) }}</div>
      </div>
      <div class="n-stat">
        <div class="k">Net APY</div>
        <div class="v" :class="view.netApy < 0 ? 'neg' : 'accent'">{{ pct(view.netApy) }}</div>
      </div>
      <div class="n-stat">
        <div class="k">Leverage</div>
        <div class="v">{{ view.leverage ? leverageText(view.leverage) : '—' }}</div>
      </div>
      <div class="n-stat">
        <div class="k">Liquidation price</div>
        <div class="v">{{ view.liqPrice ? `$${view.liqPrice.toFixed(4)}` : '—' }}</div>
      </div>
      <div class="n-stat">
        <div class="k">Health factor</div>
        <div class="v">
          {{ hfText(view.hf) }}
          <span v-if="Number.isFinite(view.hf)" class="n-chip" :class="healthLevel(view.hf)[0]">{{
            healthLevel(view.hf)[1]
          }}</span>
        </div>
      </div>
    </div>
    <div class="close">
      <button class="n-btn-grad" :disabled="acting || !view.readiness?.executionEnabled" @click="$emit('close')">
        {{ acting ? 'Preparing…' : 'Close loop' }}
      </button>
      <span v-if="!view.readiness?.executionEnabled" class="why">Closing isn't available yet.</span>
    </div>
  </section>
</template>

<style scoped>
.position {
  margin-top: 0;
  margin-bottom: 18px;
}
.position.picked {
  border-color: var(--n-pink);
}
.panel-h {
  display: flex;
  justify-content: space-between;
  align-items: center;
  gap: 12px;
  flex-wrap: wrap;
  margin-bottom: 18px;
}
.pair {
  display: flex;
  align-items: center;
  gap: 7px;
  color: var(--n-text-2);
  font-size: 13px;
}
.neg {
  color: var(--n-red);
  font-weight: 600;
} /* a negative yield is a loss: red, so it never reads as a gain */
.n-chip.ok {
  color: var(--n-green);
  border-color: #3ddc8459;
}
.n-chip.bad {
  color: var(--n-red);
  border-color: #ff5d5d66;
}
.pos-stats {
  grid-template-columns: repeat(5, minmax(0, 1fr));
}
.pos-stats .n-stat {
  padding: 18px 20px;
}
.pos-stats .n-stat .v {
  font-size: 22px;
}
.pos-stats .n-chip {
  vertical-align: middle;
  margin-left: 6px;
}
.close {
  display: flex;
  align-items: center;
  gap: 16px;
  flex-wrap: wrap;
  margin-top: 18px;
}
.close .why {
  text-align: left;
  color: var(--n-text-3);
  font-size: 13px;
}
.close .n-btn-grad:disabled {
  opacity: 0.4;
  cursor: not-allowed;
  filter: none;
  box-shadow: none;
}
@media (max-width: 1080px) {
  .pos-stats {
    grid-template-columns: repeat(2, minmax(0, 1fr));
  }
  .pos-stats .n-stat:last-child {
    grid-column: 1 / -1;
  }
}
</style>
