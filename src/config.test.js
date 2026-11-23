// Checks every market entry in config.js, so a mistake in a new market fails here and not in production.
import assert from 'node:assert/strict'
import { existsSync } from 'node:fs'
import { LIVE, LOOPS, MARKETS, OTHER_MARKETS, TOKENS, VAULTS, loopMarket, tokensOf } from './config.js'

const unique = (list, what) => assert.equal(new Set(list).size, list.length, `duplicate ${what}`)
const ADDRESS = /^[1-9A-HJ-NP-Za-km-z]{32,44}$/

unique(LIVE.map((m) => m.id), 'market id')
unique(LIVE.map((m) => m.kaminoMarket), 'Kamino market')
unique(LIVE.flatMap((m) => Object.values(m.reserves)), 'reserve address (each market has its own reserve of a token)')
unique(Object.values(TOKENS).map((t) => t.mint), 'token mint')
unique([...VAULTS.map((v) => v.id), ...VAULTS.map((v) => v.address)], 'vault')
for (const [id, t] of Object.entries(TOKENS)) {
  assert.equal(t.token_id, id)
  assert.match(t.mint, ADDRESS, `${id} mint`)
  assert.ok(t.name && t.icon && Number.isInteger(t.decimals) && t.price > 0, `${id} needs name, icon, decimals and a price`)
  assert.ok(existsSync(new URL(`../public${t.icon}`, import.meta.url)), `${id}: icon file public${t.icon} is missing`)
}
for (const m of LIVE) {
  assert.match(m.id, /^[\w-]+$/, `${m.id}: the id is used in URLs`)
  assert.match(m.kaminoMarket, ADDRESS, `${m.id} kaminoMarket`)
  assert.ok(m.name && m.blurb && m.dueDiligence?.rows.length, `${m.id} needs a name, a blurb and due diligence`)
  assert.ok(m.collateral.length && m.loans.length, `${m.id} needs collateral and loan tokens`)
  for (const t of tokensOf(m)) {
    assert.ok(t, `${m.id} lists a token missing from TOKENS`)
    assert.match(m.reserves[t.token_id] ?? '', ADDRESS, `${m.id} has no reserve address for ${t.token_id}`)
  }
  assert.equal(Object.keys(m.reserves).length, tokensOf(m).length, `${m.id} has a reserve for a token it does not list`)
  assert.ok(m.pairs.length, `${m.id} needs at least one collateral/loan pair`)
  for (const p of m.pairs) {
    assert.ok(m.collateral.includes(p.collateral) && m.loans.includes(p.liability), `${m.id}: pair ${p.collateral}/${p.liability} uses a token outside the market`)
    assert.ok(p.maxLtv < p.liqLtv && p.liqLtv <= 100, `${m.id}: max LTV must be under the liquidation LTV`)
  }
}
unique([...MARKETS, ...OTHER_MARKETS].map((m) => m.kaminoMarket), 'Kamino market (a market is either ours, loop-only or other)')
unique(MARKETS.map((m) => m.id), 'market id')
unique(LOOPS.map((l) => l.id), 'loop id')
unique(LOOPS.map((l) => l.market), 'loop market (one loop per market)')
for (const l of LOOPS) {
  const m = loopMarket(l)
  assert.ok(m, `loop ${l.id}: market ${l.market} is not in MARKETS`)
  assert.ok(m.reserves[l.collateral] && m.reserves[l.debt] && m.pairs.some((p) => p.collateral === l.collateral && p.liability === l.debt), `loop ${l.id}: ${m.id} has no ${l.collateral}/${l.debt} pair`)
  assert.match(l.lookupTable, ADDRESS, `loop ${l.id} lookupTable (scripts/create-loop-lut.js)`)
  assert.ok(l.maxLeverage > 1 && l.maxLeverage < 100 / (100 - m.pairs.find((p) => p.collateral === l.collateral).maxLtv), `loop ${l.id}: maxLeverage must be under the market's LTV limit`)
}
for (const m of OTHER_MARKETS) {
  assert.match(m.kaminoMarket, ADDRESS, `${m.name} kaminoMarket`)
  assert.ok(m.name && m.collateral.length && m.collateral.every((id) => TOKENS[id]), `${m.name} needs a name and collateral listed in TOKENS`)
}
console.log('config ok:', LIVE.length, 'market(s),', VAULTS.length, 'vault(s)')
