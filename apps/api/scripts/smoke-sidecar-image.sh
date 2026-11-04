#!/bin/sh
# ============================================================================
# smoke-sidecar-image.sh - run both PDF sidecars, the engine and the output
# gate, from the production image the way the worker pod does
# (UNTRUSTED-PDF-GATE; README, "The engine sidecar" and "The gate sidecar").
#
#   sh scripts/smoke-sidecar-image.sh <image>
#
# Two throwaway volumes stand in for the pod's two emptyDirs, /run/pdf-engine
# and /run/pdf-gate: root-owned, group 10003 (the pod's fsGroup) with the
# setgid bit, as the kubelet leaves them. Then, every container with a
# read-only root, no capabilities, no privilege escalation and no network,
# each sidecar run as fc's manifest runs it (fix round 2): `command`, so
# --entrypoint node here, with --disable-sigusr1, and node is PID 1:
#   1. each sidecar refuses to start (exit 2) with a name off its allow-list
#      in its env: PGPASSWORD for the engine, DB_PASSWORD for the gate;
#   2. each refuses to start (exit 2) behind the image's dumb-init (args
#      only: not PID 1) and without --disable-sigusr1 (NODE_ENV=production),
#      and the gate refuses to bind in /run/pdf-engine;
#   3. the engine, uid 10002, and the gate, uid 10004, each plus group 10003,
#      listen as PID 1; each socket is mode 660, group 10003;
#   4. a worker, uid 10001 plus 10003, mounting both, gets a redacted copy of
#      a real PDF with PDF_ENGINE_SOCKET and PDF_GATE_SOCKET (the gate re-run
#      in the gate sidecar), and the gate sidecar refuses a marked copy: the
#      real children, each unable to start a process (prlimit, no-fork.ts);
#   5. a stranger, uid 10005 without the group, is refused at both sockets;
#   6. SIGTERM stops each sidecar with exit 0;
#   7. node is non-dumpable (0711, fix round 3, S6): a process of the same uid
#      opens another node process's /proc status, never its environ or mem.
# The sidecars run with --no-healthcheck (N3): Kubernetes runs no HEALTHCHECK,
# and any process exec'd into a sidecar's namespace makes it exit 1 (pidns.ts).
# Everything it started is removed by recorded id or name, pass or fail.
# ============================================================================
set -eu

IMAGE_UNDER_TEST=${1:?usage: smoke-sidecar-image.sh <image>}
suffix=$(od -An -N6 -tx1 /dev/urandom | tr -d ' \n')
engine_vol=nwfl-smoke-engine-$suffix
gate_vol=nwfl-smoke-gate-$suffix
engine=
gate=
ENGINE_SOCK=/run/pdf-engine/engine.sock
GATE_SOCK=/run/pdf-gate/gate.sock
LOCKED='--read-only --cap-drop ALL --security-opt no-new-privileges --network none'
AS_ENGINE="--user 10002:10002 --group-add 10003 -v $engine_vol:/run/pdf-engine"
AS_GATE="--user 10004:10004 --group-add 10003 -v $gate_vol:/run/pdf-gate"
# As fc's manifest's `command` runs each sidecar: node is the entrypoint, so it is PID 1; and no
# HEALTHCHECK, which docker would exec inside it (N3).
AS_PID1='--no-healthcheck --entrypoint node'

cleanup() {
  for id in $engine $gate; do
    docker logs "$id" 2>&1 | tail -20 || true
    docker rm -f "$id" >/dev/null 2>&1 || true
  done
  docker volume rm "$engine_vol" "$gate_vol" >/dev/null 2>&1 || true
}
trap cleanup EXIT

for pair in "$engine_vol:/run/pdf-engine" "$gate_vol:/run/pdf-gate"; do
  docker volume create "${pair%%:*}" >/dev/null
  docker run --rm --user 0:0 --network none -v "$pair" --entrypoint sh "$IMAGE_UNDER_TEST" \
    -c "chown 0:10003 ${pair#*:} && chmod 2770 ${pair#*:}"
done

# refuses <what> <expected log text> <docker run arguments...>: the container exits 2, saying so.
refuses() {
  what=$1
  says=$2
  shift 2
  if out=$(docker run --rm "$@" 2>&1); then
    echo "smoke-sidecar: started ($what)" >&2; exit 1
  else
    code=$?
    [ "$code" = 2 ] || { printf '%s\n' "$out" >&2; echo "smoke-sidecar: expected exit 2 ($what), got $code" >&2; exit 1; }
  fi
  printf '%s\n' "$out" | grep -q -- "$says" || { printf '%s\n' "$out" >&2; echo "smoke-sidecar: no \"$says\" ($what)" >&2; exit 1; }
  echo "smoke-sidecar: refused ($what, exit 2)"
}

