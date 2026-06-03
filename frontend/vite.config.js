import { defineConfig } from 'vite'
import react from '@vitejs/plugin-react'

// https://vitejs.dev/config/
export default defineConfig({
  // Relative base so the built app works when loaded via file:// inside Electron.
  base: './',
  plugins: [react()],
})
