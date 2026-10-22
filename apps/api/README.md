# nwfl-mensa-api

The gRPC API behind the NW Florida Mensa website.

## Ports

| Port  | Protocol | Serves |
|-------|----------|--------|
| 50051 | gRPC over h2c; Linkerd adds mTLS on the mesh hop | the RPC services and `grpc.health.v1.Health` |
| 8081  | plain HTTP/1.1 | `/healthz` (liveness, never touches Postgres) and `/readyz` (Postgres answers, not draining) |

The gRPC port speaks only the gRPC wire protocol. Only `application/grpc`
and `application/grpc+proto` get in; anything else, `+json` included, is
refused with 415 before Connect sees it, and Connect itself has the Connect
and gRPC-Web protocols switched off (`test/grpc/transport-rule.test.ts`).
HTTP/1.1 is not spoken on that port at all.

Bounds, so one caller cannot pin the pod's memory: 16 concurrent streams per
connection, 32 active streams across connections (more get
RESOURCE_EXHAUSTED), 4 MiB per message, and 10 s for a request body to
arrive before its stream is cancelled. A call refused before the
interceptors run still gets an access-log line (request id, method, code)
and a fixed `grpc-message` per code that never repeats the caller's input.

Request messages are never logged. The access log carries the method, the
outcome and the duration only, and an unexpected error reaches the caller as
INTERNAL with no text.

On SIGTERM the process drains: readiness flips to draining, the gRPC listener
stops accepting, open sessions get GOAWAY, and running calls have
`DRAIN_TIMEOUT_MS` (default 20 s) to finish before they are cancelled. If
Postgres hangs during the drain, closing the pool can hang too; a backstop
then exits with code 1, 5 s after the drain deadline and before the kubelet's
SIGKILL. That exit code is accepted: the pod is going away either way.

## Testing

    npm run lint && npm run typecheck && npm run test:coverage

Coverage is gated at 85 % lines, branches, functions and statements, per file
(`vitest.config.ts`).

The live suites need a throwaway Postgres. Start one, run, then remove it by
the id the script printed:

    sh scripts/test-db.sh start > .testdb.env   # or anywhere outside the repo
    set -a; . ./.testdb.env; set +a
    npm run test:coverage
    sh scripts/test-db.sh stop "$NWFL_TEST_PG_CONTAINER"

Without `NWFL_TEST_DATABASE_URL` and `NWFL_TEST_PG_CONTAINER` the live suites
skip locally; with `CI=true` they fail instead. The migration suites run
`scripts/migrate.sh` inside that container (`docker exec`), against the repo
mounted read-only at `/repo`, each in a database of its own.

## Secrets and fixtures

This repository's whole history is meant to be publishable.

- `npm install` (its `prepare` script; `npm run prepare` by hand) points git
  at the repository root's `.githooks`, whose pre-commit hook runs gitleaks
  over the staged changes and refuses a commit that adds a secret. CI and the
  Docker build install with `--ignore-scripts`, so they never touch git
  config. The root's `secrets` workflow runs it over every commit
  (`npm run secrets:scan` does the same locally). The version and image digest
  are pinned in the root's `scripts/gitleaks.sh`; a local gitleaks is used
  only if it is exactly that version, otherwise the image runs (Docker
  needed).
- Fixtures and tests use made-up people only: no real officer or member
  names, emails, phones or addresses. The root's `scripts/made-up-people.mjs`
  (run in CI and by `test/tooling/made-up-people.test.ts`) allows email
  addresses only at example domains or nwflorida.us role aliases, and phone
  numbers only in the fictional 555-01xx range, across the repository. A seed
  script takes its data from a path outside the repository, given as an
  argument.
- CI for this app is the root's `.github/workflows/api.yml`; it runs when
  `apps/api` changes. MT-06 (no FigureCollecting registry or token) is checked
  for the whole repository by the root's `scripts/no-fc-credentials.sh`.
- Commit only what you wrote or what carries a compatible open licence.
  `proto/grpc/health/v1/health.proto` is Apache-2.0 (header kept);
  `vendor/` holds fc-shared 1.7.0, MIT (its LICENSE is inside the tarball).

## Contract

`proto/nwfl/mensa/v1` holds the API: `EventService`, `ContentService`,
`MembershipService`, `NewsletterService` and `MembershipVerifierService`. The
generated code under `src/gen` is committed; CI regenerates it and fails on a
diff. `test/proto/contract.test.ts` walks the generated descriptors and holds
the rules a handler cannot be trusted to keep:

- no RPC takes an audience from the caller except `ExportEdition`, and no
  read RPC takes a visibility filter;
- the membership number reaches only `ListPendingVerifications` (out) and
  `SubmitSignup` (in);
- no message has a phone, birthday or home-address field, and the membership
  messages have no free-text note.

## Callers, tokens and the audience

A bearer token is verified with jose against the JWKS of the client it names
(`src/auth/jwt.ts`), and the caller and audience come from it alone
(`src/auth/caller.ts`):

