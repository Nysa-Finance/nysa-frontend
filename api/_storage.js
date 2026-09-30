// Where the server-side state lives (Farm Points CSV, APY history, market index):
// - DATA_DIR set (VPS / Docker): plain files in that directory, written atomically (temp file + rename);
// - otherwise (Vercel): private Vercel Blob.
// The leading underscore keeps Vercel from deploying this file as a function.
import { mkdir, readFile, rename, writeFile } from 'node:fs/promises'
import { dirname, join } from 'node:path'

const DIR = process.env.DATA_DIR

// Text content, or null if it does not exist yet.
export async function readBlob(path) {
  if (DIR) {
    try { return await readFile(join(DIR, path), 'utf8') } catch (e) { if (e.code === 'ENOENT') return null; throw e }
  }
  const { get } = await import('@vercel/blob')
  const blob = await get(path, { access: 'private', useCache: false })
  return blob ? new Response(blob.stream).text() : null
}

export async function writeBlob(path, body, contentType) {
  if (DIR) {
    const file = join(DIR, path)
    await mkdir(dirname(file), { recursive: true })
    await writeFile(`${file}.tmp`, body)
    await rename(`${file}.tmp`, file) // readers never see a half-written file
    return
  }
  const { put } = await import('@vercel/blob')
  await put(path, body, { access: 'private', addRandomSuffix: false, allowOverwrite: true, contentType })
}
