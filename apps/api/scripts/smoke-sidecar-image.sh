#!/bin/sh
# ============================================================================
# smoke-sidecar-image.sh - run the PDF engine sidecar from the production image
# the way the worker pod does (UNTRUSTED-PDF-GATE; README, "The engine sidecar").
#
#   sh scripts/smoke-sidecar-image.sh <image>
#
# A throwaway volume stands in for the pod's emptyDir: root-owned, group 10003
# (the pod's fsGroup) with the setgid bit, as the kubelet leaves it. Then, every
# container with a read-only root, no capabilities, no privilege escalation and
# no network at all:
#   1. the sidecar refuses to start (exit 2) with PGPASSWORD in its env;
#   2. the sidecar, uid 10002 and group 10002 plus 10003, listens, and its
#      socket is mode 660, group 10003;
#   3. a worker, uid 10001 plus group 10003, gets a redacted copy of a real PDF
#      through the socket with PDF_ENGINE_SOCKET (the gate re-run included),
#      and the output gate finds no marked text in it;
#   4. a stranger, uid 10005 without the group, is refused at the socket;
#   5. SIGTERM stops the sidecar with exit 0.
# Everything it started is removed by recorded id or name, pass or fail.
# ============================================================================
set -eu

IMAGE_UNDER_TEST=${1:?usage: smoke-sidecar-image.sh <image>}
suffix=$(od -An -N6 -tx1 /dev/urandom | tr -d ' \n')
vol=nwfl-smoke-engine-$suffix
sidecar=
SOCK=/run/pdf-engine/engine.sock
LOCKED='--read-only --cap-drop ALL --security-opt no-new-privileges --network none'

cleanup() {
  if [ -n "$sidecar" ]; then
    docker logs "$sidecar" 2>&1 | tail -20 || true
    docker rm -f "$sidecar" >/dev/null 2>&1 || true
  fi
  docker volume rm "$vol" >/dev/null 2>&1 || true
}
trap cleanup EXIT

docker volume create "$vol" >/dev/null
docker run --rm --user 0:0 --network none -v "$vol:/run/pdf-engine" --entrypoint sh "$IMAGE_UNDER_TEST" \
  -c 'chown 0:10003 /run/pdf-engine && chmod 2770 /run/pdf-engine'

# 1. A credential in its env: it will not start.
# shellcheck disable=SC2086
if docker run --rm $LOCKED --user 10002:10002 --group-add 10003 -v "$vol:/run/pdf-engine" \
  -e PGPASSWORD=smoke-not-a-secret "$IMAGE_UNDER_TEST" node dist/pdf/engine-sidecar.js; then
  echo "smoke-sidecar: started with PGPASSWORD in its env" >&2; exit 1
else
  code=$?
  [ "$code" = 2 ] || { echo "smoke-sidecar: expected exit 2 for PGPASSWORD, got $code" >&2; exit 1; }
fi
echo "smoke-sidecar: refused PGPASSWORD (exit 2)"

# 2. It listens, 660, group 10003.
# shellcheck disable=SC2086
sidecar=$(docker run -d $LOCKED --user 10002:10002 --group-add 10003 -v "$vol:/run/pdf-engine" \
  "$IMAGE_UNDER_TEST" node dist/pdf/engine-sidecar.js)
tries=0
until docker logs "$sidecar" 2>&1 | grep -q 'engine sidecar listening'; do
  tries=$((tries + 1))
  [ "$tries" -lt 60 ] || { echo "smoke-sidecar: the sidecar did not listen" >&2; exit 1; }
  sleep 0.5
done
# shellcheck disable=SC2086
mode=$(docker run --rm $LOCKED --user 10001:10001 --group-add 10003 -v "$vol:/run/pdf-engine" --entrypoint stat \
  "$IMAGE_UNDER_TEST" -c '%a %g %F' "$SOCK")
echo "smoke-sidecar: socket ${mode}"
[ "$mode" = "660 10003 socket" ] || { echo "smoke-sidecar: expected 660 10003 socket" >&2; exit 1; }

# 3. The worker gets a redacted copy, which the output gate passes.
CLIENT=$(cat <<'EOF'
import { PDFDocument, StandardFonts } from '@cantoo/pdf-lib';
import { withoutCanvasWarnings } from './dist/pdf/isolated.js';
import { workerRedact } from './dist/pdf/worker.js';
import { checkCopy } from './dist/pdf/gate.js';
console.warn = withoutCanvasWarnings(console.warn.bind(console));
const doc = await PDFDocument.create({ updateMetadata: false });
const page = doc.addPage([612, 792]);
const font = await doc.embedFont(StandardFonts.Helvetica);
page.drawText('Picnic flyer', { x: 72, y: 720, size: 12, font });
page.drawText('Rides: call Kestrel Ambry.', { x: 72, y: 700, size: 12, font });
const original = await doc.save({ useObjectStreams: false });
// The worker's own engine: PDF_ENGINE_SOCKET picks the sidecar, and the output gate is re-run here.
const result = await workerRedact({ PDF_ENGINE_SOCKET: process.argv[1] }, {})(original, { quotes: ['Kestrel Ambry'], redactsAny: true });
if (result.kind !== 'redacted') throw new Error(`expected a copy, got ${result.kind}`);
const left = await checkCopy(result.pdf, ['Kestrel Ambry']);
if (left !== null) throw new Error(`the copy still holds the mark: ${left}`);
console.log(`smoke-sidecar: redacted copy, ${result.pdf.byteLength} bytes, gate passed`);
EOF
)
# A failure exits here (set -e on the assignment).
# shellcheck disable=SC2086
out=$(docker run --rm $LOCKED --user 10001:10001 --group-add 10003 -v "$vol:/run/pdf-engine" \
  "$IMAGE_UNDER_TEST" node --input-type=module -e "$CLIENT" "$SOCK" 2>&1)
printf '%s\n' "$out"
printf '%s\n' "$out" | grep -q 'gate passed' || { echo "smoke-sidecar: no redacted copy" >&2; exit 1; }

# 4. A uid without the group cannot connect.
# shellcheck disable=SC2086
stranger=$(docker run --rm $LOCKED --user 10005:10005 -v "$vol:/run/pdf-engine" "$IMAGE_UNDER_TEST" \
  node -e "require('net').createConnection(process.argv[1]).on('connect', () => { console.log('connected'); process.exit(0); }).on('error', (e) => { console.log(e.code); process.exit(0); })" "$SOCK")
echo "smoke-sidecar: a stranger gets ${stranger}"
[ "$stranger" = EACCES ] || { echo "smoke-sidecar: expected EACCES for a stranger" >&2; exit 1; }

# 5. SIGTERM: exit 0.
docker stop --time 10 "$sidecar" >/dev/null
code=$(docker inspect "$sidecar" --format '{{.State.ExitCode}}')
[ "$code" = 0 ] || { echo "smoke-sidecar: exit ${code} after SIGTERM" >&2; exit 1; }
echo "smoke-sidecar: stopped on SIGTERM (exit 0)"