| Client | Env (issuer turns it on) | Caller | Reaches |
|---|---|---|---|
| `nwfl-site` | `SITE_OIDC_ISSUER`, `SITE_OIDC_AUDIENCE`, `SITE_OIDC_JWKS_URL` | a user: officers by the `nwfl-officers` group, members by `member_account` | every service but the two below |
| `nwfl-agent` | `AGENT_OIDC_*`, `AGENT_SCOPE`, `AGENT_SUBJECT` | the newsletter agent | `NewsletterService` only |
| `nwfl-verifier` | `VERIFIER_OIDC_*`, `VERIFIER_SCOPE`, `VERIFIER_SUBJECT` | the membership verifier | `MembershipVerifierService` only |

No token is public; a token that does not verify is refused. Member-level
reading comes from `member_account` on each call (AC6 b), not from the
token's groups; an account unverified for 13 months reads as public.
`src/auth/roles.ts` holds the own-office rule and the approver checks for the
write handlers. A call that arrived through the edge (its `l5d-client-id` is
in `EDGE_CLIENT_IDS`) reaches only the agent and verifier services; the
header never grants anything. With no issuer set, every token is refused.

Members-only content is filtered in one place (`src/content/tree.ts`,
`bodyFor` in `src/content/service.ts`): a members passage becomes a bare
placeholder with no text, length, link or image; a node the API cannot vouch
for, or a broken members marker, is treated as members-only. Anonymous reads
load `public_ast` only. `test/canary.test.ts` seeds a random token into every
members-only place, calls every read RPC anonymously, and fails if the token
appears; a read RPC without a canary request fails it too.

## The officers' writes

Every write is one transaction, audited in `audit_event`, and checked twice:
by the handler for a precise answer, and by the database (`0007`).

- **Content** (`src/content/workflow.ts`): a holder of the office creates,
  saves and marks ready ("Posting as" an office they hold; the Admin may post
  for any office, audited as such). Markup is parsed on save
  (`src/content/markup.ts`); a version with problems cannot be marked ready.
  "Mark ready" records the content hash (`src/content/hash.ts`), with website
  and newsletter on and email off by default. An approver (Admin or Webmaster)
  approves only with the hash they saw, never a version they edited, except
  the Admin's break-glass with a written reason (`approve_self` in the
  history). Approval derives the public tree and both search indexes, then
  repoints the live version before superseding the old one. Withdraw is 410
  at once; restore makes a draft that stays withdrawn until approved.
- **Events** (`src/events/writes.ts`): live on save. Venues by any officer,
  series by their host office, a one-off event by its owning office, and the
  Admin for any.
- **Editions** (`src/content/editions.ts`): the Editor or the Admin sets them
  up; the freeze moves one to proof and pins the live version of each
  approved newsletter item in it.
- Officers read drafts, ready items and each item's history.

## Seeding the calendar and roster

    node dist/seed/cli.js /path/outside/the/repo/seed.json

The file holds offices, terms, business or virtual venues, series and
occurrences (`test/fixtures/seed.example.json` shows the shape with made-up
people). A path inside the repository is refused, as are a member's home and
any unknown field. It runs in one transaction, is idempotent, records each
row in `audit_event`, and prints counts only.

## Schema

Raw SQL in `migrations/NNNN_*.sql`, applied by `scripts/migrate.sh` (ported
from fc-coordinator: psql, one transaction per file with its ledger row, a
sha256 provenance check, an advisory lock). An applied file is never edited:
fixes go forward in a new file (`0007_a2_fix.sql` carries the A2 challenge).
Two roles: `nwfl_migrator` owns the schema; `nwfl`, the role the service
connects as, reads and writes rows only, with no TRUNCATE and no temporary
tables.

The rules the database itself enforces:

- the publishing workflow moves only along its transitions (a version:
  draft, ready, approved, superseded or discarded; an item: draft, ready,
  published, withdrawn), everything starts as a draft, a version's authored
  content freezes at ready and everything freezes once it is decided, and an
  item's live version is always an approved one;
- `audit_event` is append-only by grant and by trigger, the database numbers
  and times each event, and its payload never holds a membership number or a
  last name under any spelling; `content_version_editor` is append-only and a
  version is never deleted;
- a member's home has no street address, city or link; a `.docx` is
  officers-only; an edition's hosted PDF is a public file of that edition;
- a sign-up's membership number and last name are erased when the verifier
  reports and when an officer approves or rejects it; `affiliate` needs a
  recorded grant.

Accepted residual risks, with no code against them:

- The schema owner can disable a trigger or drop a constraint. The migrator
  role runs migrations only; the service never connects as it.
- An erased membership number still exists in Postgres WAL and in backups
  until they age out; pg-nwfl's backup retention bounds how long.
- Free-text fields (an event's detail, a send-back note) could hold someone's
  contact details if an officer types them. The approval screens for members
  have no notes field at all.

## Versions

- Node 24 LTS (`.nvmrc`, the Dockerfile base, and the fc-shared engines floor).
- TypeScript 6.0, not 7: typescript-eslint 8.72 declares
  `typescript >=4.8.4 <6.1.0` as its peer range.
- `@types/node` follows the Node 24 runtime, not the newest major.
- fc-shared 1.7.0 is vendored; see `vendor/README.md`.
- buf comes from the `@bufbuild/buf` npm package, so CI and a laptop run the
  same version.
- jose 6.2.13 verifies tokens (RS256 and ES256 only).
