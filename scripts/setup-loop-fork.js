import { generateKeyPairSync } from 'node:crypto'
import { execFileSync } from 'node:child_process'
import { chmod, readFile, rename, writeFile } from 'node:fs/promises'
import { pathToFileURL } from 'node:url'
import { address, createKeyPairSignerFromBytes, getAddressEncoder } from '@solana/kit'
import { TOKENS } from '../src/config.js'
import { ataOf } from '../server/account.js'

const DEFAULT_RPC = 'http://127.0.0.1:8899'
const TOKEN_PROGRAM = 'TokenkegQfeZyiNwAJbNbGKPFXCWuBvf9Ss623VQ5DA'
const SYSTEM_PROGRAM = '11111111111111111111111111111111'
const SOL_LAMPORTS = 1_000_000_000
const TOKEN_DECIMALS = 6
const MANAGED_START = '# BEGIN NYSA LOCAL FORK TEST ACCOUNTS (generated; local-only)'
const MANAGED_END = '# END NYSA LOCAL FORK TEST ACCOUNTS'

function parseOptions(argv) {
  const options = { rpc: DEFAULT_RPC, wallets: 10, usdc: '1000', usdy: '1000', sol: '10' }
  for (const arg of argv) {
    const match = arg.match(/^--(rpc|wallets|usdc|usdy|sol)=(.*)$/)
    if (!match) throw new Error(`Unknown argument: ${arg}. Use --rpc=, --wallets=, --usdc=, --usdy=, or --sol=.`)
    options[match[1]] = match[2]
  }
  const count = Number(options.wallets)
  if (!Number.isInteger(count) || count < 1 || count > 10) throw new Error('--wallets must be an integer from 1 to 10.')
  options.wallets = count
  for (const name of ['usdc', 'usdy']) options[`${name}BaseUnits`] = parseTokenAmount(options[name], name.toUpperCase())
  options.solLamports = parseSolAmount(options.sol)
  return options
}

function parseTokenAmount(value, label) {
  if (typeof value !== 'string' || !/^\d+(?:\.\d{1,6})?$/.test(value)) {
    throw new Error(`${label} balance must be a non-negative decimal with at most six decimal places.`)
  }
  const [whole, fraction = ''] = value.split('.')
  const baseUnits = BigInt(whole) * 10n ** BigInt(TOKEN_DECIMALS) + BigInt(fraction.padEnd(TOKEN_DECIMALS, '0') || '0')
  if (baseUnits > BigInt(Number.MAX_SAFE_INTEGER)) throw new Error(`${label} balance is too large for Surfpool's token cheatcode.`)
  return Number(baseUnits)
}

function parseSolAmount(value) {
  if (typeof value !== 'string' || !/^\d+(?:\.\d{1,9})?$/.test(value)) throw new Error('SOL balance must be a non-negative decimal with at most nine decimal places.')
  const [whole, fraction = ''] = value.split('.')
  const lamports = BigInt(whole) * BigInt(SOL_LAMPORTS) + BigInt(fraction.padEnd(9, '0') || '0')
  if (lamports > BigInt(Number.MAX_SAFE_INTEGER)) throw new Error('SOL balance is too large for Surfpool account setup.')
  return Number(lamports)
}

function loopbackEndpoint(value) {
  let endpoint
  try { endpoint = new URL(value) } catch { throw new Error('--rpc must be a valid loopback HTTP URL.') }
  if (endpoint.protocol !== 'http:' || !['localhost', '127.0.0.1', '[::1]'].includes(endpoint.hostname.toLowerCase())
    || endpoint.username || endpoint.password) {
    throw new Error('Refusing to send setup requests anywhere except a loopback Surfpool HTTP RPC.')
  }
  return endpoint
}

async function rpc(fetcher, endpoint, method, params = []) {
  const response = await fetcher(endpoint, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ jsonrpc: '2.0', id: 1, method, params }),
    signal: AbortSignal.timeout(10_000),
  })
  if (!response.ok) throw new Error(`Local Surfpool RPC returned HTTP ${response.status}.`)
  const body = await response.json()
  if (body?.error) throw new Error(`Local Surfpool ${method} failed: ${body.error.message ?? 'RPC error'}`)
  return body?.result
}

function generateSolanaKeypair() {
  const { privateKey, publicKey } = generateKeyPairSync('ed25519')
  const privateDer = privateKey.export({ format: 'der', type: 'pkcs8' })
  const publicDer = publicKey.export({ format: 'der', type: 'spki' })
  const secretKey = Uint8Array.from([...privateDer.subarray(-32), ...publicDer.subarray(-32)])
  return createKeyPairSignerFromBytes(secretKey).then((signer) => ({ signer, secretKey: Array.from(secretKey) }))
}

function assertIgnoredEnvFile() {
  try { execFileSync('git', ['check-ignore', '-q', '.env'], { stdio: 'ignore' }) }
  catch { throw new Error('.env is not ignored by Git. Add it to .gitignore before generating local private keys.') }
}

