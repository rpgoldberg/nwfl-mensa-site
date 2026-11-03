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
| `nwfl-site` | `SITE_OIDC_ISSUER`, `SITE_OIDC_AUDIENCE`, `SITE_OIDC_JWKS_URL`, `SITE_GROUP_PREFIX` | a user: officers by the `<prefix>officers` group, members by `member_account` | every service but the two below |
| `nwfl-agent` | `AGENT_OIDC_*`, `AGENT_SCOPE`, `AGENT_SUBJECT` | the newsletter agent | `NewsletterService` only |
| `nwfl-verifier` | `VERIFIER_OIDC_*`, `VERIFIER_SCOPE`, `VERIFIER_SUBJECT` | the membership verifier | `MembershipVerifierService` only |

No token is public; a token that does not verify is refused. Member-level
reading comes from `member_account` on each call (AC6 b), not from the
token's groups; an account unverified for 13 months reads as public.
`src/auth/roles.ts` holds the own-office rule and the approver checks for the
write handlers. A call that arrived through the edge (its `l5d-client-id` is
in `EDGE_CLIENT_IDS`) reaches only the agent and verifier services; the
header never grants anything. With no issuer set, every token is refused.

One deployment serves one chapter (CF-ISO-0). A site token is this chapter's
only by its issuer and audience (`SITE_OIDC_ISSUER`, `SITE_OIDC_AUDIENCE`),
with no other audience beside ours. Its groups count only under
`SITE_GROUP_PREFIX` (default `nwfl-`; e.g. `mensa-nwfl-`), renamed to the
internal `nwfl-<role>` names the code and SQL use (`src/auth/groups.ts`); the
web takes the same variable. `TENANT` (default `nwflorida`) names the chapter
(`src/tenant.ts`). Both processes check it in the background. While the
database is down the API runs but reports not ready (`/readyz` shows
`tenant: unverified`) and the worker claims no job. Each failed attempt logs a
plain line and retries, waiting 1 s at first and doubling up to 15 s. Only a
positive mismatch (another tenant's row, no row, or several rows) logs the
reason and exits 1.

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

## Loading a newsletter issue

    node dist/load/cli.js -        # the bundle on stdin, never a path

One issue becomes one public DOCUMENT item, `Pensa Mensa, October-November
2026` with `Volume 30, Number 5` as its summary (slug `pensa-mensa-2026-10`),
holding a public PDF and a members PDF. The public is told "not found" for
the members file. The writer and approver is `system:issue-loader`, with a
self_breakglass reason that names the approval tag and both hashes.

The bundle is JSON: `format` (`nwfl-issue/1`), `issue` (`period` YYYY-MM,
`volume`, `number`), `office` (a slug), `approval` (`reference` such as
`PUBCOPY`, `marksSha256`, `publicInputHash`, `membersSha256`), `pdfs`
(`public`, `members`, base64, 10 MiB each at most) and `marks` (`quote`,
`category`). It is refused, with nothing applied, when:

- it has no marks, or a mark's category is not a personal-data category;
- the marks' hash is not `approval.marksSha256` (`marksSha256` in
  `src/load/load.ts`), or the members PDF's sha256 is not
  `approval.membersSha256`;
- a mark's quote is in the text layer of neither PDF (named by its place in
  the list, never its text);
- the public copy's input hash, computed in the database, is not
  `approval.publicInputHash`. The refusal prints the computed hash.

With `NODE_ENV=production` (the image), stdin must be a pipe or a socket. A
second run of the same bundle reports `unchanged`. A different bundle, or the
same one under another approval, is refused for an issue already loaded, and
so is any run once the issue was edited or withdrawn after loading. The
command prints ids and counts only.

The marks are file marks (`0020_file_marks.sql`): each is anchored in the
PDFs whose text layer holds its quote, so the issue is listed for everyone
while the PDF engine withholds the marked passages. The public gets the
redacted public copy, members a members copy without home addresses, and
officers the originals. Anchoring reads the originals as officers do, so the
load fails, with nothing applied, while the officers' policy hides or
redacts any category.

### Untrusted PDFs (UNTRUSTED-PDF-GATE)

The loader is the only way a PDF reaches the engine, and Ross runs it by
hand. An officer upload, the archive importer, or any new RPC that stores an
original, waits for two things: the engine as a sidecar with its own uid and
no secrets, and the output gate re-run outside the engine on every copy. Two
tests in the normal suite enforce this, and both aim at accidental and lazy
paths.

`test/gates/untrusted-pdf.test.ts` reads text, with nothing blanked. It fails
when:

- `storeOriginal`, or any word holding `original_put`, appears outside
  `src/pdf/store.ts` and `src/load/load.ts`;
- another word holding `pdf_original` appears outside `src/pdf/` beyond a
  frozen count;
