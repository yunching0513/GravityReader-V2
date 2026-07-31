import { defineConfig } from 'vite'
import react from '@vitejs/plugin-react'

// https://vitejs.dev/config/
export default defineConfig({
  // Relative base so the built app works when loaded via file:// inside Electron.
  base: './',
  plugins: [react()],
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
})
