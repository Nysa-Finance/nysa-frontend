import { defineConfig } from 'vite'
import vue from '@vitejs/plugin-vue'

// In dev, /api goes to the deployed backend; run `npm run server` and set API_TARGET=http://localhost:3000 to use
// a local one instead.
export default defineConfig({
  plugins: [vue()],
  build: { target: 'es2022' },
  server: { proxy: { '/api': { target: process.env.API_TARGET || 'https://app.nysa.finance', changeOrigin: true } } },
})
