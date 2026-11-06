import { mkdir, writeFile } from 'node:fs/promises'
import { dirname, resolve } from 'node:path'
import { pathToFileURL } from 'node:url'
import { TOKENS } from '../src/config.js'

const DEFAULT_RPC = 'http://127.0.0.1:8899'
const DEFAULT_OUTPUT = 'docs/local-loop-fork-wallet-report.json'

function requireEnv(name) {
  const value = process.env[name]?.trim()
  if (!value) throw new Error(`Missing ${name}; run npm run setup:loop-fork first.`)
  return value
}

function loopbackRpc(value) {
  const endpoint = new URL(value || DEFAULT_RPC)
  if (endpoint.protocol !== 'http:' || !['localhost', '127.0.0.1', '[::1]'].includes(endpoint.hostname.toLowerCase())) {
    throw new Error('Refusing to export local wallet state from a non-loopback RPC endpoint.')
  }
  return endpoint
}

async function rpc(endpoint, method, params = []) {
  const response = await fetch(endpoint, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ jsonrpc: '2.0', id: 1, method, params }),
    signal: AbortSignal.timeout(10_000),
  })
  if (!response.ok) throw new Error(`Local RPC returned HTTP ${response.status} for ${method}.`)
  const body = await response.json()
  if (body?.error) throw new Error(`Local RPC ${method} failed: ${body.error.message ?? 'RPC error'}`)
  return body.result
}

async function tokenBalance(endpoint, account, token) {
  try {
    const result = await rpc(endpoint, 'getTokenAccountBalance', [account, { commitment: 'confirmed' }])
    const amount = result.value.amount
    return {
      account, mint: token.mint, decimals: result.value.decimals,
      baseUnits: amount, uiAmount: result.value.uiAmountString,
    }
  } catch (error) {
    return { account, mint: token.mint, decimals: token.decimals, baseUnits: null, uiAmount: null, error: error.message }
  }
}

function formatBaseUnits(baseUnits, decimals) {
  const amount = BigInt(baseUnits)
  const scale = 10n ** BigInt(decimals)
  const fraction = String(amount % scale).padStart(decimals, '0').replace(/0+$/, '')
  return `${amount / scale}${fraction ? `.${fraction}` : ''}`
}

async function walletBalance(endpoint, label, wallet, usdcAta, usdyAta) {
  const [native, usdc, usdy] = await Promise.all([
    rpc(endpoint, 'getBalance', [wallet, { commitment: 'confirmed' }]),
    tokenBalance(endpoint, usdcAta, TOKENS['svm-usdc']),
    tokenBalance(endpoint, usdyAta, TOKENS['svm-usdy']),
  ])
  const lamports = BigInt(native.value)
  return {
    label, address: wallet,
    nativeSol: { lamports: String(lamports), sol: formatBaseUnits(lamports, 9) },
    tokens: { USDC: usdc, USDY: usdy },
  }
}

