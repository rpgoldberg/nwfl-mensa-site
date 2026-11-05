#!/bin/sh
# The built image, run as the officer's machine runs it, but every container with no network at all,
# so the smoke reaches no outside site: extract a synthetic PDF, check its links (only no-fetch links
# and a refused javascript: one, so a correct check needs no request), then list with an answer.
# Also: the image's own user is 65534 and it reads a world-readable PDF as that user.
#   sh scripts/smoke-image.sh <image>
set -eu
image=${1:?usage: smoke-image.sh <image>}
app=$(CDPATH='' cd -- "$(dirname -- "$0")/.." && pwd)
work=$(mktemp -d "${TMPDIR:-/tmp}/linkcheck-smoke.XXXXXX")
trap 'rm -rf "$work"' EXIT
mkdir "$work/out"
chmod 700 "$work/out"

user=$(docker inspect "$image" --format '{{.Config.User}}')
[ "$user" = "65534:65534" ] || { echo "smoke: the image runs as '$user', not 65534:65534" >&2; exit 1; }

# A synthetic issue, written by the tests' own PDF helper (Node strips its types).
(cd "$app" && node --input-type=module -e "
import { writeFileSync } from 'node:fs';
import { buildPdf, uriLink } from './test/helpers/pdf.ts';
const pdf = buildPdf([{ text: [{ x: 72, y: 700, str: 'Directory and a figure page' }], annots: [
  uriLink([72, 696, 150, 712], 'https://members.us.mensa.org/directory'),
  uriLink([160, 696, 250, 712], 'http://myfigurecollection.net/item/1'),
  uriLink([72, 600, 150, 612], 'javascript:alert(1)') ] }]);
writeFileSync('$work/public.pdf', pdf);
writeFileSync('$work/members.pdf', pdf);
")

harden="--rm --network none --read-only --cap-drop ALL --security-opt no-new-privileges --pids-limit 64 --cpus 1 --tmpfs /tmp:rw,noexec,nosuid,size=64m --user $(id -u):$(id -g)"
for audience in public members; do
  # shellcheck disable=SC2086
  docker run $harden --memory=1g --memory-swap=1g -v "$work/$audience.pdf:/in/file.pdf:ro" -v "$work/out:/out" "$image" \
    extract --audience "$audience" --in /in/file.pdf --out /out
done
# shellcheck disable=SC2086
docker run $harden --memory=512m --memory-swap=512m -v "$work/out:/out" "$image" \
  check --issue-date 2026-09-01 --out /out /out/extract-public.json /out/extract-members.json
printf '%s' '{"format":"nwfl-link-answers/1","answers":[{"url":"https://members.us.mensa.org/directory","keep":true}]}' > "$work/answers.json"
# shellcheck disable=SC2086
docker run $harden --memory=512m --memory-swap=512m -v "$work/out:/out" -v "$work/answers.json:/in/answers.json:ro" "$image" \
  list --check /out/check.json --public /out/extract-public.json --members /out/extract-members.json --answers /in/answers.json --out /out

node --input-type=module -e "
import { readFileSync } from 'node:fs';
const read = (f) => JSON.parse(readFileSync('$work/out/' + f, 'utf8'));
const fail = (m) => { console.error('smoke: ' + m); process.exit(1); };
const ex = read('extract-public.json');
if (ex.links.length !== 2 || ex.refused.length !== 1 || ex.refused[0].scheme !== 'javascript') fail('extract read the wrong links');
const check = read('check.json');
const got = check.results.map((r) => r.verdict + ' ' + r.reasons.join(',')).join('; ');
if (got !== 'review no-fetch; review no-fetch') fail('check gave ' + got);
const list = read('links.json');
if (list.links.public.length !== 1 || list.links.public[0].url !== 'https://members.us.mensa.org/directory' || list.links.public[0].confirm !== true) fail('list kept the wrong links');
if (!/^[a-z2-7]{26}$/.test(list.links.public[0].id) || !/^[0-9a-f]{64}$/.test(list.linksSha256)) fail('list wrote a bad id or hash');
console.log('smoke: extract, check and list passed offline; linksSha256 ' + list.linksSha256);
"

# The image's own user reads a PDF anyone may read.
cp "$work/public.pdf" "$work/world.pdf"
chmod 644 "$work/world.pdf"
docker run --rm --network none --read-only --cap-drop ALL --security-opt no-new-privileges --tmpfs /tmp:rw,size=64m,mode=1777 \
  -v "$work/world.pdf:/in/file.pdf:ro" "$image" extract --audience public --in /in/file.pdf --out /tmp
echo "smoke: passed"
