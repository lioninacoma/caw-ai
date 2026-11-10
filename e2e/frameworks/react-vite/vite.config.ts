import react from '@vitejs/plugin-react'
import { defineConfig } from 'vite'

// FIXED_NAMES=1: feste Dateinamen ohne Hash, damit caw-ai lokalen Code per `statics` einspielen kann.
const fixed = process.env.FIXED_NAMES === '1'
export default defineConfig({
  plugins: [react()],
  server: { host: '127.0.0.1', port: 5173, strictPort: true, proxy: { '/api': 'http://127.0.0.1:3999' } },
  build: {
    sourcemap: true,
    ...(fixed ? { rollupOptions: { output: { entryFileNames: 'assets/[name].js', chunkFileNames: 'assets/[name].js', assetFileNames: 'assets/[name][extname]' } } } : {}),
  },
})
