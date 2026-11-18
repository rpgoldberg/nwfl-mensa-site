#!/bin/sh
# The scheduled run of `linkcheck items` on the officer's own machine (LINKCHECK-CRON): what the
# crontab calls. One run at a time. It reads the service account from OpenBao, hands the app password
# to the hardened container as a file only (scripts/linkcheck.sh items), and appends one line per run
# to ~/.local/state/nwfl-linkcheck/items.log: the time, the exit code, and the counts or the reason.
#
# Settings, one NAME=value per line (taken as written, no quotes), in ~/.config/nwfl-linkcheck/items.conf,
# a plain-text file that only its owner may write, in a folder that only its owner may write:
#   LINKCHECK_IMAGE      the linkcheck image by digest (ghcr.io/...@sha256:...), as printed by CI
#   LINKCHECK_API_URL    the API's https address
#   LINKCHECK_TOKEN_URL  the identity provider's token endpoint
#   LINKCHECK_SCOPE      optional
#   BAO_ADDR             optional: OpenBao's address, for a crontab that does not set it
#
# Exit codes: 0 done; 1 the run failed (the log says why); 2 OpenBao is unreachable or sealed, and
# nothing else; 3 another run is still going.
set -u
umask 077
# Patterns below mean bytes (a-z is 26 letters), and docker answers in its own fixed words.
LC_ALL=C
export LC_ALL

PATH=${PATH:-/usr/bin:/bin}:/usr/local/bin:$HOME/.local/bin:$HOME/bin
export PATH
here=$(CDPATH='' cd -- "$(dirname -- "$0")" && pwd)
state=$HOME/.local/state/nwfl-linkcheck
conf=$HOME/.config/nwfl-linkcheck/items.conf
log=$state/items.log
lock=$state/items.lock
secret=secret/nwfl-mensa/linkcheck/client
limit=1200

if ! mkdir -p -- "$state" || ! chmod 700 -- "$state"; then
  echo "items-cron: $state cannot be made" >&2
  exit 1
fi

# A plain file, or nothing yet: never a link, a folder or a pipe (opening a pipe would wait for ever).
plain() { [ ! -L "$1" ] && { [ ! -e "$1" ] || [ -f "$1" ]; }; }

# One line in the log, or on stderr when the log cannot be written.
say() {
  line="$(date -Iseconds) $1"
  if ! plain "$log" || ! { printf '%s\n' "$line" >> "$log"; } 2> /dev/null; then
    echo "items-cron: $log cannot be written; its line: $line" >&2
  fi
}

# The run's one log line, the same words on stderr unless all went well, and the exit.
finish() {
  say "exit=$1 $2"
  [ "$1" -eq 0 ] || echo "items-cron: $2" >&2
  exit "$1"
}

# Makes sure the container whose id docker wrote to the cid file $1 is gone. docker's client removes
# its container itself (--rm) unless it is killed first: timeout's KILL of a run that ignored the
# stop, or a kill of this script. Only a whole container id is ever handed to docker.
reap() {
  id=$(cat "$1" 2> /dev/null) || return 0
  case $id in *[!0-9a-f]*) return 0 ;; esac
  [ ${#id} -eq 64 ] || return 0
  timeout -k 5 10 docker rm -f "$id" > /dev/null 2>&1 ||
    say "note: this run's container could not be removed; remove it by hand: docker rm -f $(printf '%s' "$id" | cut -c 1-12)"
}

# The private folder that holds the password file is removed on every exit, after the container. A
# signal is passed on to docker's client, which stops the container; the run then ends through
# finish, so the folder goes and the log says so.
dir='' child='' stopped=''
trap '[ -z "$dir" ] || { reap "$dir/cid"; rm -rf -- "${dir:?}"; }' EXIT
trap 'stopped=1; [ -z "$child" ] || kill -TERM "$child" 2>/dev/null' INT TERM HUP

# One run at a time. This script holds the lock (docker's client inherits it, the container does
# not), and it removes its container as it ends (the EXIT trap), so no container outlives the lock.
# `command` keeps the shell alive when the file cannot be opened, so the log can say so.
if ! plain "$lock" || ! { command exec 9>> "$lock"; } 2> /dev/null; then
  finish 1 "the lock file $lock cannot be opened: it must be a plain file of yours"
fi
flock -n 9
case $? in
  0) ;;
  1) finish 3 "already running" ;;
  *) finish 1 "the lock on $lock could not be taken" ;;
