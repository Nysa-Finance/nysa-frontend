// Local preview of Squads proposal #7 on a surfpool mainnet fork (http://127.0.0.1:8899): RWA Prime gets the USDC
// reserve of the Obligate market (weight 11). The proposal's instruction is simulated as if the Squads vault signed it,
// its result is written into the fork, then both reserves are invested the way Kamino's bot does every ~15 minutes.
// `--uncap` also sets the vault's deposit cap to 0 (uncapped), as the other pending proposal does.
// Run: SOLANA_RPC=http://127.0.0.1:8899 node scripts/fork-squads-7.mjs [--uncap]
import {
  ComputeBudgetProgram,
  Connection,
  Keypair,
  PublicKey,
  TransactionInstruction,
  TransactionMessage,
  VersionedTransaction,
} from '@solana/web3.js'

const URL = 'http://127.0.0.1:8899'
if (process.env.SOLANA_RPC !== URL)
  throw new Error(`Run with SOLANA_RPC=${URL}: this only ever writes to the local fork.`)
const c = new Connection(URL, 'confirmed')
const P = (s) => new PublicKey(s)
const call = async (method, params) => {
  const j = await (
    await fetch(URL, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ jsonrpc: '2.0', id: 1, method, params }),
    })
  ).json()
  if (j.error) throw new Error(`${method}: ${JSON.stringify(j.error)}`)
  return j.result
}

const VAULT_STATE = '2Qxsj1hi95avkp7sANDmbVT5TwqRPGsutuvJasJK9xL7' // RWA Prime
const CTOKEN_VAULT = '7L2Lf2Lpyi2Akd6EfBoZEoe8dJnJaLmA69K6cUvcH1Nu' // created by the proposal
const SQUADS_VAULT = 'AnGb7abiecGc9Xosv4ncwC8hRNuf8T9W2K5MZSvPgD4e' // the proposal's signer
const DEPOSIT_CAP_OFFSET = 58736 // VaultState.depositCap (u64)

// The proposal's instruction: updateReserveAllocationV2(weight 11, cap u64::MAX, ctoken cap 0) on the Obligate USDC reserve.
const ix = new TransactionInstruction({
  programId: P('KvauGMspG5k6rtzrqqn7WNn3oZdyKqLKwK2XWQ8FLjd'),
  keys: [
    [SQUADS_VAULT, 1, 1],
    [VAULT_STATE, 0, 1],
    ['AAgG4G9gK2dJ9UB4pyyfsMcJwfftTyqpAHiC282YE4UA', 0, 0],
    ['BxvavFamaw3BmQJC9niL3qEAtEaHbTvZALY7jFt3Dyqs', 0, 1],
    ['Au2Cg9CNNTX1KfzVhNnpi1ouHX74CwMMBvmSchmqS5ZW', 0, 0],
    [CTOKEN_VAULT, 0, 1],
    ['5Y6UaZWutLK6SLfJYL8zC4aZVCfn67My5MAfD1RWY9WS', 0, 0],
    ['TokenkegQfeZyiNwAJbNbGKPFXCWuBvf9Ss623VQ5DA', 0, 0],
    ['11111111111111111111111111111111', 0, 0],
    ['SysvarRent111111111111111111111111111111111', 0, 0],
  ].map(([k, s, w]) => ({ pubkey: P(k), isSigner: !!s, isWritable: !!w })),
  data: Buffer.from('c388014f0a7b79640b00000000000000ffffffffffffffff0000000000000000', 'hex'),
})
const msg = new TransactionMessage({
  payerKey: P(SQUADS_VAULT),
  recentBlockhash: (await c.getLatestBlockhash()).blockhash,
  instructions: [ix],
}).compileToV0Message()
const sim = await c.simulateTransaction(new VersionedTransaction(msg), {
  sigVerify: false,
  replaceRecentBlockhash: true,
  accounts: { encoding: 'base64', addresses: [VAULT_STATE, CTOKEN_VAULT] },
})
if (sim.value.err)
  throw new Error(`Proposal simulation failed: ${JSON.stringify(sim.value.err)}\n${sim.value.logs?.join('\n')}`)
for (const [i, a] of [VAULT_STATE, CTOKEN_VAULT].entries()) {
  const acc = sim.value.accounts[i]
  const data = Buffer.from(acc.data[0], 'base64')
  if (a === VAULT_STATE && process.argv.includes('--uncap')) data.writeBigUInt64LE(0n, DEPOSIT_CAP_OFFSET)
  await call('surfnet_setAccount', [
    a,
    { lamports: acc.lamports, data: data.toString('hex'), owner: acc.owner, executable: false },
  ])
}
console.log(`Proposal #7 applied on the fork${process.argv.includes('--uncap') ? ', deposit cap removed' : ''}.`)

// Kamino's bot: invest the vault into every reserve (permissionless; a throwaway fork wallet pays).
const market = await import('../server/market.js')
const { vaultClient } = await import('../server/vault.js')
const { createNoopSigner } = await import('@solana/kit')
const payer = Keypair.generate()
await call('surfnet_setAccount', [payer.publicKey.toBase58(), { lamports: 1e9 }])
await market.refreshMarket()
const { kv, reserves, state } = market.getVault('rwa-prime')
const lut = (await c.getAddressLookupTable(P(String(state.vaultLookupTable)))).value
for (const [a, r] of reserves) {
  const kix = await vaultClient.investSingleReserveIxs(
    createNoopSigner(payer.publicKey.toBase58()),
    kv,
    { address: a, state: r.state },
    reserves,
  )
  if (!kix.length) continue
  const ixs = kix.map(
    (x) =>
      new TransactionInstruction({
        programId: P(x.programAddress),
        data: Buffer.from(x.data ?? []),
        keys: (x.accounts ?? []).map((k) => ({
          pubkey: P(k.address),
          isSigner: k.role >= 2,
          isWritable: k.role % 2 === 1,
        })),
      }),
  )
  const m = new TransactionMessage({
    payerKey: payer.publicKey,
    recentBlockhash: (await c.getLatestBlockhash()).blockhash,
    instructions: [ComputeBudgetProgram.setComputeUnitLimit({ units: 1_400_000 }), ...ixs],
  }).compileToV0Message(lut ? [lut] : [])
  const t = new VersionedTransaction(m)
  t.sign([payer])
  const sig = await c.sendRawTransaction(t.serialize())
  await c.confirmTransaction(sig, 'confirmed')
  const failed = (await c.getTransaction(sig, { maxSupportedTransactionVersion: 0, commitment: 'confirmed' })).meta.err
  console.log(`Invested into reserve ${String(a).slice(0, 6)}…: ${failed ? 'failed' : 'ok'}`)
}
await market.refreshMarket()
for (const x of market.getSnapshot().vaults['rwa-prime'].allocations)
  console.log(`  ${x.marketName ?? x.market}: ${Math.round(x.invested).toLocaleString('en-US')} USDC`)
process.exit(0)
