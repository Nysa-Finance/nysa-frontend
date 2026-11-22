// One-off: creates Nysa's loop address lookup table, then freezes it so nobody (its creator included) can change it.
// Without it a loop open is 1,432 bytes, over Solana's 1,232-byte limit. It holds the accounts every loop open and
// close uses whoever the wallet is (the list below, read off the transactions on a mainnet fork); wallet accounts and
// the swap's tick arrays stay out. Put the printed address in src/config.js (LOOP_LOOKUP_TABLE).
// Run: node scripts/create-loop-lut.js --rpc=<url> --keypair=<funded keypair JSON> [--dry-run]
// The keypair pays the rent (about 0.007 SOL, kept by the frozen table) and fees; it holds no other power afterwards.
import { readFile } from 'node:fs/promises'
import {
  address, appendTransactionMessageInstructions, createKeyPairSignerFromBytes, createSolanaRpc, createTransactionMessage,
  getBase64EncodedWireTransaction, pipe, setTransactionMessageFeePayerSigner, setTransactionMessageLifetimeUsingBlockhash,
  signTransactionMessageWithSigners, getSignatureFromTransaction,
} from '@solana/kit'
import {
  fetchAddressLookupTable, getCreateLookupTableInstructionAsync, getExtendLookupTableInstruction, getFreezeLookupTableInstruction,
} from '@solana-program/address-lookup-table'

const LOOP_LUT_ADDRESSES = [
  // Programs and sysvars
  'KLend2g3cP87fffoy8q1mQqGKjrxjC8boSyAYavgmjD', // Kamino Lend
  'FarmsPZpWu9i7Kky8tPN37rs2TpmMrAZrC7S7vJa91Hr', // Kamino Farms
  'JUP6LkbZbjS1jKKwapdHNy74zcZ3tLUZoi5QNyVTaV4', // Jupiter v6
  'D8cy77BBepLMngZx6ZukaTff5hCt1HrWyKk3Hnd9oitf', // Jupiter event authority
  'whirLbMiicVdio4qvUfM5KAg6Ct8VwpYzGff3uctyCc', // Orca Whirlpool
  'TokenkegQfeZyiNwAJbNbGKPFXCWuBvf9Ss623VQ5DA', // SPL Token
  'ATokenGPvbdGVxr1b2hvZbsiqW5xWH25efTNsLJA8knL', // Associated Token
  'MemoSq4gqABAXKb96qnH8TysNcWxMyWCqXgDLGmfcHr', // Memo
  '11111111111111111111111111111111', // System
  'Sysvar1nstructions1111111111111111111111111',
  'SysvarRent111111111111111111111111111111111',
  // Mints
  'A1KLoBrKBde8Ty9qtNQUtq3C2ortoC3u7twggz7sEto6', // USDY
  'EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v', // USDC
  'C7dKsFYaM2DcVJSDjouPTfLc9292Lkd5ti9VQCdx2UDg', // USDY reserve collateral mint
  // USDY Ondo Market (Kamino)
  'F4uLsGZT4YnHDcemtoYDz2LBZKLmwTB1wzkwS6oqygvy', // lending market
  'E1AHokuxNSR123SD4kQGsKvAFLFFcBhdbptf2EsubToH', // lending market authority
  'rpTGWR3JDjjPfXLCg5Fx1GpSdUxPt1pxW7fwXGUT6js', // USDY reserve
  'GQr5hXuRgHAmguh6EqcpeJXrMyqCQch4P6XkSvawwNk2', // USDC reserve
  'AVxf9dXFj5M7xCM7SU6cRM2FnUtZyeWcqHSJVt5Fbdsk', // reserve vaults (owned by the market authority)
  'RAZFwzfLEZMzG9toay62VPH5WdUgq8GUhJEdjqzb2yS',
  'AdF4ybj8neZkqoiyxFLkkieRHMboJkDqc1BZGG6SDPhx',
  '68YwkFhagT33k8485VtX1MhMYpab97c1MjpWcXFuTYea',
  'HS5RA3CPZsUvgsKTsgn17tUqKMXiQcCCXK6tiJGfaj1G',
  '3t4JZcueEzTbVP6kLxXrL3VpWx45jDer4eqysweBchNH', // Scope price feeds
  '3NJYftD5sjVfxSnUdZ1wVML8f3aC6mp1CXCL6L7TnU8C',
  // USDC/USDY Whirlpool and its vaults
  'AGXrswVDRoUf62UX9voTXv6TCGw6fBUEwDpyUd9YdZfD',
  '7jLEfNKea3UUrRUbxVMjZQc8vLohAUaZ7vo3akpnWW8V',
  '2vKEGgEzrDa3zGAdszdwmpygEYSTJvYVhPpp6WBY55eS',
]