- a module outside a frozen list imports `pdf/store`, or any module imports
  it whole;
- an `import()` or `require()` takes anything but a plain string;
- a migration grants EXECUTE on `pdf_original_put` or a write on
  `pdf_original` to a role other than `nwfl`, adds a member to `nwfl`, or
  changes an owner;
- an RPC's request message carries a `bytes` field, even nested
  (`ApproveRequest.content_hash`, a hash, is the one frozen exemption);
- an RPC's request tree differs from `test/gates/untrusted-pdf.requests.json`.
  Review the change against the gate, then refresh the file in the same PR
  with `UPDATE_REQUEST_SNAPSHOT=1`.

`test/gates/untrusted-pdf-catalog.test.ts` is the backstop. It migrates a
fresh database and freezes five things: who can write `pdf_original`; every
function that names it, with its owner, SECURITY DEFINER and executors; every
SECURITY DEFINER function; the members of `nwfl`; and the owner of
`pdf_original_put`. The database's grants are what make a call work, so this
check catches what text cannot: a name built at run time for a new role or a
new function, a grant built with `format()`, a role that joins `nwfl`. What it
does not catch is code running as `nwfl`, which already holds EXECUTE on
`pdf_original_put`, calling it under a name spelled at run time. The text
check flags the usual spellings; a deliberate split is out of scope, as the
gate is for accidents.

`UNTRUSTED_PDF_READY` in `src/pdf/untrusted.ts` lifts the text rules. It does
so only when both test files pinned in the gate test
(`test/pdf/engine-sidecar.test.ts` and `test/pdf/gate-rerun.test.ts`) exist,
each holding a real, unskipped test under its pinned title. Setting it to true
without them fails. The request snapshot and the catalog are never lifted.

Both pieces now exist (below) and both tests pass, but `UNTRUSTED_PDF_READY`
stays false until fc's manifest runs both sidecars as their own uids and
validate-nwfl checks them.

### The engine sidecar

The PDF engine can run as a sidecar process in a container of its own beside
the worker, from the same image, with node as PID 1 and no init:
`command: ["node", "--disable-sigusr1", "dist/pdf/engine-sidecar.js"]`
(`src/pdf/sidecar.ts`). It listens on one unix socket, by default
`/run/pdf-engine/engine.sock`, mode 0660, and still forks one child per copy
with an empty environment. It opens no other socket and makes no connection.

It will not start (exit 2) when:

- its environment holds any name off its allow-list (`ALLOWED_ENV`: what the
  image and the runtime set, the locale, the two socket paths, and the
  `KUBERNETES_*` address the kubelet always injects). It names the variables,
  never their values;
- `--socket` is not directly in `/run/pdf-engine`, or holds anything but
  letters, digits and `. _ - /`;
- it runs as root;
- it is not PID 1 of its container (dumb-init or any other init in front of
  it, which is what `args` instead of `command` gives);
- `NODE_ENV=production` (the image sets it) and Node was started without
  `--disable-sigusr1`.

What keeps a subverted copy's processes from outliving it (fix round 2, after
the round-2 challenge froze a sidecar with SIGSTOP from a fork-and-exit chain
and took its socket over), most load-bearing first:

1. PID 1. The kernel does not deliver SIGKILL or SIGSTOP to a namespace's PID
   1 from inside the namespace, nor any signal it has no handler for, so no
   child can freeze the sidecar. As PID 1 it still gets SIGUSR1, which would
   start Node's inspector on 127.0.0.1:9229, reachable from a child even with
   no network (measured); `--disable-sigusr1` and a listener of its own take
   it (`holdSignals`). The same listener-that-does-nothing takes every other
   signal that would end it by default and that Node lets it hold (SIGHUP,
   SIGUSR2, SIGALRM and the rest, `HELD_SIGNALS`): the round-3 challenge
   ended PID 1 with a burst of SIGCHLD, which Node handles, followed by one
   of those. A child can still make the sidecar exit (a real-time signal,
   SIGTERM): it fails closed, with no reply, and the job is retried.
2. No fork. Every per-copy child preloads a guard (`src/pdf/child-guard.ts`,
   `src/pdf/no-fork.ts`) that starts the threads it needs and says it is
   ready; the sidecar then sets the child's RLIMIT_NPROC to 1 with util-linux
   `prlimit` (in the base image), and the guard tries a spawn on purpose. The
   copy is sent only when that spawn failed with EAGAIN; a limit that cannot be
   set, or a spawn that works, refuses the copy. In a capped container spawn,
   exec and fork then all fail with EAGAIN, and zlib, crypto and the real
   engine and gate still run. pdf.js's optional canvas would need threads
   later, which is one more reason it is not in the image.
