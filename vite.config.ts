import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';
import { readFileSync } from 'node:fs';
import { engineHash } from './engine-files.mjs';
import { handleApi } from './server.mjs';

const pkg = JSON.parse(readFileSync(new URL('./package.json', import.meta.url), 'utf8'));

export default defineConfig({
  plugins: [
    react(),
    // in development, /api/* is answered by the same code as the deployed server
    { name: 'api', configureServer(server) { server.middlewares.use(async (req, res, next) => { if (!(await handleApi(req, res))) next(); }); } },
  ],
  define: {
    __APP_VERSION__: JSON.stringify(pkg.version),
    __ENGINE_HASH__: JSON.stringify(engineHash()),
  },
  // Office portal: served at tools.ykjoneja.com/tds/ (set BASE_PATH=/ to serve at the root).
  base: (process.env.BASE_PATH ?? '/tds').replace(/\/+$/, '') + '/',
  build: { outDir: 'dist', chunkSizeWarningLimit: 4000 },
  server: { port: 5173 },
});