# 1. A name off the allow-list in its env.
# shellcheck disable=SC2086
refuses 'engine, PGPASSWORD' 'its environment holds PGPASSWORD' $LOCKED $AS_ENGINE -e PGPASSWORD=smoke-not-a-secret \
  $AS_PID1 "$IMAGE_UNDER_TEST" --disable-sigusr1 dist/pdf/engine-sidecar.js
# shellcheck disable=SC2086
refuses 'gate, DB_PASSWORD' 'its environment holds DB_PASSWORD' $LOCKED $AS_GATE -e DB_PASSWORD=smoke-not-a-secret \
  $AS_PID1 "$IMAGE_UNDER_TEST" --disable-sigusr1 dist/pdf/gate-sidecar.js

# 2. Behind dumb-init (args only), without --disable-sigusr1, and the gate's socket in the engine's directory.
# shellcheck disable=SC2086
refuses 'engine behind dumb-init' 'must be PID 1 of its container' $LOCKED $AS_ENGINE "$IMAGE_UNDER_TEST" node --disable-sigusr1 dist/pdf/engine-sidecar.js
# shellcheck disable=SC2086
refuses 'gate behind dumb-init' 'must be PID 1 of its container' $LOCKED $AS_GATE "$IMAGE_UNDER_TEST" node --disable-sigusr1 dist/pdf/gate-sidecar.js
# shellcheck disable=SC2086
refuses 'engine without --disable-sigusr1' 'will not start without --disable-sigusr1' $LOCKED $AS_ENGINE $AS_PID1 "$IMAGE_UNDER_TEST" dist/pdf/engine-sidecar.js
# shellcheck disable=SC2086
refuses 'gate without --disable-sigusr1' 'will not start without --disable-sigusr1' $LOCKED $AS_GATE $AS_PID1 "$IMAGE_UNDER_TEST" dist/pdf/gate-sidecar.js
# shellcheck disable=SC2086
refuses 'gate in /run/pdf-engine' 'directly in /run/pdf-gate' $LOCKED $AS_GATE -v "$engine_vol:/run/pdf-engine" \
  $AS_PID1 "$IMAGE_UNDER_TEST" --disable-sigusr1 dist/pdf/gate-sidecar.js --socket /run/pdf-engine/gate.sock

# 3. Both listen as PID 1, 660, group 10003.
# shellcheck disable=SC2086
engine=$(docker run -d $LOCKED $AS_ENGINE $AS_PID1 "$IMAGE_UNDER_TEST" --disable-sigusr1 dist/pdf/engine-sidecar.js)
# shellcheck disable=SC2086
gate=$(docker run -d $LOCKED $AS_GATE $AS_PID1 "$IMAGE_UNDER_TEST" --disable-sigusr1 dist/pdf/gate-sidecar.js)
for pair in "$engine:engine sidecar listening (PID 1: clearing" "$gate:gate sidecar listening (PID 1: clearing"; do
  tries=0
  until docker logs "${pair%%:*}" 2>&1 | grep -q -F "${pair#*:}"; do
    tries=$((tries + 1))
    [ "$tries" -lt 60 ] || { echo "smoke-sidecar: no \"${pair#*:}\"" >&2; exit 1; }
    sleep 0.5
  done
