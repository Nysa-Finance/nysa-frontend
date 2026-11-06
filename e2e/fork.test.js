// End-to-end test on a local fork of Solana mainnet (Surfpool): the transactions Nysa's backend builds, signed by
// throwaway wallets and landed against the real Kamino market and vault. Checks each flow's balances and that every
// transaction carries our compute limit (above what it used) and priority fee.
//
// `npm run test:e2e`. Needs surfpool (brew install txtx/taps/surfpool) and internet: the fork fetches mainnet accounts
// on first use, from the public RPC unless E2E_UPSTREAM_RPC is set. Not part of `npm test` / CI: it depends on live
// mainnet state and a rate-limited public RPC.
import assert from 'node:assert/strict'
import { spawn } from 'node:child_process'
import { mkdtempSync, openSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

const PORT = 18899 // not Surfpool's default 8899, so a fork already running for development isn't reused
const RPC = `http://127.0.0.1:${PORT}`
const UPSTREAM = process.env.E2E_UPSTREAM_RPC || 'https://api.mainnet-beta.solana.com'
const TOKEN_PROGRAM = 'TokenkegQfeZyiNwAJbNbGKPFXCWuBvf9Ss623VQ5DA'
const dir = mkdtempSync(join(tmpdir(), 'nysa-e2e-'))
const sleep = (ms) => new Promise((r) => setTimeout(r, ms))
const close = (a, b, tolerance, label) => assert.ok(Math.abs(a - b) <= tolerance, `${label}: ${a}, expected ${b} ± ${tolerance}`)

async function call(method, params = []) {
  const r = await (await fetch(RPC, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ jsonrpc: '2.0', id: 1, method, params }) })).json()
  if (r.error) throw new Error(`${method}: ${JSON.stringify(r.error)}`)
  return r.result
}
const up = () => call('getHealth').then(() => true, () => false)
if (await up()) throw new Error(`port ${PORT} is already in use (a surfpool left running?): stop it first`)

const surfpool = spawn('surfpool', ['start', '--rpc-url', UPSTREAM, '--port', String(PORT), '--ws-port', String(PORT + 1), '--no-tui', '--no-studio', '-y'], { cwd: dir, stdio: ['ignore', openSync(join(dir, 'surfpool.log'), 'w'), 'inherit'] })
surfpool.on('error', (e) => { console.error(e.code === 'ENOENT' ? 'surfpool is not installed: brew install txtx/taps/surfpool' : e); process.exit(1) })
surfpool.on('exit', (code) => { if (code) { console.error(`surfpool exited (${code})`); process.exit(1) } })
// SIGINT: surfpool ignores SIGTERM.
process.on('exit', (code) => { surfpool.kill('SIGINT'); if (code) console.error(`Surfpool log: ${join(dir, 'surfpool.log')}`) })
for (let i = 0; !(await up()); i++) {
  if (i > 120) throw new Error('surfpool did not start')
  await sleep(500)
}

// The backend reads the fork: set before its modules load.
process.env.SOLANA_RPC = RPC
process.env.DATA_DIR = join(dir, 'data')
const kit = await import('@solana/kit')
const { address, generateKeyPair, getAddressFromPublicKey, getTransactionDecoder, signTransaction, getBase64EncodedWireTransaction, getBase58Encoder, createNoopSigner } = kit
const { default: Decimal } = await import('decimal.js')
const { buildComputeBudgetIx } = await import('@kamino-finance/klend-sdk')
const { rpc } = await import('../server/rpc.js')
const { refreshMarket, getVault, getSnapshot } = await import('../server/market.js')
const { buildTx, txStatus } = await import('../server/tx.js')
const { vaultClient } = await import('../server/vault.js')
const { getAccount } = await import('../server/account.js')
const { TOKENS, VAULTS } = await import('../src/config.js')
const { underLimit } = await import('../src/logic.js')
const USDY = TOKENS['svm-usdy'], USDC = TOKENS['svm-usdc'], MARKET = 'sol-usdy-usdc', VAULT = VAULTS[0].id

// Oracle prices stop updating in a fork: give each reserve a long max price age, or Kamino refuses the stale prices.
for (const t of Object.values(TOKENS)) {
  const { value } = await rpc.getAccountInfo(address(t.reserve), { encoding: 'base64' }).send()
  const d = Buffer.from(value.data[0], 'base64'), CONFIG = 8 + 4848, TOKEN_INFO = CONFIG + 176
  d.writeBigUInt64LE(10n ** 9n, TOKEN_INFO + 64) // maxAgePriceSeconds
  d.writeBigUInt64LE(10n ** 9n, TOKEN_INFO + 72) // maxAgeTwapSeconds
  await call('surfnet_setAccount', [t.reserve, { data: d.toString('hex') }])
}
// A refresh logs its errors and keeps the old data (the fork's upstream can fail a read): retry until one succeeds.
async function refresh() {
  for (let i = 0; i < 5; i++) {
    const before = getSnapshot()?.updatedAt
    await refreshMarket()
    if (getSnapshot()?.updatedAt !== before) return
    await sleep(2000)
  }
  throw new Error('market refresh keeps failing')
}
await refresh()

