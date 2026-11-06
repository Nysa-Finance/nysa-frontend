import { address } from '@solana/kit'
import { ROUTE_PROGRAM_IDS_BY_LABEL } from './program-policy.js'

const LOOPBACK_HOSTS = new Set(['localhost', '127.0.0.1', '[::1]'])
const ALLOWED_DEX_PROGRAMS = new Set(Object.values(ROUTE_PROGRAM_IDS_BY_LABEL).flat())

export function localForkExecutionEnabled({ env = process.env, rpcUrl = env.SOLANA_RPC } = {}) {
  if (env.LOCAL_FORK_DAPP_EXECUTION !== '1' || typeof rpcUrl !== 'string' || typeof env.LOCAL_FORK_RPC !== 'string') return false
  try {
    const rpc = new URL(rpcUrl)
    const fork = new URL(env.LOCAL_FORK_RPC)
    return rpc.protocol === 'http:' && fork.protocol === 'http:'
      && LOOPBACK_HOSTS.has(rpc.hostname.toLowerCase())
      && LOOPBACK_HOSTS.has(fork.hostname.toLowerCase())
      && rpc.origin === fork.origin
  } catch { return false }
}

export function isLocalForkWallet(wallet, { env = process.env, rpcUrl = env.SOLANA_RPC } = {}) {
  if (!localForkExecutionEnabled({ env, rpcUrl }) || typeof wallet !== 'string') return false
  const count = Number(env.LOCAL_FORK_TEST_WALLETS_COUNT)
  if (!Number.isSafeInteger(count) || count < 1 || count > 10) return false
  for (let index = 0; index < count; index++) {
    if (env[`LOCAL_FORK_ACCOUNT_${index}_ADDRESS`] === wallet) return true
  }
  return false
}

export function localForkFeeAccount(mint, { env = process.env } = {}) {
  const usdc = 'EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v'
  const usdy = 'A1KLoBrKBde8Ty9qtNQUtq3C2ortoC3u7twggz7sEto6'
  const account = mint === usdc ? env.LOCAL_FORK_FEE_ACCOUNT_USDC
    : mint === usdy ? env.LOCAL_FORK_FEE_ACCOUNT_USDY : null
  return account ? { account, mint } : null
}

export function localForkTreasuryAuthority({ env = process.env } = {}) {
  return env.LOCAL_FORK_TREASURY_AUTHORITY || null
}

export function createLocalForkRouteVerifier({ rpc, enabled = localForkExecutionEnabled() } = {}) {
  return async function verifyLocalForkRoute(built) {
    if (!enabled || !rpc || !built || !Array.isArray(built.routeProgramIds) || !built.routeProgramIds.length
      || built.routeProgramIds.some((programId) => !ALLOWED_DEX_PROGRAMS.has(String(programId)))
      || !Array.isArray(built.programIds) || !built.programIds.length) return false
    try {
      const results = await Promise.all(built.programIds.map((programId) =>
        rpc.getAccountInfo(address(String(programId)), { encoding: 'base64', commitment: 'confirmed' }).send()))
      return results.every((result) => result?.value?.executable === true)
    } catch { return false }
  }
}

