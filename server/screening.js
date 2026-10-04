// Sanctions screening of connected wallets against the US Treasury's OFAC SDN list, which names sanctioned crypto
// addresses ("Digital Currency Address - SOL", "- USDC", "- ETH", …). Free and keyless; enforced here, server-side, so
// it can't be bypassed in the browser: a sanctioned wallet gets no account data and no transactions built or relayed.
// The list is downloaded once a day and kept in DATA_DIR, so a restart doesn't depend on the download.
// The XML export is used because the CSV truncates the remarks field and drops about half of the addresses.
import { read, write, SANCTIONS } from './storage.js'

const SDN_XML = 'https://sanctionslistservice.ofac.treas.gov/api/PublicationPreview/exports/SDN.XML'
const DAY_MS = 24 * 3_600_000
const RETRY_MS = 3_600_000
const MIN_ADDRESSES = 100 // a smaller list means a broken download: keep the previous one

let addresses = new Set()
let updatedAt = null

export const isSanctioned = (wallet) => addresses.has(wallet)
// false until a list is loaded: callers fail closed for transactions.
export const screeningReady = () => addresses.size > 0
export const screeningStatus = () => ({ source: 'OFAC SDN', addresses: addresses.size, updatedAt })

// Every "Digital Currency Address - <coin>" id in the SDN XML.
export function parseSdn(xml) {
  const out = new Set()
  for (const m of xml.matchAll(/<idType>Digital Currency Address - [A-Z0-9]+<\/idType>\s*<idNumber>([^<]+)<\/idNumber>/g)) out.add(m[1].trim())
  return out
}

export async function refreshSanctions() {
  const res = await fetch(SDN_XML, { signal: AbortSignal.timeout(120_000) })
  if (!res.ok) throw new Error(`OFAC responded ${res.status}`)
  const next = parseSdn(await res.text())
  if (next.size < MIN_ADDRESSES) throw new Error(`OFAC list has only ${next.size} addresses, keeping the previous one`)
  addresses = next
  updatedAt = Date.now()
  await write(SANCTIONS, JSON.stringify({ updatedAt, addresses: [...next] }))
  console.log(`[screening] OFAC list updated: ${next.size} sanctioned addresses`)
}

// On boot: the saved list right away, then a fresh download now and every day (hourly retries on failure).
export async function startScreening() {
  try {
    const saved = JSON.parse((await read(SANCTIONS)) ?? 'null')
    if (saved?.addresses?.length >= MIN_ADDRESSES) ({ updatedAt } = saved), (addresses = new Set(saved.addresses))
  } catch (e) { console.error('[screening] saved list unreadable', e.message) }
  const tick = () => refreshSanctions()
    .then(() => setTimeout(tick, DAY_MS).unref?.())
    .catch((e) => { console.error('[screening] OFAC download failed', e.message); setTimeout(tick, RETRY_MS).unref?.() })
  tick()
}
