import { pathToFileURL } from 'node:url'
import { address } from '@solana/kit'
import { TOKENS } from '../src/config.js'
import { inspectFeeTokenAccount } from '../server/swap.js'
import { PROGRAM_EVIDENCE } from '../server/program-policy.js'

const FORK_ADDRESSES = [
  'LOCAL_FORK_TEST_WALLET',
  'LOCAL_FORK_FEE_ACCOUNT_USDC',
  'LOCAL_FORK_FEE_ACCOUNT_USDY',
  'LOCAL_FORK_TREASURY_AUTHORITY',
]
const LOOPBACK_HOSTS = new Set(['localhost', '127.0.0.1', '[::1]'])

export function assertLoopbackForkEndpoint(value) {
  if (typeof value !== 'string' || !value.trim()) throw new Error('LOCAL_FORK_RPC is not set.')
  let endpoint
  try { endpoint = new URL(value) } catch { throw new Error('LOCAL_FORK_RPC must be a valid local HTTP URL.') }
  if (endpoint.protocol !== 'http:') throw new Error('LOCAL_FORK_RPC must use local HTTP; HTTPS endpoints are rejected.')
  if (!LOOPBACK_HOSTS.has(endpoint.hostname.toLowerCase())) throw new Error('LOCAL_FORK_RPC must use a local loopback host; public RPC endpoints are rejected.')
  if (endpoint.username || endpoint.password) throw new Error('LOCAL_FORK_RPC must not include credentials.')
  return endpoint
}

export function missingForkPrerequisites(env = {}) {
  return FORK_ADDRESSES.flatMap((name) => {
    const value = env[name]
    if (typeof value !== 'string' || !value.trim()) return [name]
    try { address(value) } catch { return [`${name} (invalid address)`] }
    return []
  })
}

async function localRpc(fetcher, endpoint, method, params = []) {
  const response = await fetcher(endpoint, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ jsonrpc: '2.0', id: 1, method, params }),
    signal: AbortSignal.timeout(5_000),
  })
  if (!response?.ok) throw new Error('Local validator RPC is unavailable.')
  const body = await response.json()
  if (body?.error) throw new Error(`Local validator RPC ${method} failed.`)
  return body?.result
}

function localTokenAccount(value, mint, authority, name) {
  const raw = value?.data
  if (!value || !Array.isArray(raw) || typeof raw[0] !== 'string' || raw[1] !== 'base64') {
    throw new Error(`${name} is missing or is not a base64 token account on the local validator.`)
  }
  const account = inspectFeeTokenAccount({
    exists: true,
    programAddress: value.owner,
    data: Uint8Array.from(Buffer.from(raw[0], 'base64')),
  })
  if (!account || account.mint !== mint || account.authority !== authority) {
    throw new Error(`${name} must be an initialized real token account for the expected mint and disposable test treasury.`)
  }
}

/** Read-only local fork preflight. This script never compiles, signs, simulates or submits transactions. */
export async function verifyLoopFork({ env = process.env, fetcher = fetch, log = console.log } = {}) {
  let endpoint
  try { endpoint = assertLoopbackForkEndpoint(env.LOCAL_FORK_RPC) } catch (error) {
    log(`BLOCKED: ${error.message} No RPC request was sent.`)
    return 1
  }
  const missing = missingForkPrerequisites(env)
  if (missing.length) {
    log(`BLOCKED: Configure real local test inputs: ${missing.join(', ')}. No RPC request was sent.`)
    return 1
  }

  try {
    const [health, version, slot] = await Promise.all([
      localRpc(fetcher, endpoint, 'getHealth'),
      localRpc(fetcher, endpoint, 'getVersion'),
      localRpc(fetcher, endpoint, 'getSlot', [{ commitment: 'confirmed' }]),
    ])
    if (health !== 'ok' || !version || !Number.isSafeInteger(slot)) throw new Error('Local validator health, version or slot is invalid.')
    const [usdcFee, usdyFee] = await Promise.all([
      localRpc(fetcher, endpoint, 'getAccountInfo', [env.LOCAL_FORK_FEE_ACCOUNT_USDC, { encoding: 'base64', commitment: 'confirmed' }]),
      localRpc(fetcher, endpoint, 'getAccountInfo', [env.LOCAL_FORK_FEE_ACCOUNT_USDY, { encoding: 'base64', commitment: 'confirmed' }]),
    ])
    localTokenAccount(usdcFee?.value, TOKENS['svm-usdc'].mint, env.LOCAL_FORK_TREASURY_AUTHORITY, 'LOCAL_FORK_FEE_ACCOUNT_USDC')
    localTokenAccount(usdyFee?.value, TOKENS['svm-usdy'].mint, env.LOCAL_FORK_TREASURY_AUTHORITY, 'LOCAL_FORK_FEE_ACCOUNT_USDY')
    log(`LOCAL PREFLIGHT OK: validator ${version['solana-core'] ?? 'unknown'} at slot ${slot}; both disposable treasury token accounts are valid.`)
  } catch (error) {
    log(`BLOCKED: ${error.message}`)
    return 1
  }

  if (!PROGRAM_EVIDENCE.length) {
    log('BLOCKED: No exact deployed router/DEX audit evidence is approved; route admission fails closed.')
    return 1
  }
  log('BLOCKED: Phase 1 has no actual Multiply open/full-close transaction builder or fee-balance simulation executor. No fixture-only success is accepted.')
  return 1
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  process.exitCode = await verifyLoopFork()
}
