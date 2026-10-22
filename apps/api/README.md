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

Without `NWFL_TEST_DATABASE_URL` the live suites skip locally; with `CI=true`
they fail instead.

## Versions

- Node 24 LTS (`.nvmrc`, the Dockerfile base, and the fc-shared engines floor).
- TypeScript 6.0, not 7: typescript-eslint 8.72 declares
  `typescript >=4.8.4 <6.1.0` as its peer range.
- `@types/node` follows the Node 24 runtime, not the newest major.
- fc-shared 1.7.0 is vendored; see `vendor/README.md`.
- buf comes from the `@bufbuild/buf` npm package, so CI and a laptop run the
  same version.
