# NW Florida Mensa site

The website, API and newsletter export for the Northwest Florida Mensa local group.

- `apps/web`: the site and its sign-in gateway (Astro, server-rendered, no JavaScript required).
- `apps/api`: the gRPC API that holds events, publishing and membership, and decides what each reader may see.

CI lives in `.github/workflows/`: `web.yml` and `api.yml` run when their app changes (`web.yml` also when the API's protos change, as the site's gRPC client is generated from them), and `secrets.yml` checks the whole repository on every change (gitleaks over every commit, no private registry, made-up people only). On a push to `main`, each app's image is published to `ghcr.io/rpgoldberg/nwfl-mensa-site/web` or `/api`, tagged with the short commit and printed by digest. Secrets are refused at commit time too: `npm install` in either app points git at `.githooks/` (or run `git config core.hooksPath .githooks`).

Accessibility comes first: large type, strong contrast, no hidden gestures, and full use on a phone or a desktop.

Source is published for inspection only; see NOTICE.
