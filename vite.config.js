import { defineConfig } from 'vite'
import vue from '@vitejs/plugin-vue'
import { fileURLToPath } from 'node:url'

// klend-sdk → kliquidity-sdk → @orca-so/whirlpools-core (WASM, top-level await). The lending flow never
// touches it, so it is aliased to a stub (the original Nysa bundle drops it too).
// /api/points is served by the original deployment; proxy it in dev (see vercel.json for prod).
export default defineConfig({
  plugins: [vue()],
  resolve: { alias: { '@orca-so/whirlpools-core': fileURLToPath(new URL('./src/orca-stub.cjs', import.meta.url)) } },
  build: { target: 'es2022' },
  optimizeDeps: { esbuildOptions: { target: 'es2022' } },
  server: { proxy: { '/api': { target: 'https://app.nysa.finance', changeOrigin: true } } },
})