async function send(rpc, signer, instructions) {
  const { value: blockhash } = await rpc.getLatestBlockhash({ commitment: 'confirmed' }).send()
  const tx = await pipe(
    createTransactionMessage({ version: 0 }),
    (m) => setTransactionMessageFeePayerSigner(signer, m),
    (m) => setTransactionMessageLifetimeUsingBlockhash(blockhash, m),
    (m) => appendTransactionMessageInstructions(instructions, m),
    signTransactionMessageWithSigners,
  )
  const signature = getSignatureFromTransaction(tx)
  await rpc.sendTransaction(getBase64EncodedWireTransaction(tx), { encoding: 'base64', preflightCommitment: 'confirmed' }).send()
  for (let i = 0; i < 60; i++) {
    const { value: [status] } = await rpc.getSignatureStatuses([signature]).send()
    if (status?.err) throw new Error(`Transaction ${signature} failed: ${JSON.stringify(status.err)}`)
    if (status?.confirmationStatus === 'confirmed' || status?.confirmationStatus === 'finalized') return signature
    await new Promise((resolve) => setTimeout(resolve, 1000))
  }
  throw new Error(`Transaction ${signature} was not confirmed in 60s`)
}

async function main() {
  const args = Object.fromEntries(process.argv.slice(2).map((a) => a.replace(/^--/, '').split('=')).map(([k, ...v]) => [k, v.join('=') || true]))
  if (args['dry-run']) { console.log(LOOP_LUT_ADDRESSES.join('\n')); return }
  if (!args.rpc || !args.keypair) throw new Error('Use --rpc=<url> --keypair=<funded keypair JSON> (or --dry-run).')
  const rpc = createSolanaRpc(args.rpc)
  const signer = await createKeyPairSignerFromBytes(Uint8Array.from(JSON.parse(await readFile(args.keypair, 'utf8'))))
  const recentSlot = await rpc.getSlot({ commitment: 'finalized' }).send()
  const create = await getCreateLookupTableInstructionAsync({ authority: signer, payer: signer, recentSlot })
  const table = create.accounts[0].address
  console.log(`create ${table}: ${await send(rpc, signer, [create])}`)
  for (let i = 0; i < LOOP_LUT_ADDRESSES.length; i += 20) {
    const extend = getExtendLookupTableInstruction({ address: table, authority: signer, payer: signer,
      addresses: LOOP_LUT_ADDRESSES.slice(i, i + 20).map(address) })
    console.log(`extend: ${await send(rpc, signer, [extend])}`)
  }
  console.log(`freeze: ${await send(rpc, signer, [getFreezeLookupTableInstruction({ address: table, authority: signer })])}`)
  const { data } = await fetchAddressLookupTable(rpc, table, { commitment: 'confirmed' })
  const frozen = data.authority?.__option === 'None'
  const complete = LOOP_LUT_ADDRESSES.every((a) => data.addresses.includes(a))
  if (!frozen || !complete) throw new Error(`Table ${table} is not as expected (frozen ${frozen}, complete ${complete}).`)
  console.log(`LOOP_LOOKUP_TABLE=${table} (${data.addresses.length} addresses, frozen)`)
}

main().catch((error) => { console.error(error.message); process.exit(1) })
