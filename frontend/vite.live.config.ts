import { defineConfig, mergeConfig } from 'vite'
import base from './vite.config.ts'

// Match PR #4's loopback/origin checks without weakening the backend guard.
export default mergeConfig(base, defineConfig({
  server: {
    host: '127.0.0.1',
    proxy: {
      '/api': {
        target: 'http://127.0.0.1:4320',
        changeOrigin: true,
        configure(proxy) {
          proxy.on('proxyReq', (request, incoming) => {
            if (incoming.headers.origin === `http://${incoming.headers.host}`) {
              request.setHeader('origin', 'http://127.0.0.1:4320')
            }
          })
        },
      },
    },
  },
}))
