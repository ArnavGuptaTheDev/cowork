// @ts-check
import { defineConfig } from 'astro/config';
import preact from '@astrojs/preact';

export default defineConfig({
  site: 'https://cowork.arnavg.me',
  output: 'static',
  integrations: [preact()],
  // today.html (served at /today on Cloudflare Pages) rather than today/index.html, which would 308 to /today/
  build: { format: 'file' },
  security: {
    // Astro hashes every script and style it emits into a CSP <meta>; nothing inline runs without a hash.
    csp: {
      directives: [
        "default-src 'self'",
        "img-src 'self' data: blob: https://lh3.googleusercontent.com",
        "font-src 'self'",
        "connect-src 'self'",
        "manifest-src 'self'",
        "worker-src 'self'",
        "base-uri 'self'",
        "form-action 'self'",
        "object-src 'none'",
      ],
    },
  },
  vite: {
    server: {
      // `npm run dev` serves the UI; API calls go to `wrangler pages dev` on 8788 (`npm run dev:api`).
      // changeOrigin stays false so the API sees the browser's Host and Origin (CSRF + OAuth redirect URIs).
      proxy: { '/api': { target: 'http://localhost:8788', changeOrigin: false } },
    },
  },
});
