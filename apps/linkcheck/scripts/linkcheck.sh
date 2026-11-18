#!/bin/sh
# One issue's link check, on the officer's own machine only (never in a cluster), as three containers
# from the one image (SPEC D4). Each runs read-only, with no capabilities, no new privileges, a pid,
# CPU and memory cap and a small tmpfs /tmp, as the invoking (non-root) user so the output folder can
# stay private (0700):
#   extract  --network none, --memory=1g: the only container that sees a PDF, mounted read-only;
#   check    --dns 1.1.1.1, --memory=512m: a network, but no PDF (only the extract files);
#   replace  --dns 1.1.1.1, --memory=512m: the different links in the answers checked (no PDF);
#   list     --network none: the editor's answers in, links.json and remember.json out.
# And one container for the officers' pieces (L-ITEM), which sees no PDF and no folder of the machine:
#   items    --dns 1.1.1.1, --memory=512m: the links that wait, from the API and back; counts only.
#            The service account's app password is a file only its owner can read, mounted read-only
#            at /in/password: it is in no argument and no environment value.
# A remember file (LINKS-REMEMBER) is mounted read-only; the list step's new remember.json is copied
# back over it, so the next issue's check fills in the same answers. It need not exist on the first issue.
#
#   linkcheck.sh check <image> <issue-date YYYY-MM-DD> <public.pdf> <members.pdf> <out-dir> [<remember.json>]
#   linkcheck.sh list <image> <out-dir> [<answers.json> [<remember.json>]]
#   linkcheck.sh items <image>     (LINKCHECK_API_URL, LINKCHECK_TOKEN_URL and LINKCHECK_PASSWORD_FILE in the
#                                  environment, and optionally LINKCHECK_CLIENT_ID, LINKCHECK_USERNAME, LINKCHECK_SCOPE
#                                  and LINKCHECK_CID_FILE, a file docker writes the container's id to)
# Give the image by digest (ghcr.io/...@sha256:...), as printed by CI; items runs nothing else.
set -eu
umask 077

usage() {
  echo "usage: linkcheck.sh check <image> <issue-date> <public.pdf> <members.pdf> <out-dir> [<remember.json>]" >&2
  echo "       linkcheck.sh list <image> <out-dir> [<answers.json> [<remember.json>]]" >&2
  echo "       linkcheck.sh items <image>" >&2
  exit 2
}

