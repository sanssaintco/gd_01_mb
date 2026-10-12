import os from 'node:os';
import path from 'node:path';
import { defineConfig } from 'vite';

export default defineConfig({
  // Relative URLs in the build, so it works under any sub-path (GitHub Pages serves it at /<repo>/).
  // The assets (STL, SVG, font, ICC) are in public/ and are copied into the build as they are.
  base: './',
  // Keep Vite's dependency cache out of the project folder.
  cacheDir: path.join(os.tmpdir(), 'gd_01_mb-vite-cache'),
  // Explicit IPv4: Node resolves "localhost" to ::1 only, and browsers that try 127.0.0.1 get
  // ERR_CONNECTION_REFUSED.
  server: { host: '127.0.0.1', port: 5173, strictPort: true },
  worker: { format: 'es' },
});
