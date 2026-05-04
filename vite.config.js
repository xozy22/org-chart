import { defineConfig } from 'vite';

// Backend dev-server URL — override with `BACKEND_URL=http://...` if needed.
// Defaults to the Express dev server's port (3000) defined in backend/.
const BACKEND_URL = process.env.BACKEND_URL || 'http://localhost:3000';

export default defineConfig({
  server: {
    port: 5173,
    open: true,
    // Proxy /api/* to the backend so the frontend dev server can talk to
    // it without CORS during development. In production nginx handles
    // the same proxying — see nginx.conf.
    proxy: {
      '/api': {
        target: BACKEND_URL,
        changeOrigin: true,
      },
    },
  },
});
