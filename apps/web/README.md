# nwfl-mensa-web

The web gateway for the Northwest Florida Mensa site: an Astro server that renders the public pages and, later, the officer and member areas. Every page is plain HTML that works with JavaScript off.

## Run it

```sh
npm ci --ignore-scripts
npm run build
npm start            # http://localhost:8080
```

`npm start` runs `server/serve.mjs`: Astro's standalone handler behind the site policy (`server/policy.mjs`), which puts the security headers and the cache rule on every response, prerendered pages and assets included.

## Check it

```sh
npm run lint
npm run typecheck
npm run test:coverage   # unit tests, 85 % line and branch gate
npm run build && npm run e2e   # Playwright: Chromium and WebKit (iPhone), axe
```

## Image

`docker build -t nwfl-mensa-web .` builds a Node 24 image that runs as uid 10001 with a read-only root; mount `/tmp` writable and nothing else. It listens on 8080 and answers `/healthz`.

## Fonts

Atkinson Hyperlegible (body) and Lexend (headings) are self-hosted from the `@fontsource` packages; nothing is fetched from Google at runtime. Both are under the SIL Open Font License 1.1, served beside the fonts at `/fonts/OFL-Atkinson-Hyperlegible.txt` and `/fonts/OFL-Lexend.txt`.