export async function exportLoopForkReport({ env = process.env, output = DEFAULT_OUTPUT, now = new Date() } = {}) {
  const endpoint = loopbackRpc(env.LOCAL_FORK_RPC || env.SOLANA_RPC || DEFAULT_RPC)
  if (await rpc(endpoint, 'getHealth') !== 'ok') throw new Error('Local Surfpool RPC is not healthy.')
  const count = Number(requireEnv('LOCAL_FORK_TEST_WALLETS_COUNT'))
  if (!Number.isInteger(count) || count < 1 || count > 10) throw new Error('LOCAL_FORK_TEST_WALLETS_COUNT must be between 1 and 10.')
  const wallets = []
  for (let index = 0; index < count; index++) {
    const prefix = `LOCAL_FORK_ACCOUNT_${index}_`
    wallets.push(await walletBalance(endpoint,
      `account${index}`,
      requireEnv(`${prefix}ADDRESS`),
      requireEnv(`${prefix}USDC_ATA`),
      requireEnv(`${prefix}USDY_ATA`)))
  }
  const treasury = await walletBalance(endpoint,
    'feeTreasury',
    requireEnv('LOCAL_FORK_TREASURY_AUTHORITY'),
    requireEnv('LOCAL_FORK_FEE_ACCOUNT_USDC'),
    requireEnv('LOCAL_FORK_FEE_ACCOUNT_USDY'))
  const slot = await rpc(endpoint, 'getSlot', [{ commitment: 'confirmed' }])
  const report = {
    schemaVersion: 1,
    generatedAt: now.toISOString(),
    network: {
      label: 'Local Surfpool fork of Solana mainnet',
      rpc: endpoint.href.replace(/\/$/, ''),
      slot,
      disclaimer: 'Balances and transactions are local fork state. They have no Mainnet value.',
    },
    assets: {
      USDC: { mint: TOKENS['svm-usdc'].mint, decimals: TOKENS['svm-usdc'].decimals, role: 'borrowed liability asset' },
      USDY: { mint: TOKENS['svm-usdy'].mint, decimals: TOKENS['svm-usdy'].decimals, role: 'supplied collateral asset' },
    },
    setupAmountsPerWallet: {
      USDC: { baseUnits: env.LOCAL_FORK_STARTING_USDC_BASE_UNITS ?? null, uiAmount: env.LOCAL_FORK_STARTING_USDC_BASE_UNITS ? formatBaseUnits(env.LOCAL_FORK_STARTING_USDC_BASE_UNITS, TOKENS['svm-usdc'].decimals) : null },
      USDY: { baseUnits: env.LOCAL_FORK_STARTING_USDY_BASE_UNITS ?? null, uiAmount: env.LOCAL_FORK_STARTING_USDY_BASE_UNITS ? formatBaseUnits(env.LOCAL_FORK_STARTING_USDY_BASE_UNITS, TOKENS['svm-usdy'].decimals) : null },
    },
    wallets,
    feeTreasury: {
      ...treasury,
      feePolicy: { basisPoints: 10, percent: '0.10%', basis: 'router swap output amount', accruedPerSwap: true },
    },
    loop: {
      marketId: 'sol-usdy-usdc',
      targetLeverageInMostRecentPastedRun: 1.4,
      collateral: 'USDY',
      debt: 'USDC',
      open: [
        'Use USDY from the wallet as the opening collateral funding amount.',
        'Build one fee-bearing USDC-to-USDY route for the borrowed leverage amount, then compose it with one atomic Kamino Multiply pass: flash borrow, deposit collateral, borrow debt, and flash repay.',
        'The USDY-funded open does not include a separate initial USDC-to-USDY acquisition swap; the target leverage is not a repeated loop count.',
        'If any instruction fails, Solana rolls back the full transaction, including token and fee-account changes.',
      ],
      historicalRunNote: 'The pasted transaction signatures and balances below are historical local-fork evidence; confirm their inputs before treating them as proof of the current USDY-funded open path.',
      close: [
        'Build a fresh full-close quote from the current position.',
        'Compose Kamino flash liquidity, collateral withdrawal, router USDY-to-USDC sale, debt repayment, and flash repay in one atomic transaction.',
        'Route fees accrue to the treasury in the output mint; a successful full close leaves zero debt and zero collateral.',
      ],
      lastSuccessfulRunFromPastedLog: {
        slot: 466072350,
        openSignature: '6rbNBkk4jqCqpfrdi1vu19k1JyciHGYV2GUAZ1z2FdRsTVYkcSch34crdq2gNTx1wv2FCbTBLLQbLHD569Uktvr',
        closeSignature: '2rzDyfTngsuiJPSnt2zoCagq6hUEY36Wa19zrRGCZN81tYv87wJMWVyaCk37A223htNdc4DPyanRoC9a2DDiqy5v',
        finalDebt: '0',
        finalCollateral: '0',
        observedOpenFeeBaseUnits: { USDC: '0', USDY: '1207638' },
        observedCloseFeeBaseUnits: { USDC: '399571', USDY: '0' },
      },
    },
    verifierNotes: {
      expectedForcedFailures: 'The verifier appends an instruction that deliberately fails with custom error 0xc, then checks that balances and obligation state rolled back.',
      latestPastedRun: 'Standalone router, vanilla supply/withdraw, atomic open/close, fee deltas, and forced-failure rollback all passed.',
      productionGate: 'The verifier still prints BLOCKED until exact deployed Jupiter/DEX program versions are matched to approved audit evidence. This is a production admission gate, not a failed local open/close transaction.',
    },
  }
  const outputPath = resolve(output)
  await mkdir(dirname(outputPath), { recursive: true })
  await writeFile(outputPath, `${JSON.stringify(report, null, 2)}\n`, { mode: 0o600 })
  return { outputPath, slot, walletCount: wallets.length }
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  try {
    const result = await exportLoopForkReport({ output: process.argv[2] || DEFAULT_OUTPUT })
    console.log(`Wrote local wallet/loop report for ${result.walletCount} wallets at slot ${result.slot}: ${result.outputPath}`)
  } catch (error) {
    console.error(`Report export failed: ${error.message}`)
    process.exitCode = 1
  }
}