async function confirmMainnetMints(fetcher, endpoint) {
  const mintRecords = Object.values(TOKENS)
  for (const token of mintRecords) {
    const response = await rpc(fetcher, endpoint, 'getAccountInfo', [token.mint, { encoding: 'base64', commitment: 'confirmed' }])
    const account = response?.value
    if (!account || account.owner !== TOKEN_PROGRAM || !Array.isArray(account.data) || account.data[1] !== 'base64') {
      throw new Error(`Surfpool could not load the configured Mainnet ${token.name} mint. Is the local fork connected to Mainnet?`)
    }
    const bytes = Buffer.from(account.data[0], 'base64')
    if (bytes.length !== 82 || bytes[44] !== token.decimals || bytes[45] !== 1) {
      throw new Error(`The configured ${token.name} mint account has an unexpected classic SPL mint layout or decimals.`)
    }
  }
}

async function createLocalWallet(fetcher, endpoint, index, solLamports) {
  const { signer, secretKey } = await generateSolanaKeypair()
  const wallet = String(signer.address)
  await rpc(fetcher, endpoint, 'surfnet_setAccount', [wallet, {
    // Surfpool's running RPC expects raw hex here; an empty system account uses the empty string (not "0x").
    data: '', executable: false, lamports: solLamports, owner: SYSTEM_PROGRAM, rentEpoch: 0,
  }])
  return { signer, secretKey, wallet, index }
}

async function setTokenBalance(fetcher, endpoint, owner, mint, amount) {
  await rpc(fetcher, endpoint, 'surfnet_setTokenAccount', [owner, mint, {
    // Omit optional authorities: some Surfpool versions parse "noAccount" as a pubkey instead of its sentinel value.
    amount, state: 'initialized',
  }, TOKEN_PROGRAM])
  const tokenAccount = String(await ataOf(address(owner), address(mint), address(TOKEN_PROGRAM)))
  const result = await rpc(fetcher, endpoint, 'getAccountInfo', [tokenAccount, { encoding: 'base64', commitment: 'confirmed' }])
  const account = result?.value
  if (!account || account.owner !== TOKEN_PROGRAM || !Array.isArray(account.data) || account.data[1] !== 'base64') {
    throw new Error(`Surfpool did not create the expected token account ${tokenAccount}.`)
  }
  const data = Buffer.from(account.data[0], 'base64')
  const expectedMint = Buffer.from(getAddressEncoder().encode(address(mint)))
  const expectedOwner = Buffer.from(getAddressEncoder().encode(address(owner)))
  if (data.length < 165 || !data.subarray(0, 32).equals(expectedMint) || !data.subarray(32, 64).equals(expectedOwner)
    || data.readBigUInt64LE(64) !== BigInt(amount) || data.readUInt8(108) !== 1) {
    throw new Error(`Surfpool returned an invalid token account for ${owner} / ${mint}.`)
  }
  return tokenAccount
}

function envValue(value) {
  return JSON.stringify(String(value))
}

function generatedEnvBlock({ rpcUrl, wallets, treasury, usdcAta, usdyAta, usdcBaseUnits, usdyBaseUnits }) {
  const lines = [
    MANAGED_START,
    '# Generated by npm run setup:loop-fork. Balances exist only in the local Surfpool process.',
    `SOLANA_RPC=${rpcUrl}`,
    `LOCAL_FORK_RPC=${rpcUrl}`,
    'LOCAL_FORK_DAPP_EXECUTION=1',
    `SWAP_FEE_ACCOUNT_USDC=${usdcAta}`,
    `SWAP_FEE_ACCOUNT_USDY=${usdyAta}`,
    `SWAP_FEE_TREASURY_AUTHORITY=${treasury.wallet}`,
    `LOCAL_FORK_TREASURY_AUTHORITY=${treasury.wallet}`,
    `LOCAL_FORK_TREASURY_SECRET_KEY=${envValue(JSON.stringify(treasury.secretKey))}`,
    `LOCAL_FORK_FEE_ACCOUNT_USDC=${usdcAta}`,
    `LOCAL_FORK_FEE_ACCOUNT_USDY=${usdyAta}`,
    `LOCAL_FORK_STARTING_USDC_BASE_UNITS=${usdcBaseUnits}`,
    `LOCAL_FORK_STARTING_USDY_BASE_UNITS=${usdyBaseUnits}`,
    `LOCAL_FORK_TEST_WALLETS_COUNT=${wallets.length}`,
  ]
  for (const { secretKey, wallet, index, usdcAta: accountUsdcAta, usdyAta: accountUsdyAta } of wallets) {
    const n = String(index)
    lines.push(`LOCAL_FORK_ACCOUNT_${n}_ADDRESS=${wallet}`)
    lines.push(`LOCAL_FORK_ACCOUNT_${n}_SECRET_KEY=${envValue(JSON.stringify(secretKey))}`)
    lines.push(`LOCAL_FORK_ACCOUNT_${n}_USDC_ATA=${accountUsdcAta}`)
    lines.push(`LOCAL_FORK_ACCOUNT_${n}_USDY_ATA=${accountUsdyAta}`)
  }
  lines.push(`LOCAL_FORK_TEST_WALLET=${wallets[0].wallet}`)
  lines.push(`LOCAL_FORK_TEST_WALLET_SECRET_KEY=${envValue(JSON.stringify(wallets[0].secretKey))}`)
  lines.push(MANAGED_END)
  return lines.join('\n')
}

