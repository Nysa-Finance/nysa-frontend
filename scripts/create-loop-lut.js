// One-off per loop: creates its address lookup table, then freezes it so nobody (its creator included) can change it.
// Without it a loop open is 1,432 bytes, over Solana's 1,232-byte limit. It holds the accounts every open and close of
// that loop uses whoever the wallet is (COMMON plus the loop's list below, read off its transactions on a mainnet
// fork); wallet accounts and the swap's tick arrays stay out. Put the printed address in the loop's `lookupTable`
// (LOOPS in shared/config.js).
// Run: node scripts/create-loop-lut.js --loop=<id> --rpc=<url> --keypair=<funded keypair JSON> [--table=<address>] [--dry-run]
// The keypair pays the rent (about 0.007 SOL, kept by the frozen table) and fees; it holds no other power afterwards.
import { readFile } from 'node:fs/promises'
import {
  address,
  appendTransactionMessageInstructions,
  createKeyPairSignerFromBytes,
  createSolanaRpc,
  createTransactionMessage,
  getBase64EncodedWireTransaction,
  pipe,
  setTransactionMessageFeePayerSigner,
  setTransactionMessageLifetimeUsingBlockhash,
  signTransactionMessageWithSigners,
  getSignatureFromTransaction,
} from '@solana/kit'
import {
  fetchAddressLookupTable,
  getCreateLookupTableInstructionAsync,
  getExtendLookupTableInstruction,
  getFreezeLookupTableInstruction,
} from '@solana-program/address-lookup-table'

const COMMON = [
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
]
const LOOP_ACCOUNTS = {
  usdy: [
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
  ],
  susdai: [
    'TokenzQdBNbLqP5VEhdkAS6EPFLC1PHnBqCXEpPxuEb', // Token-2022 (sUSDai)
    // Mints
    'sUSDai6Y3GxysDEtA9BVcEFTaog6UZpYUVxJiMhAKYE', // sUSDai
    'EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v', // USDC
    '5tYfJfRYD99o3rqDECVVswtLHrKxGrHG7suxfzEncaM1', // sUSDai reserve collateral mint
    // sUSDai Market (Kamino)
    'BVJ1FvFfYuLbGX4qDNezqU6z2N3p8M2XNeGzabm86BzE', // lending market
    '2u9FunCYFdKFgUshkqvZoSi2mHftVxHswx92H4vZvq6y', // lending market authority
    '5vq24eGz45YWt4x8ub4eiJHU952UgFKpCTyW7rLb8wF2', // sUSDai reserve
    'EfMKdLdPKooewofAcGSNTw9FNjc98oDMjbRMHXLJ6QqS', // USDC reserve
    'ARQ9taJ9vEic3MfSY1ekrjJnMsraZhTcGRZBryWQPhQh', // reserve vaults (owned by the market authority)
    'J4zngPC1xFFAhGj4kQvg9Rq3i9tVYog6tHXBBgJK6VB7',
    'E29i3ZRLj8CY3fjiLBU3X4B7XywihmbyryWT345cgKD6',
    '8TFrBL2w7SRazVBeRqtR6DPLhySb8dAs3Gz2UkfKxFci',
    '2MK3tFa9jAYAjV8JmzDaTsTqBnPK2UciskHmkLjCD6SK',
    '4WCS2RFCm82DhANCy8ZVmFZhK7eBon25Qh7Bf3varN9M', // reserve farms (sUSDai collateral, USDC debt)
    'BszhW8Wq2vWNh3TwSFSFh2MPz5rmEmsimZxhvCC374cZ',
    '3t4JZcueEzTbVP6kLxXrL3VpWx45jDer4eqysweBchNH', // Scope price feed
    // sUSDai/USDC Whirlpool, its vaults and oracle
    '2JwiWq6zeBgooqKvLZSafEgB8QYuAEsfHxp253i6oJ8n',
    '77EVo67J3Yhi2t2sruWwNYRU5cKFEZKoRh5egJajSGh2',
    'FEATZxwUnGd9AoGppvy1zhbQrdDCuPLHBEjxAYML4mGU',
    'DqD6rsPDYxXzr9dwFLAWXdvpUG6umesV56V1Hd77eNhP',
  ],
  otfy: [
    // Mints
    'BwB3tNH92jKw6naNGDYDbDwRo8bvYxZVvZjRZRcoWR2h', // oTFY
    'EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v', // USDC
    '43VUsCTABo7CzcDBC4FCujQWS4XwQVYj6E9hvmZ9ACEg', // oTFY reserve collateral mint
    // Obligate Market (Kamino)
    '3hd61ZpG35tBwrmDvdmYVJoazC2mjJxHb6rEYEWs4QhH', // lending market
    'DAAE4bDMzRJXf7KSzBmjLBWUKit3mESH9tzGQE6MrRjU', // lending market authority
    '6nk5K3PiV3EHtW4LLFhfMc1uR4kNwEfibvTdWqxCm6WF', // oTFY reserve
    'Au2Cg9CNNTX1KfzVhNnpi1ouHX74CwMMBvmSchmqS5ZW', // USDC reserve
    '6iBvALkb94jdbHgqasSiKdyCUMxepuA9tQQCWsi8MsML', // reserve vaults (owned by the market authority)
    'WRrDXR73TiK1Byqu11bwwY4iGdJvbMhduFCm7KwHHg1',
    '6Q5FXg624rCBeDWigfkJmdzXiE4eLKdzzakJpSvLp6m',
    '2YyxBZunhK7ADkcMSHK3BKZVtmKVhP1bKW3t8CybvEpm',
    '6MmV3UfZ8s5Gjtft9w4qqLBBkm3eorkMDJGJ6eS5R4Aq',
    '3t4JZcueEzTbVP6kLxXrL3VpWx45jDer4eqysweBchNH', // Scope price feed
    // oTFY/USDC Raydium CLMM pool, its config, vaults, observation and tick-array bitmap
    'CAMMCzo5YL8w4VFF8KVHrK22GGUsp5VTaW7grrKgrWqK',
    '7GzGBjKG8Y326tpiNQ83CA5oePy8qZqfXgz2dLBn7qyq',
    '9iFER3bpjf1PTTCQCfTRu17EJgvsxo9pVyA9QWwEuX4x',
    '7NK3g4UtCEM6Ee2BAumQVNagMeqagY2o7abjTk3pHBu1',
    'Ad8LmqZiyPqknQA4uCQNd16wX66i9h8UvsURinESH1TE',
    '8TxKaAwLWYpKNWwr8FC6nCUqq69MJQXVFW1tjmtpHUz',
    '81eWxPoEon52YTpiCSCcZsFx5LkWo3dKdY1iZEw2WMvP',
  ],
}

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
  await rpc
    .sendTransaction(getBase64EncodedWireTransaction(tx), { encoding: 'base64', preflightCommitment: 'confirmed' })
    .send()
  for (let i = 0; i < 60; i++) {
    const {
      value: [status],
    } = await rpc.getSignatureStatuses([signature]).send()
    if (status?.err) throw new Error(`Transaction ${signature} failed: ${JSON.stringify(status.err)}`)
    if (status?.confirmationStatus === 'confirmed' || status?.confirmationStatus === 'finalized') return signature
    await new Promise((resolve) => setTimeout(resolve, 1000))
  }
  throw new Error(`Transaction ${signature} was not confirmed in 60s`)
}

