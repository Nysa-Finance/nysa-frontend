// One-off migration: copy the state from Vercel Blob into ./data-export (then into the VPS volume).
// Usage: BLOB_READ_WRITE_TOKEN=... node scripts/export-blob.mjs
import { mkdir, writeFile } from 'node:fs/promises'
import { dirname, join } from 'node:path'
delete process.env.DATA_DIR // read from Blob, not from disk
const { readBlob } = await import('../api/_storage.js')
for (const path of ['farm-points/points_state.csv', 'market-history/history.json', 'market-history/index-v2.json']) {
  const body = await readBlob(path)
  if (body == null) { console.log('missing', path); continue }
  const out = join('data-export', path)
  await mkdir(dirname(out), { recursive: true })
  await writeFile(out, body)
  console.log('exported', path, `${body.length} bytes`)
}
