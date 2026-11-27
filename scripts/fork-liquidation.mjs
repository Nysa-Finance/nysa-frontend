// Local liquidation test on a surfpool mainnet fork: opens a loan in the USDY market from a throwaway wallet, makes it
// liquidatable (its recorded debt raised by 15%, as if interest had grown it), lists it in the server's market index,
// and funds your wallet with SOL and USDC on the fork so you can liquidate it from the Liquidations page.
// Nothing here touches mainnet: every write goes to the fork given by SOLANA_RPC.
//
//   SOLANA_RPC=http://127.0.0.1:8899 DATA_DIR=/tmp/nysa-fork-data node scripts/fork-liquidation.mjs <your wallet address>
//   SOLANA_RPC=http://127.0.0.1:8899 node scripts/fork-liquidation.mjs --refresh-prices
//
// The fork's oracle prices go stale (USDY after 3 minutes) and Kamino then refuses a liquidation: --refresh-prices
// reloads the price accounts from mainnet. Run it right before liquidating. DATA_DIR must be the server's.
import { Connection, Keypair, PublicKey, VersionedTransaction } from '@solana/web3.js'

const URL_ = process.env.SOLANA_RPC
if (!/^http:\/\/(127\.0\.0\.1|localhost):\d+\/?$/.test(URL_ ?? ''))
  throw new Error('Set SOLANA_RPC to the local fork, e.g. http://127.0.0.1:8899')
const c = new Connection(URL_, 'confirmed')
const call = async (method, params) => {
  const j = await (
    await fetch(URL_, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ jsonrpc: '2.0', id: 1, method, params }),
    })
  ).json()
  if (j.error) throw new Error(`${method}: ${JSON.stringify(j.error)}`)
  return j.result
}
const market = await import('../server/market.js')
const { LIVE, TOKENS } = await import('../src/config.js')
const m = LIVE.find((x) => x.id === 'sol-usdy-usdc')
const TOKEN_PROGRAM = 'TokenkegQfeZyiNwAJbNbGKPFXCWuBvf9Ss623VQ5DA'

// Reload every reserve's oracle price account from mainnet, so Kamino sees fresh prices.
async function refreshPrices() {
  await market.refreshMarket()
  const { market: km } = market.getLive(m)
  const feeds = new Set(
    Object.values(m.reserves).map((r) =>
      String(km.getReserveByAddress(r).state.config.tokenInfo.scopeConfiguration.priceFeed),
    ),
  )
  for (const feed of feeds) await call('surfnet_resetAccount', [feed])
  console.log(`Oracle prices reloaded from mainnet (${feeds.size} account${feeds.size === 1 ? '' : 's'}).`)
}
if (process.argv.includes('--refresh-prices')) {
  await refreshPrices()
  process.exit(0)
}

const liquidator = process.argv[2]
try {
  new PublicKey(liquidator)
} catch {
  throw new Error('Pass your wallet address: node scripts/fork-liquidation.mjs <address>')
}
if (!process.env.DATA_DIR)
  throw new Error(
    "Set DATA_DIR to the server's data folder (e.g. /tmp/nysa-fork-data), so the loan shows on the Liquidations page.",
  )
const tx = await import('../server/tx.js')
const { obligationType } = await import('../server/account.js')
const { recordIndexedObligation } = await import('../server/positions.js')
const { read, write, INDEX } = await import('../server/storage.js')
const { Obligation } = await import('@kamino-finance/klend-sdk/dist/@codegen/klend/accounts/Obligation.js')

// Your wallet on the fork: SOL for fees, USDC to repay the debt with.
await call('surfnet_setAccount', [liquidator, { lamports: 2e9 }])
await call('surfnet_setTokenAccount', [liquidator, TOKENS['svm-usdc'].mint, { amount: 2_000e6 }, TOKEN_PROGRAM])
console.log(`Your wallet ${liquidator} has 2 SOL and 2,000 USDC on the fork.`)

// A throwaway borrower: 300 USDY of collateral, 290 USDC borrowed (built by the server, signed here, sent to the fork).
await refreshPrices()
const borrower = Keypair.generate(),
  owner = borrower.publicKey.toBase58()
await call('surfnet_setAccount', [owner, { lamports: 2e9 }])
await call('surfnet_setTokenAccount', [owner, TOKENS['svm-usdy'].mint, { amount: 300e6 }, TOKEN_PROGRAM])
async function act(label, req) {
  for (let step = 0; step < 3; step++) {
    // a new wallet's first transactions set up its Kamino account
    const built = await tx.buildTx({ wallet: owner, market: m.id, ...req })
    const t = VersionedTransaction.deserialize(Buffer.from(built.tx, 'base64'))
    t.message.recentBlockhash = (await c.getLatestBlockhash()).blockhash
    t.sign([borrower])
    const sig = await c.sendRawTransaction(t.serialize())
    let landed = null // polled, so any fork port works (no websocket)
    for (let i = 0; i < 60 && !landed; i++) {
      landed = await c.getTransaction(sig, { maxSupportedTransactionVersion: 0, commitment: 'confirmed' })
      if (!landed) await new Promise((r) => setTimeout(r, 500))
    }
    if (!landed) throw new Error(`${label}: not confirmed after 30 s`)
    if (landed.meta.err)
      throw new Error(
        `${label} failed: ${JSON.stringify(landed.meta.err)}\n${landed.meta.logMessages?.slice(-6).join('\n')}`,
      )
    await market.refreshMarket()
    if (built.final) return console.log(`Borrower: ${label}`)
  }
}
await act('deposited 300 USDY', { kind: 'deposit', token: 'svm-usdy', amount: 300 })
await act('borrowed 290 USDC', { kind: 'borrow', token: 'svm-usdc', amount: 290 })

// Make it liquidatable: its recorded USDC debt +15%, written straight into the obligation account on the fork.
const { market: km } = market.getLive(m)
const ob = await km.getObligationByWallet(owner, obligationType())
const acc = await c.getAccountInfo(new PublicKey(ob.obligationAddress))
const state = Obligation.decode(acc.data)
const borrow = state.borrows.find((b) => String(b.borrowReserve) === m.reserves['svm-usdc'])
borrow.borrowedAmountSf = borrow.borrowedAmountSf.muln(115).divn(100)
const data = Buffer.alloc(acc.data.length)
acc.data.copy(data, 0, 0, 8)
Obligation.layout.encode(state, data, 8)
await call('surfnet_setAccount', [
  String(ob.obligationAddress),
  { lamports: acc.lamports, data: data.toString('hex'), owner: acc.owner.toBase58(), executable: false },
])

// List it in the server's market index (what /api/analytics reads), so the Liquidations page shows it.
const index = JSON.parse((await read(INDEX)) ?? '{}')
recordIndexedObligation(index, m.kaminoMarket, String(ob.obligationAddress), owner)
await write(INDEX, JSON.stringify(index))

await market.refreshMarket()
const info = await tx.liquidationInfo(m, owner)
console.log(
  `\nLiquidatable loan ready: borrower ${owner}, debt ${info.debt.toFixed(2)} USDC, health factor ${info.hf.toFixed(3)}, up to ${info.maxRepay.toFixed(2)} USDC repayable now.`,
)
console.log(
  'Start (or restart) the server with the same DATA_DIR, open /liquidations, and run --refresh-prices right before liquidating.',
)
process.exit(0)