3. Before every reply, `kill(-1, SIGKILL)` (everything but PID 1), then `/proc`
   re-read until the sidecar is alone, in bounded passes. Anything left, or
   any zombie (its own children are reaped by then, so a zombie is an
   orphan), is doubt: it exits 1 without the reply, and the kernel kills the
   whole namespace with it. The `/proc` reading is best-effort on its own;
   1 and 2 are what make it hold.
4. Then the socket's device and inode are checked, before the reply, at each
   connection, and every second, and so are its mode (0660), owner and group
   as bound (fix round 3: a child of the sidecar's uid could `chmod 0` it in
   place and lock the worker out). A socket replaced, removed or changed
   stops it with exit 1 and no reply, and the job fails closed.

It replaces a socket left behind by a dead sidecar, but exits 1 if anything
else is at the path. SIGTERM and SIGINT kill the copy in flight, close the
listener, remove the socket and exit 0. Arguments: `--socket <path>`,
`--timeout-ms <ms>` (per copy, default 300000) and `--engine <module>`
(another engine child; tests use it, and production accepts it). Two more are
for tests and refused when `NODE_ENV=production`: `--socket-dir <dir>` (bind
outside `/run/pdf-engine`) and `--shared-pid-namespace` (run on a test host,
not as PID 1, clearing nothing, since `kill(-1)` there would reach the host's
processes). Every hostile, process-starting or memory-heavy test runs the
sidecar as PID 1 of a capped container instead (`test/helpers/contained.ts`).

The worker picks the engine with `PDF_ENGINE_SOCKET`:

- unset: the in-pod child, as before;
- an absolute path directly in `/run/pdf-engine`: the sidecar only, never
  the child, and `PDF_GATE_SOCKET` must be set too;
- anything else, including a trailing newline: the worker refuses to start.

Each copy uses one connection carrying one length-prefixed frame each way
(`src/pdf/engine-protocol.ts`). The request carries the original (at most
10 MiB) and the typed request (header at most 1 MiB). The reply carries the
copy (at most 20 MiB) and a small typed result. Neither side sends an
environment, a path or a credential. Each side stops reading at a declared
size over its cap. The sidecar drops a connection whose first bytes take more
than 5 s, or whose request takes more than 30 s, without a reply.

A missing socket, a dead sidecar, a malformed reply, or no reply within
330 s fails the job closed with `RetryableEngineError`. No copy is stored,
the file stays queued, and the next run takes it once the lease (600 s)
ends. After 5 such failures for one file (`MAX_ENGINE_ATTEMPTS`) the copies
are stored refused, with the fixed reason "the engine could not be reached
in 5 attempts". The count is kept in
the worker's memory, since no migration was allowed, so a restart starts it
again. If the engine itself fails on the file inside the sidecar (its child
crashed or ran past 300 s), or the request cannot be sent at all (over a
cap), the copy is refused, as it is in the pod.

What fc's manifest gives the sidecar container:

- its own `runAsUser` and `runAsGroup` (10002), different from the worker's;
- `runAsNonRoot: true`, `readOnlyRootFilesystem: true`,
  `allowPrivilegeEscalation: false`, capabilities `drop: [ALL]`;
- no env from Secrets (no `envFrom` secret, no `secretKeyRef`), no secret
  volume, and no service account token (`automountServiceAccountToken:
  false` on the pod);
- `shareProcessNamespace: false` and `enableServiceLinks: false` on the pod
  (with a shared namespace the sidecar would not be PID 1);
- an emptyDir mounted at `/run/pdf-engine` in the worker and this sidecar
  only, with the pod's `fsGroup` (10003) as the socket's shared group;
- no ports, and no egress: the pod's NetworkPolicy allows only what the
  worker needs, and the sidecar's uid gets no network;
- CPU and memory requests and limits;
- `command: ["node", "--disable-sigusr1", "dist/pdf/engine-sidecar.js"]` and
  no `args`, so node is PID 1 and dumb-init does not run (this reverses round
  1's `args`, for point 1 above);
- a uid (10002) no other workload on the node uses: RLIMIT_NPROC is counted per
  uid across the node, and with a limit of 1 the child can start nothing
  whatever the count, so this is hygiene, not what the limit rests on;
- in the worker, `PDF_ENGINE_SOCKET=/run/pdf-engine/engine.sock`.

### The gate sidecar

The output gate is re-run on every copy before `pdf_copy_put`
(`src/pdf/rerun.ts`), and never in the worker, which holds the database
login. A subverted engine's copy is attacker-made bytes, such as a Flate
stream that inflates to gigabytes, millions of strings or 100,000 pages, so
every check runs in a child forked for it alone (`src/pdf/gate-isolated.ts`).
The child has an empty environment, a 512 MiB heap, a watchdog that kills it
past 768 MiB resident, and a 120 s deadline, and its process group is killed
after it. A crash, a kill or a timeout means the copy is refused, never
passed.

With `PDF_GATE_SOCKET`, that child runs in a sidecar of its own:
`command: ["node", "--disable-sigusr1", "dist/pdf/gate-sidecar.js"]`
(`src/pdf/gate-service.ts`), uid 10004, its socket `/run/pdf-gate/gate.sock`
in an emptyDir only it and the worker mount, mode 0660, group 10003. It shares
the engine sidecar's code: the env allow-list, the directory rule (it will not
bind in `/run/pdf-engine`), the framing, caps and deadlines, PID 1, the no-fork
children, the namespace cleared and the socket checked before every reply, and
the socket watch. It logs why a check was unfinished (memory, deadline,
signal, crash or no-fork). Extra arguments: `--max-rss-mb <MiB>` (each child's
memory cap) and `--gate <module>` (another gate child; tests use it, and
production accepts it).

