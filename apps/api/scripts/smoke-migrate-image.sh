#!/bin/sh
# ============================================================================
# smoke-migrate-image.sh - run the migration image against a throwaway Postgres.
#
#   sh scripts/smoke-migrate-image.sh <image>
#
# Starts postgres:17-alpine (the same digest as test-db.sh) with the two roles
# 0000_grants.sql expects, then runs <image> the way the cluster's Job does:
# read-only root filesystem, /tmp as the only writable mount, no capabilities,
# no privilege escalation. Run 1 must apply every migration; run 2 must apply
# none. Exit 0 only if both hold. Everything it started is removed by recorded
# id or name on the way out, pass or fail.
#
# Network: fc-test when it exists (the WSL box, whose default bridge cannot
# resolve), else a throwaway user-defined network, so the Job container can
# reach the database by name.
# ============================================================================
set -eu

IMAGE_UNDER_TEST=${1:?usage: smoke-migrate-image.sh <image>}
PG_IMAGE=postgres:17-alpine@sha256:eee6c6e1b0894fa4fe0075eb054af9fd1cf39a35321c2d4110626cfe506411fb
ROOT=$(CDPATH= cd -- "$(dirname -- "$0")/.." && pwd)
want=$(ls "$ROOT"/migrations/[0-9][0-9][0-9][0-9]_*.sql | wc -l | tr -d ' ')

suffix=$(od -An -N6 -tx1 /dev/urandom | tr -d ' \n')
pw=$(od -An -N16 -tx1 /dev/urandom | tr -d ' \n')
name=nwfl-smoke-pg-$suffix
made_net=
pg=

cleanup() {
  [ -z "$pg" ] || docker rm -f "$pg" >/dev/null 2>&1 || true
  [ -z "$made_net" ] || docker network rm "$made_net" >/dev/null 2>&1 || true
}
trap cleanup EXIT

if docker network inspect fc-test >/dev/null 2>&1; then
  net=fc-test
else
  net=nwfl-smoke-net-$suffix
  docker network create "$net" >/dev/null
  made_net=$net
fi

pg=$(docker run -d --network "$net" --name "$name" -e POSTGRES_PASSWORD="$pw" "$PG_IMAGE")
tries=0
until docker exec "$pg" pg_isready -q -h 127.0.0.1 -U postgres; do
  tries=$((tries + 1))
  [ "$tries" -lt 60 ] || { echo "smoke: postgres did not start" >&2; exit 1; }
  sleep 0.5
done

# Roles as the cluster has them: the migrator owns the database, nwfl is the app role.
docker exec "$pg" psql -X -q -v ON_ERROR_STOP=1 -U postgres -h 127.0.0.1 \
  -c "CREATE ROLE nwfl LOGIN" \
  -c "CREATE ROLE nwfl_migrator LOGIN PASSWORD '$pw'" \
  -c "CREATE DATABASE nwfl_smoke OWNER nwfl_migrator"

job() {
  docker run --rm --network "$net" --read-only --tmpfs /tmp --cap-drop ALL \
    --security-opt no-new-privileges \
    -e PGHOST="$name" -e PGDATABASE=nwfl_smoke -e PGUSER=nwfl_migrator -e PGPASSWORD="$pw" \
    "$IMAGE_UNDER_TEST"
}

echo "smoke: run 1 (expect applied=$want skipped=0)"
out=$(job) || { printf '%s\n' "$out"; echo "smoke: run 1 failed" >&2; exit 1; }
printf '%s\n' "$out"
printf '%s\n' "$out" | grep -q "done — applied=$want skipped=0 " || { echo "smoke: run 1 did not apply all $want" >&2; exit 1; }

echo "smoke: run 2 (expect applied=0 skipped=$want)"
out=$(job) || { printf '%s\n' "$out"; echo "smoke: run 2 failed" >&2; exit 1; }
printf '%s\n' "$out"
printf '%s\n' "$out" | grep -q "done — applied=0 skipped=$want " || { echo "smoke: run 2 was not a no-op" >&2; exit 1; }

echo "smoke: ok"
