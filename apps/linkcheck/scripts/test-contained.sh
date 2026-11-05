#!/bin/sh
# The linkcheck suite, run only inside a capped container with no network: it parses PDFs and drives
# hostile inputs (the caps the coordinator set for any such test), and with --network none no test can
# reach a real outside site; the stand-in servers listen on the container's own loopback. The image is
# the Dockerfile's own digest-pinned node. /tmp allows exec only for test/linkcheck-script.test.ts's
# stand-in docker. apps/linkcheck is mounted at its own path (coverage/ is written there); the root is
# read-only. Arguments go to vitest run (--coverage, a file filter).
#   sh scripts/test-contained.sh [vitest args]
set -eu
app=$(CDPATH='' cd -- "$(dirname -- "$0")/.." && pwd)
image=$(sed -n 's/^ARG NODE_IMAGE=//p' "$app/Dockerfile")
[ -n "$image" ] || { echo "test-contained: no ARG NODE_IMAGE in the Dockerfile" >&2; exit 2; }
docker image inspect "$image" >/dev/null 2>&1 || docker pull --quiet "$image" >/dev/null
exec docker run --rm --name "nwfl-linkcheck-test-$$" \
  --memory=2g --memory-swap=2g --pids-limit=512 --cpus=2 --network none \
  --cap-drop ALL --security-opt no-new-privileges --read-only --tmpfs /tmp:rw,exec,size=256m \
  --user "$(id -u):$(id -g)" -e HOME=/tmp -e CI="${CI:-}" -e NO_COLOR=1 \
  -v "$app:$app" -w "$app" \
  --entrypoint node "$image" node_modules/vitest/vitest.mjs run "$@"
