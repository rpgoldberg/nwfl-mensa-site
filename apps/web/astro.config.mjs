// @ts-check
import node from '@astrojs/node';
import { defineConfig, envField } from 'astro/config';
import { buildInfoIntegration } from './server/build-info.mjs';
import { LOCAL_HOSTS, PUBLIC_HOSTS, SITE } from './server/public-hosts.mjs';

export default defineConfig({
  site: SITE,
  output: 'server',
  // Standalone, but started by server/serve.mjs, which wraps Astro's handler so
  // the response policy reaches prerendered pages and assets too.
  // Every request body Astro reads is capped at 64 KiB: its 1 GB default let
  // three large posts exhaust the pod's memory. /prefs caps its own at 4 KiB.
  adapter: node({ mode: 'standalone', bodySizeLimit: 64 * 1024 }),
  // dist/build.json: tells the server wrapper whether this is the public-only build.
  integrations: [buildInfoIntegration()],
  server: { port: 8080, host: true },
  trailingSlash: 'never',
  build: {
    // `/about` is about.html on disk, so a clean URL needs no redirect.
    format: 'file',
    // Every stylesheet is a file, so the CSP needs no 'unsafe-inline' or hashes.
    inlineStylesheets: 'never',
  },
  prefetch: false,
  // The session lives in our own encrypted cookie (W4); Astro's filesystem
  // session store would also need a writable disk, and the root is read-only.
  session: false,
  devToolbar: { enabled: false },
  env: {
    schema: {
      // MT-50: `PUBLIC_ONLY=true astro build` makes a deployment with no sign-in
      // at all (src/lib/access.ts). Fixed at build time; off by default.
      PUBLIC_ONLY: envField.boolean({ context: 'server', access: 'public', default: false }),
    },
  },
  security: {
    checkOrigin: true,
    // cloudflared sends X-Forwarded-Proto: https; trust it only for our own hosts,
    // so the origin check sees the browser's https origin.
    // Only a listed Host sets the request's origin; any other falls back to
    // localhost, and the origin check then refuses the site's own form posts.
    // Pages print absolute URLs through publicOrigin (src/lib/origin.ts), not Astro.url.
    allowedDomains: [...PUBLIC_HOSTS, ...LOCAL_HOSTS],
  },
});