[ "$(id -u)" != "0" ] || { echo "linkcheck.sh: run it as yourself, not as root" >&2; exit 2; }
[ $# -ge 2 ] || usage
mode=$1 image=$2
shift 2

abs() { (CDPATH='' cd -- "$(dirname -- "$1")" && printf '%s/%s\n' "$(pwd)" "$(basename -- "$1")"); }

# The remember file's absolute path; its folder must exist (the file need not, on the first issue).
remembered() {
  [ -d "$(dirname -- "$1")" ] || { echo "linkcheck.sh: the folder for $1 does not exist" >&2; exit 2; }
  abs "$1"
}

harden() {
  printf '%s\n' --rm --read-only --cap-drop ALL --security-opt no-new-privileges \
    --pids-limit 64 --cpus 1 --tmpfs /tmp:rw,noexec,nosuid,size=64m --user "$(id -u):$(id -g)"
}

case $mode in
  check)
    [ $# -ge 4 ] && [ $# -le 5 ] || usage
    date=$1 public=$(abs "$2") members=$(abs "$3") out=$4 memory=
    case $date in [0-9][0-9][0-9][0-9]-[0-1][0-9]-[0-3][0-9]) ;; *) usage ;; esac
    [ -f "$public" ] && [ -f "$members" ] || { echo "linkcheck.sh: both PDFs must exist" >&2; exit 2; }
    if [ $# -eq 5 ]; then
      memory=$(remembered "$5")
      [ -f "$memory" ] || { echo "linkcheck.sh: no remember file yet at $memory; step 8 writes it" >&2; memory=; }
    fi
    mkdir -p -- "$out"
    out=$(CDPATH='' cd -- "$out" && pwd)
    for audience in public members; do
      if [ "$audience" = public ]; then pdf=$public; else pdf=$members; fi
      # shellcheck disable=SC2046 # harden prints one flag per line, none with spaces
      docker run $(harden) --network none --memory=1g --memory-swap=1g \
        -v "$pdf:/in/file.pdf:ro" -v "$out:/out" "$image" \
        extract --audience "$audience" --in /in/file.pdf --out /out
    done
    if [ -n "$memory" ]; then
      # shellcheck disable=SC2046
      docker run $(harden) --dns 1.1.1.1 --memory=512m --memory-swap=512m \
        -v "$out:/out" -v "$memory:/in/remember.json:ro" "$image" \
        check --issue-date "$date" --remember /in/remember.json --out /out /out/extract-public.json /out/extract-members.json
    else
      # shellcheck disable=SC2046
      docker run $(harden) --dns 1.1.1.1 --memory=512m --memory-swap=512m \
        -v "$out:/out" "$image" \
        check --issue-date "$date" --out /out /out/extract-public.json /out/extract-members.json
    fi
    ;;
  list)
    [ $# -ge 1 ] && [ $# -le 3 ] || usage
    out=$(CDPATH='' cd -- "$1" && pwd)
    if [ $# -ge 2 ]; then
      answers=$(abs "$2") memory=
      [ -f "$answers" ] || { echo "linkcheck.sh: no answers file at $answers" >&2; exit 2; }
      [ $# -eq 3 ] && memory=$(remembered "$3")
      # LINKS-REPLACE: the different links are checked like any link, with DNS and no PDF.
      # shellcheck disable=SC2046
      docker run $(harden) --dns 1.1.1.1 --memory=512m --memory-swap=512m \
        -v "$out:/out" -v "$answers:/in/answers.json:ro" "$image" \
        replace --check /out/check.json --answers /in/answers.json --out /out
      if [ -n "$memory" ] && [ -f "$memory" ]; then
        # shellcheck disable=SC2046
        docker run $(harden) --network none --memory=512m --memory-swap=512m \
          -v "$out:/out" -v "$answers:/in/answers.json:ro" -v "$memory:/in/remember.json:ro" "$image" \
          list --check /out/check.json --public /out/extract-public.json --members /out/extract-members.json --answers /in/answers.json \
          --replacements /out/check-replacements.json --remember /in/remember.json --out /out
      else
        # shellcheck disable=SC2046
        docker run $(harden) --network none --memory=512m --memory-swap=512m \
          -v "$out:/out" -v "$answers:/in/answers.json:ro" "$image" \
          list --check /out/check.json --public /out/extract-public.json --members /out/extract-members.json --answers /in/answers.json \
          --replacements /out/check-replacements.json --out /out
      fi
      # The next issue fills in these answers: carry the new remember.json back to the officer's file.
      if [ -n "$memory" ]; then cp -- "$out/remember.json" "$memory"; fi
    else
      # shellcheck disable=SC2046
      docker run $(harden) --network none --memory=512m --memory-swap=512m \
        -v "$out:/out" "$image" \
        list --check /out/check.json --public /out/extract-public.json --members /out/extract-members.json --out /out
    fi
    ;;
  items)
    [ $# -eq 0 ] || usage
    # Only an image named by its digest runs: a name, then @sha256: and 64 lower-case hex characters, and
    # nothing else. The name starts with a letter or a digit, so docker cannot read it as an option, and
    # holds only lower-case letters, digits and . _ / : -, so it has no space and is one line.
    LC_ALL=C
    name=${image%@sha256:*} digest=${image##*@sha256:}
    case $image in *@sha256:*) ;; *) name= ;; esac
    case $name in [!a-z0-9]* | *[!a-z0-9._/:-]*) name= ;; esac
    case $digest in *[!0-9a-f]*) name= ;; esac
    if [ -z "$name" ] || [ ${#digest} -ne 64 ]; then
      echo "linkcheck.sh: give the image by its digest (ghcr.io/...@sha256:<64 hex characters>), never by a tag" >&2
      exit 2
    fi
    if [ -z "${LINKCHECK_API_URL:-}" ] || [ -z "${LINKCHECK_TOKEN_URL:-}" ]; then
      echo "linkcheck.sh: LINKCHECK_API_URL and LINKCHECK_TOKEN_URL are needed" >&2
      exit 2
    fi
    if [ -z "${LINKCHECK_PASSWORD_FILE:-}" ] || [ ! -f "$LINKCHECK_PASSWORD_FILE" ]; then
      echo "linkcheck.sh: LINKCHECK_PASSWORD_FILE must name the file that holds the app password" >&2
      exit 2
    fi
    secret=$(abs "$LINKCHECK_PASSWORD_FILE")
    if [ -n "$(find "$secret" -prune -perm /077)" ]; then
      echo "linkcheck.sh: the password file must be yours alone (chmod 600)" >&2
      exit 2
    fi
    case $secret in *:*) echo "linkcheck.sh: the password file's path may not hold a colon" >&2; exit 2 ;; esac
    # The optional settings go through only when set. Every setting goes by name (docker reads the value
    # from this environment), so no value is on the command line.
    set --
    [ -z "${LINKCHECK_CLIENT_ID:-}" ] || set -- "$@" -e LINKCHECK_CLIENT_ID
    [ -z "${LINKCHECK_USERNAME:-}" ] || set -- "$@" -e LINKCHECK_USERNAME
    [ -z "${LINKCHECK_SCOPE:-}" ] || set -- "$@" -e LINKCHECK_SCOPE
    # The cron wrapper's: docker writes the container's id there, so the wrapper can remove a container
    # that outlives docker's client.
    [ -z "${LINKCHECK_CID_FILE:-}" ] || set -- "$@" --cidfile "$LINKCHECK_CID_FILE"
    # exec: a signal sent to this script (the cron wrapper's, a timeout's) reaches docker itself.
    # shellcheck disable=SC2046
    exec docker run $(harden) --dns 1.1.1.1 --memory=512m --memory-swap=512m \
      -e LINKCHECK_API_URL -e LINKCHECK_TOKEN_URL "$@" -e LINKCHECK_PASSWORD_FILE=/in/password \
      -v "$secret:/in/password:ro" "$image" items
    ;;
  *) usage ;;
esac