done
for pair in "$engine_vol:/run/pdf-engine:$ENGINE_SOCK" "$gate_vol:/run/pdf-gate:$GATE_SOCK"; do
  vol=${pair%%:*}
  rest=${pair#*:}
  # shellcheck disable=SC2086
  mode=$(docker run --rm $LOCKED --user 10001:10001 --group-add 10003 -v "$vol:${rest%%:*}" --entrypoint stat \
    "$IMAGE_UNDER_TEST" -c '%a %g %F' "${rest#*:}")
  echo "smoke-sidecar: ${rest#*:} ${mode}"
  [ "$mode" = "660 10003 socket" ] || { echo "smoke-sidecar: expected 660 10003 socket" >&2; exit 1; }
done

# 4. The worker gets a redacted copy, which the gate sidecar passes; a marked copy it refuses.
CLIENT=$(cat <<'EOF'
import { PDFDocument, StandardFonts } from '@cantoo/pdf-lib';
import { sha256Hex } from './dist/pdf/engine-protocol.js';
import { checkCopy } from './dist/pdf/gate.js';
import { withoutCanvasWarnings } from './dist/pdf/isolated.js';
import { socketGate } from './dist/pdf/socket-gate.js';
import { workerRedact } from './dist/pdf/worker.js';
console.warn = withoutCanvasWarnings(console.warn.bind(console));
const [engineSocket, gateSocket] = process.argv.slice(1);
const doc = await PDFDocument.create({ updateMetadata: false });
const page = doc.addPage([612, 792]);
const font = await doc.embedFont(StandardFonts.Helvetica);
page.drawText('Picnic flyer', { x: 72, y: 720, size: 12, font });
page.drawText('Rides: call Kestrel Ambry.', { x: 72, y: 700, size: 12, font });
const original = await doc.save({ useObjectStreams: false });
// The worker's own engine: the two sockets pick the engine sidecar, and the gate re-run in the gate sidecar.
const env = { PDF_ENGINE_SOCKET: engineSocket, PDF_GATE_SOCKET: gateSocket };
const result = await workerRedact(env, {})(original, { quotes: ['Kestrel Ambry'], redactsAny: true });
if (result.kind !== 'redacted') throw new Error(`expected a copy, got ${result.kind}: ${result.reason}`);
const left = await checkCopy(result.pdf, ['Kestrel Ambry']);
if (left !== null) throw new Error(`the copy still holds the mark: ${left}`);
console.log(`smoke-sidecar: redacted copy, ${result.pdf.byteLength} bytes, gate sidecar passed it`);
const marked = await socketGate({ path: gateSocket })({ copy: original, original, quotes: ['Kestrel Ambry'], image: 'show', sha256: sha256Hex(original) });
if (marked.verdict.pass || marked.verdict.code !== 'withheld' || marked.sha256 !== sha256Hex(original)) throw new Error(`the gate sidecar passed a marked copy: ${JSON.stringify(marked)}`);
console.log('smoke-sidecar: gate sidecar refused a marked copy (withheld)');
EOF
)
# A failure exits here (set -e on the assignment).
# shellcheck disable=SC2086
out=$(docker run --rm $LOCKED --user 10001:10001 --group-add 10003 -v "$engine_vol:/run/pdf-engine" -v "$gate_vol:/run/pdf-gate" \
  "$IMAGE_UNDER_TEST" node --input-type=module -e "$CLIENT" "$ENGINE_SOCK" "$GATE_SOCK" 2>&1)
printf '%s\n' "$out"
printf '%s\n' "$out" | grep -q 'gate sidecar passed it' || { echo "smoke-sidecar: no redacted copy" >&2; exit 1; }
printf '%s\n' "$out" | grep -q 'refused a marked copy' || { echo "smoke-sidecar: the marked copy was not refused" >&2; exit 1; }

# 5. A uid without the group cannot connect to either.
for pair in "$engine_vol:/run/pdf-engine:$ENGINE_SOCK" "$gate_vol:/run/pdf-gate:$GATE_SOCK"; do
  vol=${pair%%:*}
  rest=${pair#*:}
  # shellcheck disable=SC2086
  stranger=$(docker run --rm $LOCKED --user 10005:10005 -v "$vol:${rest%%:*}" "$IMAGE_UNDER_TEST" \
    node -e "require('net').createConnection(process.argv[1]).on('connect', () => { console.log('connected'); process.exit(0); }).on('error', (e) => { console.log(e.code); process.exit(0); })" "${rest#*:}")
  echo "smoke-sidecar: a stranger at ${rest#*:} gets ${stranger}"
  [ "$stranger" = EACCES ] || { echo "smoke-sidecar: expected EACCES for a stranger" >&2; exit 1; }
done

# 6. SIGTERM: exit 0, each.
for id in "$engine" "$gate"; do
  docker stop --time 10 "$id" >/dev/null
  code=$(docker inspect "$id" --format '{{.State.ExitCode}}')
  [ "$code" = 0 ] || { echo "smoke-sidecar: exit ${code} after SIGTERM" >&2; exit 1; }
done
echo "smoke-sidecar: both stopped on SIGTERM (exit 0)"

# 7. node is non-dumpable: a node process of the same uid (10001) cannot open another's environ or mem.
PEEK=$(cat <<'EOF'
const { spawn } = require('node:child_process');
const fs = require('node:fs');
const target = spawn(process.execPath, ['-e', 'setTimeout(() => {}, 5000)'], { stdio: 'ignore', env: { SMOKE_CANARY: 'smoke-not-a-secret' } });
const open = (file) => {
  try {
    fs.closeSync(fs.openSync(`/proc/${target.pid}/${file}`, 'r'));
    return 'open';
  } catch (error) {
    return error.code;
  }
};
target.once('spawn', () => setTimeout(() => {
  console.log(`status=${open('status')} environ=${open('environ')} mem=${open('mem')}`);
  target.kill('SIGKILL');
}, 500));
EOF
)
# shellcheck disable=SC2086
dump=$(docker run --rm $LOCKED --user 10001:10001 --entrypoint node "$IMAGE_UNDER_TEST" -e "$PEEK")
echo "smoke-sidecar: a node process of the same uid: $dump"
[ "$dump" = "status=open environ=EACCES mem=EACCES" ] || { echo "smoke-sidecar: node is not non-dumpable" >&2; exit 1; }