async function wallet({ sol = 10, usdy = 0, usdc = 0 }) {
  const kp = await generateKeyPair(), addr = await getAddressFromPublicKey(kp.publicKey)
  if (sol) await call('surfnet_setAccount', [addr, { lamports: sol * 1e9 }])
  if (usdy) await call('surfnet_setTokenAccount', [addr, USDY.mint, { amount: usdy * 10 ** USDY.decimals }, TOKEN_PROGRAM])
  if (usdc) await call('surfnet_setTokenAccount', [addr, USDC.mint, { amount: usdc * 10 ** USDC.decimals }, TOKEN_PROGRAM])
  return { kp, addr }
}
const account = (w) => getAccount(w.addr, true)

// Signs, sends and waits for a transaction; returns its compute budget as it landed.
async function land(w, b64, label) {
  const tx = await signTransaction([w.kp], getTransactionDecoder().decode(Buffer.from(b64, 'base64')))
  const sig = await rpc.sendTransaction(getBase64EncodedWireTransaction(tx), { encoding: 'base64', preflightCommitment: 'confirmed' }).send()
  let s
  for (let i = 0; i < 60 && (s = await txStatus(sig)).status === 'pending'; i++) await sleep(500)
  assert.equal(s.status, 'confirmed', `${label}: ${s.error ?? s.status}`)
  const t = await call('getTransaction', [sig, { maxSupportedTransactionVersion: 1, encoding: 'json', commitment: 'confirmed' }])
  const keys = t.transaction.message.accountKeys
  const budget = t.transaction.message.instructions.filter((i) => keys[i.programIdIndex].startsWith('ComputeBudget')).map((i) => Buffer.from(getBase58Encoder().encode(i.data)))
  await refresh()
  return { used: t.meta.computeUnitsConsumed, limit: budget.find((b) => b[0] === 2)?.readUInt32LE(1), price: budget.find((b) => b[0] === 3)?.readBigUInt64LE(1) }
}

// A Nysa action as the app does it: build and send until the final transaction (a first one may set up accounts).
async function act(w, params) {
  const label = `${params.kind} ${params.all ? 'all' : params.amount} ${params.token ?? params.vault}`
  for (let step = 0; step < 3; step++) {
    const built = await buildTx({ ...params, wallet: w.addr })
    const { used, limit, price } = await land(w, built.tx, label)
    assert.ok(limit > used, `${label}: compute limit ${limit} not above the ${used} used`)
    assert.ok(price > 0n, `${label}: no priority fee`)
    console.log(`  ✓ ${label}${built.final ? '' : ' (setup)'} · ${used} / ${limit} CU · ${price} µlamports/CU`)
    if (built.final) return built
  }
  throw new Error(`${label}: no final transaction after 3 steps`)
}

console.log('Market: supply USDY, borrow USDC, repay, withdraw')
{
  const w = await wallet({ usdy: 100, usdc: 10 })
  await act(w, { kind: 'deposit', market: MARKET, token: 'svm-usdy', amount: 50 })
  close((await account(w)).positions['svm-usdy'].supplied, 50, 1e-5, 'USDY supplied')
  await act(w, { kind: 'borrow', market: MARKET, token: 'svm-usdc', amount: 5 })
  let a = await account(w)
  close(a.positions['svm-usdc'].borrowed, 5, 1e-3, 'USDC borrowed')
  close(a.balances['svm-usdc'], 15, 1e-6, 'wallet USDC after borrow')
  await act(w, { kind: 'repay', market: MARKET, token: 'svm-usdc', all: true })
  assert.equal((await account(w)).positions['svm-usdc'].borrowed, 0, 'USDC debt after repay all')
  await act(w, { kind: 'withdraw', market: MARKET, token: 'svm-usdy', all: true })
  a = await account(w)
  assert.equal(a.positions['svm-usdy'].supplied, 0, 'USDY supplied after withdraw all')
  close(a.balances['svm-usdy'], 100, 1e-5, 'wallet USDY after withdraw all')
}

