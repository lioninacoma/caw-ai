import react from '@vitejs/plugin-react'
import { defineConfig } from 'vite'

// CAW_SPLIT=1: eine andere Aufteilung (React und Router je ein eigener Chunk), wie ein lokaler Stand nach einer Aenderung an der
// Bundler-Einstellung. Mit dem Overlay muss die ausgelieferte Seite dann die Tags des lokalen Builds bekommen.
const split = process.env.CAW_SPLIT === '1'
export default defineConfig({
  plugins: [react()],
  server: { host: '127.0.0.1', port: 5173, strictPort: true, proxy: { '/api': 'http://127.0.0.1:3999' } },
  build: {
    sourcemap: true,
    ...(split ? { rollupOptions: { output: { manualChunks: (id: string) => (/node_modules[\\/](react|react-dom|scheduler)[\\/]/.test(id) ? 'react' : /node_modules[\\/]react-router/.test(id) ? 'router' : undefined) } } } : {}),
  },
})
