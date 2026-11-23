// "Sync Allocations" from Kamino's curator page, every 10 minutes: invests each reserve that is off its target
// allocation. `invest` is permissionless, so the key is a dedicated fee payer with a little SOL and no vault authority.
import { readFileSync } from 'node:fs'
import { createKeyPairFromBytes, createNoopSigner, getAddressFromPublicKey, getBase64EncodedWireTransaction, getTransactionDecoder, signTransaction } from '@solana/kit'
import { VAULTS } from '../src/config.js'
import { rpc, NONE } from './rpc.js'
import { getVault, refreshMarketForExecution } from './market.js'
import { vaultClient } from './vault.js'
import { offTarget, compile, simulated, fetchLuts } from './tx.js'

const EVERY_MS = 600_000

// offTarget's order (most over-allocated first, freeing liquidity for the others), minus reserves within
// minInvestDelaySlots of their last invest and those already tried this tick.
export const nextToInvest = (gaps, tried) => gaps.find((x) => !x.readyIn && !tried.has(String(x.a)))

async function confirmed(sig) {
  for (let i = 0; i < 30; i++) {
    const s = (await rpc.getSignatureStatuses([sig]).send()).value[0]
    if (s?.err) throw new Error(`${sig} failed: ${JSON.stringify(s.err)}`)
    if (s?.confirmationStatus === 'confirmed' || s?.confirmationStatus === 'finalized') return
    await new Promise((r) => setTimeout(r, 2_000))
  }
  throw new Error(`${sig} not confirmed after 60 s`)
}

async function syncVault(v, keys, payer) {
  const tried = new Set()
  for (;;) {
    const { kv, state, reserves, now } = getVault(v.id)
    const gaps = await offTarget(state, reserves, now)
    const next = nextToInvest(gaps, tried)
    if (!next) {
      const waiting = gaps.filter((x) => x.readyIn && !tried.has(String(x.a)))
      if (waiting.length) console.log(`[vault-crank] ${v.id} waiting:`, waiting.map((x) => `${x.a} ready in ${x.readyIn} slots`).join(', '))
      else if (!tried.size) console.log(`[vault-crank] ${v.id} on target`)
      return
    }
    tried.add(String(next.a))
    const move = `${next.gap > 0 ? 'invest' : 'disinvest'} ~${Math.abs(next.gap).toFixed(2)} in ${next.a}`
    try {
      const ixs = await vaultClient.investSingleReserveIxs(createNoopSigner(payer), kv, { address: next.a, state: reserves.get(next.a).state }, reserves)
      if (!ixs.length) { console.log(`[vault-crank] ${v.id} ${move}: below the minimum move, skipped`); continue }
      const luts = await fetchLuts(String(state.vaultLookupTable) === NONE ? [] : [state.vaultLookupTable])
      const { tx } = await simulated(await compile(payer, ixs, luts))
      const signed = await signTransaction([keys], getTransactionDecoder().decode(Buffer.from(tx, 'base64')))
      const sig = await rpc.sendTransaction(getBase64EncodedWireTransaction(signed), { encoding: 'base64', preflightCommitment: 'confirmed' }).send()
      await confirmed(sig)
      console.log(`[vault-crank] ${v.id} ${move}: confirmed ${sig}`)
    } catch (e) { console.error(`[vault-crank] ${v.id} ${move}: failed:`, e?.message) }
    await refreshMarketForExecution() // the next reserve is sized from the vault as this invest left it
  }
}

// Off unless VAULT_CRANK_KEYPAIR points at a Solana CLI keypair file (a JSON array of 64 bytes). Returns the tick.
export async function startVaultCrank(file = process.env.VAULT_CRANK_KEYPAIR) {
  if (!file) return null
  let keys
  // The error's code or name only: a JSON.parse message quotes the file, and the file is the key.
  try { keys = await createKeyPairFromBytes(Uint8Array.from(JSON.parse(readFileSync(file, 'utf8')))) }
  catch (e) { console.error('[vault-crank] off: cannot load VAULT_CRANK_KEYPAIR:', e?.code ?? e?.name); return null }
  const payer = await getAddressFromPublicKey(keys.publicKey)
  console.log(`[vault-crank] on, every ${EVERY_MS / 60_000} min, fee payer ${payer}`)
  let running = false
  const tick = async () => {
    if (running) return console.warn('[vault-crank] previous tick still running, skipped')
    running = true
    try { for (const v of VAULTS) await syncVault(v, keys, payer) }
    catch (e) { console.error('[vault-crank] tick failed:', e?.message) }
    finally { running = false }
  }
  setInterval(tick, EVERY_MS).unref()
  return tick
}