async function updateEnvFile(block) {
  assertIgnoredEnvFile()
  let current
  try { current = await readFile('.env', 'utf8') }
  catch (error) {
    if (error.code !== 'ENOENT') throw error
    current = await readFile('.env.example', 'utf8')
  }
  const generated = `${block}\n`
  const start = current.indexOf(MANAGED_START)
  const end = current.indexOf(MANAGED_END)
  let next
  if (start >= 0 && end >= start) {
    const endAfterMarker = end + MANAGED_END.length
    next = `${current.slice(0, start)}${generated}${current.slice(endAfterMarker).replace(/^\r?\n/, '')}`
  } else {
    next = `${current.replace(/\s*$/, '')}\n\n${generated}`
  }
  const tempPath = `.env.local-fork-${process.pid}.tmp`
  await writeFile(tempPath, next, { mode: 0o600, flag: 'wx' })
  await chmod(tempPath, 0o600)
  await rename(tempPath, '.env')
  await chmod('.env', 0o600)
}

export async function setupLoopFork({ argv = process.argv.slice(2), fetcher = fetch, log = console.log } = {}) {
  const options = parseOptions(argv)
  const endpoint = loopbackEndpoint(options.rpc)
  assertIgnoredEnvFile()
  const health = await rpc(fetcher, endpoint, 'getHealth')
  if (health !== 'ok') throw new Error('Local RPC is not healthy; start Surfpool first (default: surfpool start).')
  await confirmMainnetMints(fetcher, endpoint)

  const { signer: treasurySigner, secretKey: treasurySecretKey } = await generateSolanaKeypair()
  const treasuryWallet = String(treasurySigner.address)
  await rpc(fetcher, endpoint, 'surfnet_setAccount', [treasuryWallet, {
    data: '', executable: false, lamports: options.solLamports, owner: SYSTEM_PROGRAM, rentEpoch: 0,
  }])
  const treasury = { signer: treasurySigner, secretKey: treasurySecretKey, wallet: treasuryWallet, index: -1 }
  const walletRows = []
  for (let index = 0; index < options.wallets; index++) {
    const wallet = await createLocalWallet(fetcher, endpoint, index, options.solLamports)
    const usdcAta = await setTokenBalance(fetcher, endpoint, wallet.wallet, TOKENS['svm-usdc'].mint, options.usdcBaseUnits)
    const usdyAta = await setTokenBalance(fetcher, endpoint, wallet.wallet, TOKENS['svm-usdy'].mint, options.usdyBaseUnits)
    walletRows.push({ ...wallet, usdcAta, usdyAta })
  }
  const feeUsdcAta = await setTokenBalance(fetcher, endpoint, treasury.wallet, TOKENS['svm-usdc'].mint, 0)
  const feeUsdyAta = await setTokenBalance(fetcher, endpoint, treasury.wallet, TOKENS['svm-usdy'].mint, 0)
  const block = generatedEnvBlock({
    rpcUrl: endpoint.href.replace(/\/$/, ''), wallets: walletRows, treasury,
    usdcAta: feeUsdcAta, usdyAta: feeUsdyAta,
    usdcBaseUnits: options.usdcBaseUnits, usdyBaseUnits: options.usdyBaseUnits,
  })
  await updateEnvFile(block)

  log(`Prepared ${walletRows.length} local-only test wallets and 2 fee ATAs on the running Surfpool.`)
  log(`Local RPC: ${endpoint.href.replace(/\/$/, '')}`)
  for (const item of walletRows) log(`account${item.index}: ${item.wallet} | USDC ATA ${item.usdcAta} | USDY ATA ${item.usdyAta}`)
  log(`test treasury: ${treasury.wallet} | USDC fee ATA ${feeUsdcAta} | USDY fee ATA ${feeUsdyAta}`)
  log('Private keys were written only to the ignored .env file; they are not printed. These token balances are simulated and have no Mainnet value.')
  log('Next: restart the backend with npm run server, then run npm run verify:loop-fork. Vite can use API_TARGET=http://127.0.0.1:3000.')
  return { rpcUrl: endpoint.href, wallets: walletRows.map(({ wallet, usdcAta, usdyAta }) => ({ wallet, usdcAta, usdyAta })), treasury: treasury.wallet }
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  try {
    await setupLoopFork()
  } catch (error) {
    console.error(`Setup failed: ${error.message}`)
    process.exitCode = 1
  }
}
