export default defineNuxtConfig({
  compatibilityDate: '2026-01-01',
  devtools: { enabled: false },
  telemetry: false,
  ssr: true,
  sourcemap: { client: true, server: false },
  devServer: { host: '127.0.0.1', port: 3001 },
  runtimeConfig: { public: { build: process.env.NUXT_PUBLIC_BUILD ?? 'dev' } },
  routeRules: { '/api/**': { proxy: 'http://127.0.0.1:3999/api/**' } },
})
