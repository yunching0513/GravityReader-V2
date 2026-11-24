import { defineConfig } from 'vite'
import react from '@vitejs/plugin-react'
import { VitePWA } from 'vite-plugin-pwa'

// The web build (`--mode web`, deployed on Vercel) is also the iPad app: open it
// in Safari, Share → Add to Home Screen. That needs a manifest and a service
// worker, so the PWA plugin runs for that build only. The desktop build is
// loaded from file:// inside Electron, where a service worker can't register
// and would only get in the way.
function pwa() {
  return VitePWA({
    registerType: 'autoUpdate',
    injectRegister: 'auto',
    includeAssets: ['apple-touch-icon.png'],
    manifest: {
      name: "Yun's Reader · 昀氏閱讀",
      short_name: "Yun's Reader",
      description: '雙語精讀:PDF 對譯、筆記、心流專注。',
      lang: 'zh-TW',
      start_url: './',
      scope: './',
      display: 'standalone',
      orientation: 'any',
      background_color: '#FFFFFF',
      theme_color: '#FFFFFF',
      icons: [
        { src: 'icon-192.png', sizes: '192x192', type: 'image/png' },
        { src: 'icon-512.png', sizes: '512x512', type: 'image/png' },
        { src: 'icon-512.png', sizes: '512x512', type: 'image/png', purpose: 'maskable' },
      ],
    },
    workbox: {
      // Everything the app needs to open and read a stored PDF with no network.
      // The pdf.js worker is the big one (~1 MB), hence the raised limit.
      globPatterns: ['**/*.{js,css,html,png,svg,woff2}'],
      maximumFileSizeToCacheInBytes: 5 * 1024 * 1024,
      navigateFallback: 'index.html',
      runtimeCaching: [
        {
          // Google Fonts: the stylesheet changes rarely, the font files never.
          urlPattern: /^https:\/\/fonts\.googleapis\.com\/.*/i,
          handler: 'StaleWhileRevalidate',
          options: { cacheName: 'google-fonts-css' },
        },
        {
          urlPattern: /^https:\/\/fonts\.gstatic\.com\/.*/i,
          handler: 'CacheFirst',
          options: {
            cacheName: 'google-fonts-files',
            expiration: { maxEntries: 60, maxAgeSeconds: 60 * 60 * 24 * 365 },
            cacheableResponse: { statuses: [0, 200] },
          },
        },
        {
          // Daily digests are regenerated; prefer fresh, fall back to the last copy.
          urlPattern: /\/digests\/.*\.json$/i,
          handler: 'NetworkFirst',
          options: { cacheName: 'digests', networkTimeoutSeconds: 4 },
        },
        // Gemini calls are never cached: they carry the key and are one-off.
      ],
    },
  })
}

// https://vitejs.dev/config/
export default defineConfig(({ mode }) => ({
  // Relative base so the built app works when loaded via file:// inside Electron.
  base: './',
  plugins: [react(), ...(mode === 'web' ? [pwa()] : [])],
  build: {
    rollupOptions: {
      output: {
        // pdf.js is by far the largest dependency and it changes far less often
        // than the app does. Splitting it out lets the browser keep it cached
        // across releases instead of re-downloading a ~600 kB blob each deploy.
        manualChunks: {
          pdf: ['react-pdf', 'pdfjs-dist'],
          vendor: ['react', 'react-dom'],
        },
      },
    },
  },
}))
