import { cloudflare } from '@cloudflare/vite-plugin'
import react from '@vitejs/plugin-react'
import { fileURLToPath, URL } from 'node:url'
import { defineConfig } from 'vite'

export default defineConfig({
  root: fileURLToPath(new URL('./frontend', import.meta.url)),
  plugins: [react(), cloudflare({
    configPath: fileURLToPath(new URL('./wrangler.jsonc', import.meta.url)),
    persistState: { path: fileURLToPath(new URL('./.wrangler/state', import.meta.url)) }
  })],
  resolve: {
    alias: { '@': fileURLToPath(new URL('./frontend/src', import.meta.url)) }
  },
  build: {
    outDir: fileURLToPath(new URL('./dist', import.meta.url))
  },
  server: { host: '127.0.0.1' }
})