esac

# With the lock held, a folder a killed run left behind belongs to nobody: its container, if it still
# runs, and its password file go now.
left=''
for old in "$state"/run.*; do
  [ ! -d "$old" ] || { reap "$old/cid"; rm -rf -- "${old:?}" && left=1; }
done
[ -z "$left" ] || say "note: a run was killed before it could clean up; the private folder it left behind is removed"

[ -f "$conf" ] || finish 1 "no settings file at $conf"
# Whoever can write the settings chooses the image that is handed the password: only the owner may.
[ ! -L "$conf" ] || finish 1 "$conf is a link: the settings must be a plain file"
[ -z "$(find "$conf" "${conf%/*}/." -prune -perm /022)" ] || finish 1 "$conf and its folder must be writable by you alone (chmod go-w)"
# `read` would drop a NUL byte and keep a carriage return, so a value would not be what the file shows.
[ "$(tr -d '\n\040-\176' < "$conf" | wc -c)" -eq 0 ] ||
  finish 1 "$conf holds a character that is not plain text (a tab, a Windows line ending, a NUL byte or a letter outside ASCII)"
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
# linkcheck.sh's own rule, here too so that a bad value ends the run before OpenBao is asked: a name
# that starts with a letter or a digit (never a dash: docker would read an option) and holds only
# lower-case letters, digits and . _ / : -, then @sha256: and 64 hex characters, and nothing else.
name=${image%@sha256:*} digest=${image##*@sha256:}
case $image in *@sha256:*) ;; *) name='' ;; esac
case $name in [!a-z0-9]* | *[!a-z0-9._/:-]*) name='' ;; esac
case $digest in *[!0-9a-f]*) name='' ;; esac
if [ -z "$name" ] || [ ${#digest} -ne 64 ]; then
  finish 1 "LINKCHECK_IMAGE in $conf is not an image by its digest (ghcr.io/...@sha256:<64 hex characters>)"
fi

command -v bao > /dev/null 2>&1 || finish 2 "OpenBao cannot be reached: there is no bao command"
# `bao status` needs no sign-in: 0 unsealed, 2 sealed, anything else an error.
bao status > /dev/null 2>&1
case $? in
  0) ;;
  2) finish 2 "OpenBao is sealed" ;;
  *) finish 2 "OpenBao cannot be reached" ;;
esac

# The password goes from OpenBao straight into a 0600 file (umask 077) in a fresh 0700 folder: it is
# never in a variable, an argument or an environment value, and nothing here prints a field. It is the
# last thing fetched, just before the container starts, and the file goes as soon as that has ended.
dir=$(mktemp -d "$state/run.XXXXXX") || finish 1 "no private folder could be made in $state"
field() { bao kv get -field="$1" "$secret" 2> /dev/null; }
if ! LINKCHECK_CLIENT_ID=$(field client_id) || ! LINKCHECK_USERNAME=$(field username) || ! field password > "$dir/password" ||
  [ -z "$LINKCHECK_CLIENT_ID" ] || [ -z "$LINKCHECK_USERNAME" ] || [ ! -s "$dir/password" ]; then
  finish 1 "OpenBao did not give the linkcheck client secret: sign in to OpenBao, or the secret is not there yet"
fi
[ -z "$stopped" ] || finish 1 "stopped by a signal"

export LINKCHECK_API_URL LINKCHECK_TOKEN_URL LINKCHECK_CLIENT_ID LINKCHECK_USERNAME
[ -z "$scope" ] || { LINKCHECK_SCOPE=$scope && export LINKCHECK_SCOPE; }
began=$(date +%s)
# In the background, so a signal is acted on at once. linkcheck.sh execs docker, so the TERM that
# timeout passes on reaches docker's client, which passes it to the container. A container that
# ignores it outlives the client that timeout then kills; the EXIT trap removes it by its id (reap).
LINKCHECK_CID_FILE=$dir/cid LINKCHECK_PASSWORD_FILE=$dir/password timeout -k 30 "$limit" sh "$here/linkcheck.sh" items "$image" > "$dir/out" 2> "$dir/err" &
child=$!
wait "$child"
code=$?
# After a signal the first wait returns at once: wait again, until docker's client has ended.
[ -z "$stopped" ] || wait "$child" 2> /dev/null
# A cid file means docker made a container: whatever is said from here on may be the container's own.
made=''
[ ! -s "$dir/cid" ] || made=1
# The password's last use (as plain text, never as a pattern), and then its file is gone.
leak=''
! grep -q -F -f "$dir/password" "$dir/err" || leak=1
rm -f -- "$dir/password"
[ -z "$stopped" ] || finish 1 "stopped by a signal"

case $code in
  0)
    # Counts only: digits, lower-case words and , ; : and nothing an address could be made of.
    counts=$(grep -a -m 1 -x 'items: [0-9][0-9a-z ,;:]*' "$dir/out") || finish 1 "the run ended without a counts line"
    finish 0 "$counts"
    ;;
  124) finish 1 "the run took over $((limit / 60)) minutes and was stopped" ;;
  137)
    # A kill: by the kernel at the container's memory limit, or by timeout's own KILL, which it sends
    # 30 seconds after the limit to a run that ignored the stop. The time the run took tells which.
    [ $(($(date +%s) - began)) -lt "$limit" ] || finish 1 "the run took over $((limit / 60)) minutes and was stopped"
    finish 1 "the run ran out of memory and was killed (exit 137)"
    ;;
esac
[ -z "$leak" ] || finish 1 "the run failed: the message is withheld, it holds the password"

# Only words this script knows are logged. A message may carry what a server said (an echo of the
# sign-in, in any encoding), so the checker's line is logged only when it is, whole, one of the fixed
# messages of the items command (src/items.ts and src/cli.ts) or of linkcheck.sh.
known='linkcheck: the API answer (is cut short|holds a bad number|is not a message this checker reads|holds text that is not UTF-8|is too large|has no status|is not one plain gRPC message)'
known="$known|linkcheck: the API refused the call: ([A-Z_]{2,24}|status [0-9]{1,3})( \(.*\))?"
known="$known|linkcheck: the API (could not be reached \([A-Za-z]{1,40}\)|did not answer in time)"
known="$known|linkcheck: the token is not a bearer token"
known="$known|linkcheck: the identity provider (could not be reached|refused the sign-in \(HTTP [0-9]{3}\)|answered with something other than JSON|gave no access token)"
known="$known|linkcheck: LINKCHECK_(API|TOKEN)_URL must be an https URL"
known="$known|linkcheck: (LINKCHECK_PASSWORD_FILE is needed|cannot read /in/password|/in/password is empty)"
known="$known|linkcheck: (unknown command items|an unexpected error \([A-Za-z]{1,40}\))"
known="$known|linkcheck\.sh: (run it as yourself, not as root|the password file's path may not hold a colon)"
# grep -a: a NUL byte in the output must not make grep call it binary and say nothing.
if why=$(grep -a -m 1 -x -E -e "$known" "$dir/err"); then
  # What the API said in its refusal is the server's own text: only the status is logged.
  case $why in 'linkcheck: the API refused the call: '*) why=${why%% (*} ;; esac
elif grep -q -E '^(Cannot connect to the Docker daemon|failed to connect to the docker API)' "$dir/err"; then
  why='docker could not be reached (is its daemon running?)'
elif [ -z "$made" ] && [ "$code" -ge 125 ] && [ "$code" -le 127 ] && why=$(grep -a -m 1 -E '^(docker:|Error response)' "$dir/err"); then
  # 125 to 127 with no container made are docker's own failure. Its reason is the first line that
  # starts so; its last line is only a pointer to its help. Printable ASCII only goes to the log.
  why=$(printf '%s' "$why" | tr -cd '\040-\176' | cut -c 1-300)
elif [ -s "$dir/err" ]; then
  finish 1 "the run failed (unrecognised message): exit code $code"
else
  finish 1 "the run failed: exit code $code and no message"
fi
finish 1 "the run failed: $why"