The worker sends the copy and its original with their sha256s, the quotes and
the picture policy. The gate refuses bytes that do not match their hash
before any child reads them. Its child reads the copy with pdf-lib, writes
it again with pdf-lib's writer (as the sanitizer does: no object streams, no
incremental update), and checks those bytes, read afresh. It replies with a
verdict naming the copy's sha256 and, on a pass, those bytes with their own
sha256 (fix round 3, M1). **What is stored is the gate's bytes, never the
engine's copy:** the worker stores them only on a pass naming the copy's hash,
once their sha256 is the one named. A pdf-lib reading and a viewer's reading
of the same bytes cannot then differ, whatever tricks the copy held. Anything
else stores a refused copy with a fixed reason per outcome (withheld text, a
broken rule, unfinished, other bytes). A missing or dead gate sidecar fails
the job closed and retryably, under the same cap of 5.

Without either socket (the in-pod mode) the worker forks the same capped
child itself. This is the pre-sidecar mode only: the child is still the
worker's uid, beside its login. With `PDF_ENGINE_SOCKET` set,
`PDF_GATE_SOCKET` is required, in another directory, or the worker refuses to
start.

Besides withheld text (`src/pdf/gate.ts`), the gate re-checks the
sanitizer's work on the copy (`src/pdf/gate-rules.ts`):

- no JavaScript, OpenAction, additional actions, Launch, URI or any other
  action, no embedded or attached file, no XFA, no AcroForm, no annotation
  (an empty annotation list is let through), no encryption;
- under "blur" or "hide", each picture is exactly what the policy draws
  (the 1 x 1 grey fill, or under "blur" a Flate grey or RGB picture at most
  24 pixels a side), with no inline picture in any content stream;
- no run of an original picture's samples is kept, and no picture has the
  very samples of an original that blurring would change;
- one reading (`src/pdf/pdf-structure.ts`, fix round 3): pdf-lib keeps the
  last definition of an object and ignores the xref, while a viewer follows
  the xref. So, as defence in depth beside storing the gate's own bytes, a
  copy is refused when it has more than one xref section or startxref, a
  trailer with anything beside `/Size` and `/Root`, an object defined twice,
  an xref entry that does not land on its object, or an object or xref
  stream. Every value a rule reads is resolved as a viewer resolves it, and
  `/S`, `/Subtype`, `/Type`, `/PatternType` or `/Filter` given by reference
  is refused.

Its limits, as for any text gate: text written so it does not read as text
(reversed, encoded, drawn as curves or as a picture); a picture rebuilt from
many small tiles or from vector shapes; a tiny inline picture of the
original (under 64 bytes) kept as a picture object; and a picture of a single
grey, which is its own blur and so may come through unchanged.

What fc's manifest gives the gate container: what the engine's gets, with
uid and gid 10004, its own emptyDir at `/run/pdf-gate` (never mounted in the
engine), limits of 1 CPU and 1Gi, `args: ["node", "dist/pdf/gate-sidecar.js"]`,
and in the worker `PDF_GATE_SOCKET=/run/pdf-gate/gate.sock`.

### The api-gate check

`.github/workflows/api-gate.yml` runs every test in `test/gates` on every push
and pull request, whatever it touches, as the check run `api-gate`, which the
branch ruleset requires. It has no paths filter, so it always reports. It runs
the tests on a throwaway Postgres, then `scripts/gate-results.ts` fails the job
unless every gate test file ran and every test passed: vitest alone passes a
skipped test, and the catalog test skips without its database.
`test/gates/api-gate-workflow.test.ts` fails if the workflow gains a filter, is
renamed, or stops running or checking the gate tests.

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
- yaml 2.9.1, a dev dependency, parses the workflows in the api-gate
  self-check.
- jose 6.2.13 verifies tokens (RS256 and ES256 only).
