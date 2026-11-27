// Where transactions may execute: production (mainnet, behind the release gates) or the local Surfpool fork, where only
// generated wallets and routes through programs cloned into the fork are allowed.
import { RPC_URL, rpc } from './rpc.js'
import { SwapRouteError } from './swap-routes.js'
import { validateProviderSwapInstructions } from './swap-execution.js'
import {
  createLocalForkRouteVerifier,
  isLocalForkWallet,
  localForkExecutionEnabled,
  localForkTreasuryAuthority,
} from './local-fork-execution.js'

export const localForkDappEnabled = localForkExecutionEnabled({ rpcUrl: RPC_URL })
export const verifyLocalForkRoute = createLocalForkRouteVerifier({ rpc, enabled: localForkDappEnabled })
export const executionMode = localForkDappEnabled ? 'surfpool-local' : 'production-gated'
export const isLocalWallet = (wallet) => isLocalForkWallet(wallet, { rpcUrl: RPC_URL })

export async function validateSwapRouteForCurrentNetwork(request, built) {
  if (!localForkDappEnabled) return validateProviderSwapInstructions(request, built)
  if (!(await verifyLocalForkRoute(built)))
    throw new SwapRouteError(
      'The local route does not use only the approved DEX and executable programs cloned into Surfpool.',
    )
  return validateProviderSwapInstructions(request, { ...built, programPolicy: { approved: true, unreviewed: [] } })
}

export function localForkProgramEvidenceReady() {
  return (
    localForkDappEnabled &&
    !!localForkTreasuryAuthority() &&
    !!process.env.LOCAL_FORK_FEE_ACCOUNT_USDC &&
    !!process.env.LOCAL_FORK_FEE_ACCOUNT_USDY
  )
}

export async function localIntentAuthorized(intent) {
  if (!localForkProgramEvidenceReady() || !isLocalWallet(intent?.wallet)) return false
  const metadata = intent?.metadata ?? {}
  const routeProgramIds = metadata.routeProgramIds ?? Object.values(metadata.routeProgramIdsByLabel ?? {}).flat()
  return verifyLocalForkRoute({ programIds: metadata.programIds, routeProgramIds })
}
