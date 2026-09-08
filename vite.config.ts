import { defineConfig } from 'vite'
import react from '@vitejs/plugin-react'

// The client is a separate Vite project from the server (src/server, built by plain tsc — see
// tsconfig.json) living under src/client. Building it emits into public/, which
// src/server/index.ts already serves as static files and falls back to for client-side
// routing — no server changes needed once this exists there.
export default defineConfig({
  root: 'src/client',
  plugins: [react()],
  build: {
    outDir: '../../public',
    emptyOutDir: true
  },
  server: {
    // In dev (npm run dev:client), proxy API/stream/auth calls to the real server (npm run
    // dev, on PORT) instead of Vite's own dev server — the client's own fetch()/getStreamUrl()
    // calls are all relative, same-origin paths, so they'd otherwise 404 against Vite itself.
    proxy: {
      '/api': 'http://localhost:8080',
      '/player_api.php': 'http://localhost:8080',
      '/xmltv.php': 'http://localhost:8080',
      '/live': 'http://localhost:8080',
      '/movie': 'http://localhost:8080',
      '/series': 'http://localhost:8080',
      '/timeshift': 'http://localhost:8080',
      '/__fetch': 'http://localhost:8080',
      '/__transcode': 'http://localhost:8080'
    }
  }
})
