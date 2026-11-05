#!/bin/sh
# One issue's link check, on the officer's own machine only (never in a cluster), as three containers
# from the one image (SPEC D4). Each runs read-only, with no capabilities, no new privileges, a pid,
# CPU and memory cap and a small tmpfs /tmp, as the invoking (non-root) user so the output folder can
# stay private (0700):
#   extract  --network none, --memory=1g: the only container that sees a PDF, mounted read-only;
#   check    --dns 1.1.1.1, --memory=512m: a network, but no PDF (only the extract files);
#   list     --network none: Ross's answers in, links.json out.
#
#   linkcheck.sh check <image> <issue-date YYYY-MM-DD> <public.pdf> <members.pdf> <out-dir>
#   linkcheck.sh list <image> <out-dir> [<answers.json>]
# Give the image by digest (ghcr.io/...@sha256:...), as printed by CI.
set -eu
umask 077

usage() {
  echo "usage: linkcheck.sh check <image> <issue-date> <public.pdf> <members.pdf> <out-dir>" >&2
  echo "       linkcheck.sh list <image> <out-dir> [<answers.json>]" >&2
  exit 2
}

[ "$(id -u)" != "0" ] || { echo "linkcheck.sh: run it as yourself, not as root" >&2; exit 2; }
[ $# -ge 3 ] || usage
mode=$1 image=$2
shift 2

abs() { (CDPATH='' cd -- "$(dirname -- "$1")" && printf '%s/%s\n' "$(pwd)" "$(basename -- "$1")"); }

harden() {
  printf '%s\n' --rm --read-only --cap-drop ALL --security-opt no-new-privileges \
    --pids-limit 64 --cpus 1 --tmpfs /tmp:rw,noexec,nosuid,size=64m --user "$(id -u):$(id -g)"
}

case $mode in
  check)
    [ $# -eq 4 ] || usage
    date=$1 public=$(abs "$2") members=$(abs "$3") out=$4
    case $date in [0-9][0-9][0-9][0-9]-[0-1][0-9]-[0-3][0-9]) ;; *) usage ;; esac
    [ -f "$public" ] && [ -f "$members" ] || { echo "linkcheck.sh: both PDFs must exist" >&2; exit 2; }
    mkdir -p -- "$out"
    out=$(CDPATH='' cd -- "$out" && pwd)
    for audience in public members; do
      if [ "$audience" = public ]; then pdf=$public; else pdf=$members; fi
      # shellcheck disable=SC2046 # harden prints one flag per line, none with spaces
      docker run $(harden) --network none --memory=1g --memory-swap=1g \
        -v "$pdf:/in/file.pdf:ro" -v "$out:/out" "$image" \
        extract --audience "$audience" --in /in/file.pdf --out /out
    done
    # shellcheck disable=SC2046
    docker run $(harden) --dns 1.1.1.1 --memory=512m --memory-swap=512m \
      -v "$out:/out" "$image" \
      check --issue-date "$date" --out /out /out/extract-public.json /out/extract-members.json
    ;;
  list)
    [ $# -ge 1 ] && [ $# -le 2 ] || usage
    out=$(CDPATH='' cd -- "$1" && pwd)
    if [ $# -eq 2 ]; then
      answers=$(abs "$2")
      # shellcheck disable=SC2046
      docker run $(harden) --network none --memory=512m --memory-swap=512m \
        -v "$out:/out" -v "$answers:/in/answers.json:ro" "$image" \
        list --check /out/check.json --public /out/extract-public.json --members /out/extract-members.json --answers /in/answers.json --out /out
    else
      # shellcheck disable=SC2046
      docker run $(harden) --network none --memory=512m --memory-swap=512m \
        -v "$out:/out" "$image" \
        list --check /out/check.json --public /out/extract-public.json --members /out/extract-members.json --out /out
    fi
    ;;
  *) usage ;;
esac
