# nwfl-mensa-web

The web gateway for the Northwest Florida Mensa site: an Astro server that renders the public pages and, later, the officer and member areas. Every page is plain HTML that works with JavaScript off.

## Run it

```sh
npm ci --ignore-scripts
npm run build
npm start            # http://localhost:8080
```

`npm start` runs `server/serve.mjs`: Astro's standalone handler behind the site policy (`server/policy.mjs`), which puts the security headers and the cache rule on every response, prerendered pages and assets included.

Every cookie the site sets is host-only (`__Host-` prefix, `Secure`, `Path=/`, no `Domain`). Chromium keeps such cookies on `http://localhost`, so local work in Chromium needs nothing more. WebKit (Safari) refuses them over plain http even on loopback; for it, run the test TLS edge in a second terminal (`TLS_PORT=8443 UPSTREAM=http://127.0.0.1:8080 node e2e/tls-proxy.mjs`) and open `https://localhost:8443`.

## Request limits

- Astro reads at most 64 KiB of any request body (`bodySizeLimit`; its default is 1 GB). `/prefs` reads at most 4 KiB and answers 413, whether the body is declared or chunked.
- A POST, PUT, PATCH or DELETE that carries neither an `Origin` header nor `Sec-Fetch-Site: same-origin` is refused with 403 before Astro sees it; with either, Astro's origin check decides.
- The server decides on the path the static handler serves, percent-decoded. A path with an encoded `/`, `\` or NUL, or broken encoding, is a 400. Only a plain file name under `/_astro/` is cached for a year.
- Node's own HTTP parser answers a malformed request (400) or oversized headers (431) before any of this code runs, so those two responses carry none of the site's headers. Their bodies are empty, and Cloudflare fronts the site.

## Check it

```sh
npm run lint
npm run typecheck
npm run test:coverage   # unit tests, 85 % line and branch gate
npm run build && npm run e2e   # Playwright: Chromium and WebKit (iPhone), axe, over https
```

## Secrets and people

The history may be published, so nothing secret and no real person's contact details go in. `npm install` points git at `.githooks/`, whose pre-commit hook runs gitleaks 8.30.1 (pinned in `scripts/gitleaks.sh`, by image digest when no local copy of that exact version exists) over the staged changes. CI scans every commit; `npm run secrets:scan` does the same by hand. Fixtures and placeholders use made-up people, example.org addresses and 555-01xx numbers; a test checks the addresses and numbers.

## Image

`docker build -t nwfl-mensa-web .` builds a Node 24 image that runs as uid 10001 with a read-only root; mount `/tmp` writable and nothing else. It listens on 8080 and answers `/healthz`.

## Fonts

Atkinson Hyperlegible (body) and Lexend (headings) are self-hosted from the `@fontsource` packages; nothing is fetched from Google at runtime. Both are under the SIL Open Font License 1.1, served beside the fonts at `/fonts/OFL-Atkinson-Hyperlegible.txt` and `/fonts/OFL-Lexend.txt`.
