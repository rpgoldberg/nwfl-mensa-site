# nwfl-mensa-api

The gRPC API behind the NW Florida Mensa website.

## Ports

| Port  | Protocol | Serves |
|-------|----------|--------|
| 50051 | gRPC over h2c; Linkerd adds mTLS on the mesh hop | the RPC services and `grpc.health.v1.Health` |
| 8081  | plain HTTP/1.1 | `/healthz` (liveness, never touches Postgres) and `/readyz` (Postgres answers, not draining) |

The gRPC port speaks only the gRPC wire protocol. Connect-ES serves Connect
and gRPC-Web by default; both are switched off, and a request in either is
refused with 415 (`test/grpc/transport-rule.test.ts`). HTTP/1.1 is not spoken
on that port at all.

Request messages are never logged. The access log carries the method, the
outcome and the duration only, and an unexpected error reaches the caller as
INTERNAL with no text.

On SIGTERM the process drains: readiness flips to draining, the gRPC listener
stops accepting, open sessions get GOAWAY, and running calls have
`DRAIN_TIMEOUT_MS` (default 20 s) to finish before they are cancelled.

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
  at `.githooks`, whose pre-commit hook runs gitleaks over the staged changes
  and refuses a commit that adds a secret. CI and the Docker build install
  with `--ignore-scripts`, so they never touch git config. CI runs it over every commit (`npm run secrets:scan` does the same
  locally). The version and image digest are pinned in `scripts/gitleaks.sh`;
  a local gitleaks is used only if it is exactly that version, otherwise the
  image runs (Docker needed).
- Fixtures and tests use made-up people only: no real officer or member
  names, emails, phones or addresses. `test/tooling/made-up-people.test.ts`
  allows email addresses only at example domains or nwflorida.us role aliases,
  and phone numbers only in the fictional 555-01xx range. A seed script takes
  its data from a path outside the repository, given as an argument.
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

## Reads and the audience

The read RPCs (`EventService` and the `ContentService` reads) take the
audience from the verified bearer token and from nothing else
(`src/auth/caller.ts`): no token is public, `nwfl-members` or
`nwfl-affiliates` is members, `nwfl-officers` is officers, and a token that
does not verify is refused rather than downgraded. Until A3 supplies the JWKS
verifier, every presented token is refused.

Members-only content is filtered in one place (`src/content/tree.ts`,
`bodyFor` in `src/content/service.ts`): a members passage becomes a bare
placeholder with no text, length, link or image; a node the API cannot vouch
for, or a broken members marker, is treated as members-only. Anonymous reads
load `public_ast` only. `test/canary.test.ts` seeds a random token into every
members-only place, calls every read RPC anonymously, and fails if the token
appears; a read RPC without a canary request fails it too.

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
sha256 provenance check, an advisory lock). Two roles: `nwfl_migrator` owns
the schema; `nwfl`, the role the service connects as, reads and writes rows
only. `audit_event` is append-only by grant and by trigger. The CHECK
constraints carry the data rules: a member's home has no street address, a
`.docx` is officers-only, a sign-up's membership number is erased when the
verifier reports, and `affiliate` needs a recorded grant.

## Versions

- Node 24 LTS (`.nvmrc`, the Dockerfile base, and the fc-shared engines floor).
- TypeScript 6.0, not 7: typescript-eslint 8.72 declares
  `typescript >=4.8.4 <6.1.0` as its peer range.
- `@types/node` follows the Node 24 runtime, not the newest major.
- fc-shared 1.7.0 is vendored; see `vendor/README.md`.
- buf comes from the `@bufbuild/buf` npm package, so CI and a laptop run the
  same version.
