// klend-sdk (and its borsh deps) expect Node's Buffer as a global.
import { Buffer } from 'buffer'
globalThis.Buffer ??= Buffer