async function main() {
  const args = Object.fromEntries(
    process.argv
      .slice(2)
      .map((a) => a.replace(/^--/, '').split('='))
      .map(([k, ...v]) => [k, v.join('=') || true]),
  )
  if (!LOOP_ACCOUNTS[args.loop]) throw new Error(`Use --loop=<${Object.keys(LOOP_ACCOUNTS).join('|')}>.`)
  const LOOP_LUT_ADDRESSES = [...COMMON, ...LOOP_ACCOUNTS[args.loop]]
  if (args['dry-run']) {
    console.log(LOOP_LUT_ADDRESSES.join('\n'))
    return
  }
  if (!args.rpc || !args.keypair) throw new Error('Use --rpc=<url> --keypair=<funded keypair JSON> (or --dry-run).')
  const rpc = createSolanaRpc(args.rpc)
  const signer = await createKeyPairSignerFromBytes(Uint8Array.from(JSON.parse(await readFile(args.keypair, 'utf8'))))
  // --table=<address> resumes a table this keypair created whose extend or freeze failed (e.g. out of SOL for its
  // rent): only the missing addresses are added.
  let table,
    present = []
  if (args.table) {
    table = address(args.table)
    const { data } = await fetchAddressLookupTable(rpc, table, { commitment: 'confirmed' })
    if (data.authority?.__option !== 'Some' || String(data.authority.value) !== String(signer.address)) {
      throw new Error(`Table ${table} is frozen or not owned by this keypair; create a new one instead.`)
    }
    present = data.addresses.map(String)
    console.log(`resume ${table}: ${present.length} of ${LOOP_LUT_ADDRESSES.length} addresses already in it`)
  } else {
    const recentSlot = await rpc.getSlot({ commitment: 'finalized' }).send()
    const create = await getCreateLookupTableInstructionAsync({ authority: signer, payer: signer, recentSlot })
    table = create.accounts[0].address
    console.log(`create ${table}: ${await send(rpc, signer, [create])}`)
  }
  const missing = LOOP_LUT_ADDRESSES.filter((a) => !present.includes(a))
  for (let i = 0; i < missing.length; i += 20) {
    const extend = getExtendLookupTableInstruction({
      address: table,
      authority: signer,
      payer: signer,
      addresses: missing.slice(i, i + 20).map(address),
    })
    console.log(`extend: ${await send(rpc, signer, [extend])}`)
  }
  console.log(
    `freeze: ${await send(rpc, signer, [getFreezeLookupTableInstruction({ address: table, authority: signer })])}`,
  )
  const { data } = await fetchAddressLookupTable(rpc, table, { commitment: 'confirmed' })
  const frozen = data.authority?.__option === 'None'
  const complete = LOOP_LUT_ADDRESSES.every((a) => data.addresses.includes(a))
  if (!frozen || !complete)
    throw new Error(`Table ${table} is not as expected (frozen ${frozen}, complete ${complete}).`)
  console.log(`lookupTable: '${table}' (${data.addresses.length} addresses, frozen)`)
}

main().catch((error) => {
  console.error(error.message)
  process.exit(1)
})
