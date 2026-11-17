#!/bin/sh
# The scheduled run of `linkcheck items` on the officer's own machine (LINKCHECK-CRON): what the
# crontab calls. One run at a time. It reads the service account from OpenBao, hands the app password
# to the hardened container as a file only (scripts/linkcheck.sh items), and appends one line per run
# to ~/.local/state/nwfl-linkcheck/items.log: the time, the exit code, and the counts or the reason.
#
# Settings, one NAME=value per line (taken as written, no quotes), in ~/.config/nwfl-linkcheck/items.conf:
#   LINKCHECK_IMAGE      the linkcheck image by digest (ghcr.io/...@sha256:...), as printed by CI
#   LINKCHECK_API_URL    the API's https address
#   LINKCHECK_TOKEN_URL  the identity provider's token endpoint
#   LINKCHECK_SCOPE      optional
#   BAO_ADDR             optional: OpenBao's address, for a crontab that does not set it
#
# Exit codes: 0 done; 1 the run failed (the log says why); 2 OpenBao is unreachable or sealed;
# 3 another run is still going.
set -u
umask 077

PATH=${PATH:-/usr/bin:/bin}:/usr/local/bin:$HOME/.local/bin:$HOME/bin
export PATH
here=$(CDPATH='' cd -- "$(dirname -- "$0")" && pwd)
state=$HOME/.local/state/nwfl-linkcheck
conf=$HOME/.config/nwfl-linkcheck/items.conf
secret=secret/nwfl-mensa/linkcheck/client
limit=1200

if ! mkdir -p -- "$state" || ! chmod 700 -- "$state"; then
  echo "items-cron: $state cannot be made" >&2
  exit 1
fi

# The run's one log line, the same words on stderr unless all went well, and the exit.
finish() {
  printf '%s exit=%s %s\n' "$(date -Iseconds)" "$1" "$2" >> "$state/items.log"
  [ "$1" -eq 0 ] || echo "items-cron: $2" >&2
  exit "$1"
}

# The private folder that holds the password file is removed on every exit. A signal stops the
# container first; the run then ends through finish, so the folder goes and the log says so.
dir='' child='' stopped=''
trap '[ -z "$dir" ] || rm -rf -- "${dir:?}"' EXIT
trap 'stopped=1; [ -z "$child" ] || kill -TERM "$child" 2>/dev/null' INT TERM HUP

# One run at a time. The container inherits the lock, so it is held for as long as one runs.
exec 9>> "$state/items.lock"
flock -n 9
case $? in
  0) ;;
  1) finish 3 "already running" ;;
  *) finish 1 "the lock on $state/items.lock could not be taken" ;;
esac

# With the lock held, a folder a killed run left behind belongs to nobody.
for old in "$state"/run.*; do
  [ ! -d "$old" ] || rm -rf -- "${old:?}"
done

[ -f "$conf" ] || finish 1 "no settings file at $conf"
image='' LINKCHECK_API_URL='' LINKCHECK_TOKEN_URL='' scope='' n=0
while IFS= read -r line || [ -n "$line" ]; do
  n=$((n + 1))
  case $line in
    '' | '#'*) ;;
    LINKCHECK_IMAGE=*) image=${line#*=} ;;
    LINKCHECK_API_URL=*) LINKCHECK_API_URL=${line#*=} ;;
    LINKCHECK_TOKEN_URL=*) LINKCHECK_TOKEN_URL=${line#*=} ;;
    LINKCHECK_SCOPE=*) scope=${line#*=} ;;
    BAO_ADDR=*) BAO_ADDR=${line#*=} && export BAO_ADDR ;;
    *) finish 1 "line $n of $conf is not a setting this script knows" ;;
  esac
done < "$conf"
[ -n "$image" ] || finish 1 "LINKCHECK_IMAGE is missing from $conf"
[ -n "$LINKCHECK_API_URL" ] || finish 1 "LINKCHECK_API_URL is missing from $conf"
[ -n "$LINKCHECK_TOKEN_URL" ] || finish 1 "LINKCHECK_TOKEN_URL is missing from $conf"

command -v bao > /dev/null 2>&1 || finish 2 "OpenBao cannot be reached: there is no bao command"
# `bao status` needs no sign-in: 0 unsealed, 2 sealed, anything else an error.
bao status > /dev/null 2>&1
case $? in
  0) ;;
  2) finish 2 "OpenBao is sealed" ;;
  *) finish 2 "OpenBao cannot be reached" ;;
esac

# The password goes from OpenBao straight into a 0600 file (umask 077) in a fresh 0700 folder: it is
# never in a variable, an argument or an environment value, and nothing here prints a field.
dir=$(mktemp -d "$state/run.XXXXXX") || finish 1 "no private folder could be made in $state"
field() { bao kv get -field="$1" "$secret" 2> /dev/null; }
if ! LINKCHECK_CLIENT_ID=$(field client_id) || ! LINKCHECK_USERNAME=$(field username) || ! field password > "$dir/password" ||
  [ -z "$LINKCHECK_CLIENT_ID" ] || [ -z "$LINKCHECK_USERNAME" ] || [ ! -s "$dir/password" ]; then
  finish 1 "OpenBao did not give the linkcheck client secret: sign in to OpenBao, or the secret is not there yet"
fi
[ -z "$stopped" ] || finish 1 "stopped by a signal"

export LINKCHECK_API_URL LINKCHECK_TOKEN_URL LINKCHECK_CLIENT_ID LINKCHECK_USERNAME
[ -z "$scope" ] || { LINKCHECK_SCOPE=$scope && export LINKCHECK_SCOPE; }
# In the background, so a signal is acted on at once. linkcheck.sh execs docker, so the TERM that
# timeout passes on reaches docker, which stops the container.
LINKCHECK_PASSWORD_FILE=$dir/password timeout -k 30 "$limit" sh "$here/linkcheck.sh" items "$image" > "$dir/out" 2> "$dir/err" &
child=$!
wait "$child"
code=$?
if [ -n "$stopped" ]; then
  wait "$child" 2> /dev/null
  finish 1 "stopped by a signal"
fi

case $code in
  0)
    # Counts only: digits, lower-case words and , ; : and nothing an address could be made of.
    counts=$(grep -m 1 -x 'items: [0-9][0-9a-z ,;:]*' "$dir/out") || finish 1 "the run ended without a counts line"
    finish 0 "$counts"
    ;;
  124 | 137) finish 1 "the run took over $((limit / 60)) minutes and was stopped" ;;
esac
if grep -q -F -f "$dir/password" "$dir/err"; then
  finish 1 "the run failed: the message is withheld, it holds the password"
fi
why=$(grep -m 1 '^linkcheck' "$dir/err") || why=$(tail -n 1 "$dir/err")
why=$(printf '%s' "$why" | tr -d '\000-\037\177' | cut -c 1-200)
finish 1 "the run failed: ${why:-exit code $code and no message}"
