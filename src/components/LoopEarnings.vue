<script setup>
// "How this loop earns": the yield and borrow cost at the chosen leverage, the liquidation risk, and the fees.
import { TOKENS } from '../../shared/config.js'
import { pct, usdFull, hfText, healthLevel } from '../../shared/format.js'
import { formatBaseUnits } from '../../shared/swap-fees.js'

const props = defineProps({
  loop: { type: Object, required: true },
  coll: { type: Object, required: true },
  debt: { type: Object, required: true },
  leverage: { type: Number, required: true },
  rates: { type: Object, required: true }, // hold, native, nativeSource, borrow (Loop.vue ratesOf)
  est: { type: Object, required: true }, // estimates at this leverage (Loop.vue est)
  liqLtv: Number,
  collPrice: Number,
  feeBps: Number, // Nysa's swap fee; 0 = none
  quote: Object, // the current preview, or null while there is none
  ratesAsOf: String,
})

const feeLabel = (fee) => {
  const t = Object.values(TOKENS).find((x) => x.mint === fee.mint)
  return `${formatBaseUnits(BigInt(fee.amountBaseUnits), t.decimals)} ${t.name}`
}
const quotedFees = () => (props.quote?.fees ?? []).filter((f) => f.bps)
</script>

<template>
  <section class="n-panel">
    <h2 class="side-h">How this loop earns</h2>
    <div class="rows first">
      <div class="n-kv">
        <span class="k">{{ coll.name }} yield × {{ Number(leverage).toFixed(2) }}</span
        ><span class="v">{{ pct(rates.hold * leverage) }}</span>
      </div>
      <div class="n-kv">
        <span class="k">{{ debt.name }} borrow × {{ (leverage - 1).toFixed(2) }}</span
        ><span class="v neg">{{ rates.borrow == null ? '—' : `−${pct(rates.borrow * (leverage - 1))}` }}</span>
      </div>
      <div class="n-kv total">
        <span class="k">Net APY</span
        ><span class="v" :class="est.netApy < 0 ? 'neg' : 'up'">{{ est.netApy == null ? '—' : pct(est.netApy) }}</span>
      </div>
      <p v-if="est.netApy != null && (rates.native != null || !loop.priceYield)" class="vs">
        vs {{ pct(rates.hold) }} holding {{ coll.name }}
      </p>
      <p v-else-if="loop.priceYield && rates.native == null" class="vs">
        {{ coll.name }}'s own yield isn't included yet: it needs a week of recorded prices.
      </p>
    </div>
    <div class="rows">
      <div class="n-kv">
        <span class="k">Liquidation price</span
        ><span class="v"
          >${{ est.liqPrice.toFixed(4) }}
          <small>{{ coll.name }} −{{ ((1 - est.liqPrice / collPrice) * 100).toFixed(0) }}%</small></span
        >
      </div>
      <div class="n-kv">
        <span class="k">Health</span
        ><span class="n-chip" :class="healthLevel(est.hf)[0]">{{ healthLevel(est.hf)[1] }}</span>
      </div>
      <div class="bar" aria-hidden="true">
        <span class="lim" :style="{ left: `${liqLtv}%` }"></span
        ><span class="mark" :style="{ left: `${est.ltv}%` }"></span>
      </div>
      <div class="bar-l">
        <span>LTV {{ pct(est.ltv, 1) }}</span
        ><span>liquidation {{ pct(liqLtv, 0) }}</span>
      </div>
    </div>
    <div class="rows last">
      <div v-if="feeBps" class="n-kv">
        <span class="k">Nysa fee ({{ feeBps / 100 }}% of swap)</span
        ><span class="v">{{
          quote && quote.feeTotalUsd != null ? usdFull(quote.feeTotalUsd) : `≈ ${usdFull((est.swap * feeBps) / 10000)}`
        }}</span>
      </div>
      <p v-else class="fee-note">Nysa charges 0% fees. Standard slippage and routing fees apply.</p>
      <div v-if="quote && quote.knownCostsTotalUsd != null" class="n-kv">
        <span class="k">Borrow and flash loan fees</span
        ><span class="v">{{ usdFull(Math.max(0, quote.knownCostsTotalUsd - (quote.feeTotalUsd ?? 0))) }}</span>
      </div>
    </div>
    <details class="more">
      <summary>Details</summary>
      <div class="n-kv">
        <span class="k">Health factor</span><span class="v">{{ hfText(est.hf) }}</span>
      </div>
      <div class="n-kv"><span class="k">Max slippage</span><span class="v">0.5%</span></div>
      <div v-for="fee in quotedFees()" :key="fee.action" class="n-kv">
        <span class="k">Nysa fee</span><span class="v">{{ feeLabel(fee) }}</span>
      </div>
      <div v-if="loop.priceYield" class="n-kv">
        <span class="k">{{ coll.name }} yield</span
        ><span class="v">{{
          rates.native == null
            ? '—'
            : `${pct(rates.native)} (${rates.nativeSource === 'env' ? 'published rate' : '30-day price'})`
        }}</span>
      </div>
      <div class="n-kv">
        <span class="k">Closing</span><span class="v">returns {{ coll.name }}</span>
      </div>
      <div class="n-kv">
        <span class="k">Rates as of</span
        ><span class="v">{{ ratesAsOf ? new Date(ratesAsOf).toLocaleString() : '—' }}</span>
      </div>
    </details>
  </section>