console.log('Market limits: up to Kamino\'s max (less the UI margin) lands, above it gets a clear message')
{
  const w = await wallet({ usdy: 100, usdc: 10 })
  await act(w, { kind: 'deposit', market: MARKET, token: 'svm-usdy', amount: 50 })
  const { maxBorrow } = (await account(w)).positions['svm-usdc']
  assert.ok(maxBorrow > 0, 'maxBorrow from Kamino')
  await assert.rejects(buildTx({ kind: 'borrow', market: MARKET, token: 'svm-usdc', amount: maxBorrow * 1.001, wallet: w.addr }), /above your borrow limit: you can borrow up to/)
  console.log(`  ✓ borrow above the max (${maxBorrow}) refused with the max`)
  await act(w, { kind: 'borrow', market: MARKET, token: 'svm-usdc', amount: underLimit(maxBorrow, USDC.decimals) })
  await act(w, { kind: 'repay', market: MARKET, token: 'svm-usdc', all: true })
  await act(w, { kind: 'borrow', market: MARKET, token: 'svm-usdc', amount: 20 })
  const { maxWithdraw, supplied } = (await account(w)).positions['svm-usdy']
  assert.ok(maxWithdraw > 0 && maxWithdraw < supplied, `maxWithdraw ${maxWithdraw} limited by the loan`)
  await assert.rejects(buildTx({ kind: 'withdraw', market: MARKET, token: 'svm-usdy', amount: maxWithdraw * 1.001, wallet: w.addr }), /more than you can withdraw right now: up to/)
  console.log(`  ✓ withdraw above the max (${maxWithdraw}) refused with the max`)
  await act(w, { kind: 'withdraw', market: MARKET, token: 'svm-usdy', amount: underLimit(maxWithdraw, USDY.decimals) })
}

console.log('Vault: deposit, withdraw all')
{
  const w = await wallet({ usdc: 100 })
  await act(w, { kind: 'vault-deposit', vault: VAULT, amount: 50 })
  let a = await account(w)
  close(a.vaults[VAULT].value, 50, 0.05, 'vault position value')
  close(a.balances['svm-usdc'], 50, 1e-6, 'wallet USDC after deposit')
  await act(w, { kind: 'vault-withdraw', vault: VAULT, all: true })
  a = await account(w)
  assert.equal(a.vaults[VAULT].shares, 0, 'shares after withdraw all')
  close(a.balances['svm-usdc'], 100, 0.05, 'wallet USDC after withdraw all')
}

console.log('Vault: shares staked in the vault farm (a deposit made on Kamino), withdrawn through Nysa')
{
  const w = await wallet({ usdc: 100 })
  const live = getVault(VAULT)
  assert.ok(live.farm, 'the vault has a farm')
  const d = await vaultClient.depositIxs(createNoopSigner(w.addr), live.kv, new Decimal(100), live.reserves, live.farm.state, null)
  const { value: bh } = await rpc.getLatestBlockhash().send()
  const luts = await kit.fetchAddressesForLookupTables([live.state.vaultLookupTable], rpc)
  const msg = kit.pipe(kit.createTransactionMessage({ version: 0 }), (m) => kit.setTransactionMessageFeePayer(w.addr, m), (m) => kit.setTransactionMessageLifetimeUsingBlockhash(bh, m),
    (m) => kit.appendTransactionMessageInstructions([buildComputeBudgetIx(600_000), ...d.depositIxs, ...d.stakeInFarmIfNeededIxs], m), (m) => kit.compressTransactionMessageUsingAddressLookupTables(m, luts))
  await land(w, getBase64EncodedWireTransaction(kit.compileTransaction(msg)), 'staked deposit')
  let a = await account(w)
  assert.ok(a.vaults[VAULT].staked > 0, 'shares staked in the farm')
  console.log(`  ✓ staked deposit · ${a.vaults[VAULT].staked} shares staked`)
  await act(w, { kind: 'vault-withdraw', vault: VAULT, amount: 30 })
  close((await account(w)).vaults[VAULT].value, 70, 0.1, 'vault position after withdrawing 30')
  await act(w, { kind: 'vault-withdraw', vault: VAULT, all: true })
  a = await account(w)
  assert.equal(a.vaults[VAULT].shares, 0, 'shares after withdraw all')
  assert.equal(a.vaults[VAULT].staked, 0, 'staked shares after withdraw all')
  close(a.balances['svm-usdc'], 100, 0.1, 'wallet USDC after withdraw all')
}

console.log('No SOL: a clear message instead of a bare simulation failure')
{
  const w = await wallet({ sol: 0, usdc: 50 })
  await assert.rejects(buildTx({ kind: 'vault-deposit', vault: VAULT, amount: 50, wallet: w.addr }), /needs a little SOL/)
  console.log('  ✓ vault deposit from a wallet without SOL')
}

console.log('\nAll end-to-end checks passed')
process.exit(0)
