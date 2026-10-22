#!/bin/sh
# ============================================================================
# test-db.sh - a THROWAWAY Postgres for the live test suites, local and CI.
#
#   sh scripts/test-db.sh start        prints NWFL_TEST_PG_CONTAINER=<id> and
#                                      NWFL_TEST_DATABASE_URL=<superuser url>
#   sh scripts/test-db.sh stop <id>    removes exactly that container
#
# The image is postgres:17-alpine pinned by digest: the estate's CNPG clusters
# run 17, and the migration Job runs psql from this same image. The repo is
# mounted read-only at /repo, so a test can run scripts/migrate.sh with the
# container's own psql (docker exec) instead of needing one on the host.
#
# Network: fc-test when it exists (the WSL box, whose default bridge cannot
# resolve), else the default bridge (CI). The port is published on loopback
# only. The superuser password is random per run and never written to disk.
# Teardown is by the recorded container id, never by name or pattern.
# ============================================================================
set -eu

IMAGE=postgres:17-alpine@sha256:eee6c6e1b0894fa4fe0075eb054af9fd1cf39a35321c2d4110626cfe506411fb
ROOT=$(CDPATH= cd -- "$(dirname -- "$0")/.." && pwd)

case ${1:-} in
  start)
    if docker network inspect fc-test >/dev/null 2>&1; then net=fc-test; else net=bridge; fi
    pw=$(od -An -N16 -tx1 /dev/urandom | tr -d ' \n')
    id=$(docker run -d --network "$net" -p 127.0.0.1::5432 \
      -e POSTGRES_PASSWORD="$pw" -v "$ROOT:/repo:ro" "$IMAGE")
    # The entrypoint's init server listens on the socket only, so a TCP probe
    # answers only once the real server is up.
    tries=0
    until docker exec "$id" pg_isready -q -h 127.0.0.1 -U postgres; do
      tries=$((tries + 1))
      if [ "$tries" -ge 60 ]; then docker rm -f "$id" >/dev/null; echo "test-db: postgres did not start" >&2; exit 1; fi
      sleep 0.5
    done
    port=$(docker port "$id" 5432/tcp | head -1 | sed 's/.*://')
    echo "NWFL_TEST_PG_CONTAINER=$id"
    echo "NWFL_TEST_DATABASE_URL=postgres://postgres:$pw@127.0.0.1:$port/postgres"
    ;;
  stop)
    id=${2:?usage: test-db.sh stop <container-id>}
    docker rm -f "$id" >/dev/null
    echo "test-db: removed $id"
    ;;
  *)
    echo "usage: test-db.sh start | stop <container-id>" >&2
    exit 2
    ;;
esac
