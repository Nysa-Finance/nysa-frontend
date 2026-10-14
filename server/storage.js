// Server state on disk (DATA_DIR, a Docker volume on the VPS): Farm Points CSV, APY history, market index,
// sanctions list, unique-wallet counts.
// Writes are atomic (temp file + rename), so readers never see a half-written file.
import { mkdir, readFile, rename, writeFile } from 'node:fs/promises'
import { dirname, join } from 'node:path'

const DIR = process.env.DATA_DIR || 'data'
export const POINTS = 'farm-points/points_state.csv'
export const HISTORY = 'market-history/history.json'
export const INDEX = 'market-history/index-v3.json' // v3: + liquidations and obligation owners (full re-index)
export const SANCTIONS = 'sanctions/ofac-addresses.json'
export const WALLETS = 'wallet-stats/wallets.json' // hashed connected wallets per day (server/wallets.js)
export const WALLETS_KEY = 'wallet-stats/hash-key' // secret key of those hashes: never copy it next to the data

// Text content, or null if the file does not exist yet.
export async function read(path) {
  try { return await readFile(join(DIR, path), 'utf8') } catch (e) { if (e.code === 'ENOENT') return null; throw e }
}

export async function write(path, body) {
  const file = join(DIR, path)
  await mkdir(dirname(file), { recursive: true })
  await writeFile(`${file}.tmp`, body)
  await rename(`${file}.tmp`, file)
}