</template>

<style scoped>
.side-h {
  font-size: 18px;
  font-weight: 600;
  margin-bottom: 16px;
}
.rows {
  display: grid;
  gap: 9px;
  padding: 14px 0;
  border-bottom: 1px solid var(--n-line);
}
.rows.first {
  padding-top: 0;
}
.rows.last {
  border-bottom: 0;
  padding-bottom: 0;
}
.n-kv.total {
  padding-top: 6px;
  border-top: 1px solid var(--n-hair);
  font-weight: 600;
}
.n-kv.total .v {
  font-size: 18px;
}
.n-kv .v.up {
  color: var(--n-green);
  font-weight: 600;
}
.n-kv .v.neg {
  color: var(--n-text-2);
  font-weight: 600;
} /* the borrow cost line: a cost, not the result */
.n-kv.total .v.neg {
  color: var(--n-red);
}
.n-kv .v small {
  color: var(--n-text-4);
  font-weight: 400;
  font-size: 12px;
  margin-left: 6px;
}
.vs {
  color: var(--n-text-4);
  font-size: 12px;
}
.n-chip.ok {
  color: var(--n-green);
  border-color: #3ddc8459;
}
.n-chip.bad {
  color: var(--n-red);
  border-color: #ff5d5d66;
}
.bar {
  position: relative;
  height: 6px;
  border-radius: 999px;
  background: linear-gradient(90deg, var(--n-green) 0%, var(--n-green) 45%, var(--n-amber) 70%, var(--n-red) 100%);
  margin: 6px 0 0;
  opacity: 0.85;
}
.bar .mark {
  position: absolute;
  top: -5px;
  width: 3px;
  height: 16px;
  border-radius: 2px;
  background: #fff;
  transform: translateX(-50%);
  transition: left 0.2s;
}
.bar .lim {
  position: absolute;
  top: -3px;
  width: 1px;
  height: 12px;
  background: #fff8;
}
.bar-l {
  display: flex;
  justify-content: space-between;
  color: var(--n-text-4);
  font-size: 12px;
}
.fee-note {
  margin: 0;
  padding: 6px 0;
  color: var(--n-text-3);
  font-size: 12px;
}
.more {
  margin-top: 12px;
  color: var(--n-text-3);
  font-size: 13px;
}
.more summary {
  cursor: pointer;
  list-style: none;
}
.more summary::before {
  content: '+ ';
  color: var(--n-pink);
}
.more[open] summary::before {
  content: '− ';
}
.more .n-kv {
  margin-top: 8px;
}
@media (prefers-reduced-motion: reduce) {
  .bar .mark {
    transition: none;
  }
}
</style>
