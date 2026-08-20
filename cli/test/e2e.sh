#!/usr/bin/env bash
#
# End-to-end proof: two devices, a real server, real bytes.
#
#   ./test/e2e.sh
#
# Starts the API server from ../server on a spare port with STORAGE_DRIVER=local
# and PUSH_DRIVER=console, registers two CLI devices against it, sends a file
# from one, receives it on the other, and compares sha256 at both ends. Also
# exercises text/link/stdin sends, filename collisions, ack, revoke, and the
# reconnect + catch-up path. Everything lives in a temp dir that is removed on
# exit; your real ~/.config/transmat is never touched.

set -euo pipefail

CLI_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
SERVER_DIR="$(cd "$CLI_DIR/../server" 2>/dev/null && pwd || true)"
PORT="${PORT:-8799}"
TOKEN="e2e-token-$RANDOM"
WORK="$(mktemp -d)"
TRANSMAT="node $CLI_DIR/src/index.js"

A="$WORK/phone.json"      # the sender
B="$WORK/laptop.json"     # the receiver
DL="$WORK/downloads"
SERVER_PID=""
WATCH_PID=""

pass=0
fail=0

cleanup() {
  [ -n "$WATCH_PID" ] && kill "$WATCH_PID" 2>/dev/null || true
  [ -n "$SERVER_PID" ] && kill "$SERVER_PID" 2>/dev/null || true
  rm -rf "$WORK"
}
trap cleanup EXIT

say()  { printf '\n\033[1m== %s\033[0m\n' "$*"; }
ok()   { pass=$((pass + 1)); printf '  \033[32mok\033[0m   %s\n' "$*"; }
bad()  { fail=$((fail + 1)); printf '  \033[31mFAIL\033[0m %s\n' "$*"; }
check() { if [ "$2" = "$3" ]; then ok "$1"; else bad "$1 (expected '$3', got '$2')"; fi; }

if [ -z "$SERVER_DIR" ] || [ ! -f "$SERVER_DIR/src/index.js" ]; then
  echo "no server at ../server — cannot run the end-to-end test" >&2
  exit 1
fi

say "starting the server on :$PORT (local storage, console push)"
mkdir -p "$DL"
PORT="$PORT" TRANSMAT_TOKEN="$TOKEN" DATA_DIR="$WORK/data" \
  STORAGE_DRIVER=local PUSH_DRIVER=console \
  node "$SERVER_DIR/src/index.js" > "$WORK/server.log" 2>&1 &
SERVER_PID=$!

for _ in $(seq 1 50); do
  if curl -fsS "http://localhost:$PORT/health" > /dev/null 2>&1; then break; fi
  sleep 0.2
done
curl -fsS "http://localhost:$PORT/health" > /dev/null || { echo "server never came up"; cat "$WORK/server.log"; exit 1; }
ok "server is healthy"

say "login and register two devices"
TRANSMAT_CONFIG=$A $TRANSMAT login "http://localhost:$PORT" "$TOKEN" --no-color > /dev/null
TRANSMAT_CONFIG=$B $TRANSMAT login "http://localhost:$PORT" "$TOKEN" --no-color > /dev/null
check "config is 0600" "$(stat -c '%a' "$A" 2>/dev/null || stat -f '%Lp' "$A")" "600"

TRANSMAT_CONFIG=$A $TRANSMAT register --name "Phone" --no-color > /dev/null
TRANSMAT_CONFIG=$B $TRANSMAT register --name "Laptop" --no-color > /dev/null
count=$(TRANSMAT_CONFIG=$A $TRANSMAT devices --json | grep -c '"platform": "cli"')
check "two devices registered" "$count" "2"

say "send a 4 MB file from Phone, receive it on Laptop"
head -c 4194304 /dev/urandom > "$WORK/report.pdf"
want=$(sha256sum "$WORK/report.pdf" | cut -d' ' -f1)

TRANSMAT_CONFIG=$B $TRANSMAT watch --dir "$DL" --no-color > "$WORK/watch.log" 2>&1 &
WATCH_PID=$!
sleep 1.5

TRANSMAT_CONFIG=$A $TRANSMAT send "$WORK/report.pdf" --no-color > /dev/null
# Wait for the watcher to *report* the arrival, not merely for the name to exist.
for _ in $(seq 1 60); do grep -q "report.pdf" "$WORK/watch.log" && break; sleep 0.2; done
got=$(sha256sum "$DL/report.pdf" | cut -d' ' -f1)
check "bytes are identical end to end" "$got" "$want"
[ -z "$(find "$DL" -name '*.part' -print -quit)" ] && ok "no .part files left behind" || bad "a .part file was left behind"

say "text, link and stdin"
TRANSMAT_CONFIG=$A $TRANSMAT send --text "the wifi password is hunter2" --no-color > /dev/null
TRANSMAT_CONFIG=$A $TRANSMAT send --link "https://example.com/thing" --no-color > /dev/null
printf 'from a pipe\n' | TRANSMAT_CONFIG=$A $TRANSMAT send - --name pipe.txt --no-color > /dev/null
sleep 1.5
grep -q "hunter2" "$WORK/watch.log" && ok "text printed to stdout" || bad "text was not printed"
grep -q "example.com/thing" "$WORK/watch.log" && ok "link printed to stdout" || bad "link was not printed"
check "stdin arrived" "$(cat "$DL/pipe.txt")" "from a pipe"
[ -f "$DL/hunter2" ] && bad "text should not create a file" || ok "text created no file"

say "the same filename twice does not clobber"
TRANSMAT_CONFIG=$A $TRANSMAT send "$WORK/report.pdf" --no-color > /dev/null
for _ in $(seq 1 60); do grep -q "report (2).pdf" "$WORK/watch.log" && break; sleep 0.2; done
check "second copy is renamed" "$(sha256sum "$DL/report (2).pdf" | cut -d' ' -f1)" "$want"
check "first copy is untouched" "$(sha256sum "$DL/report.pdf" | cut -d' ' -f1)" "$want"

say "deliveries are acked"
state=$(TRANSMAT_CONFIG=$A $TRANSMAT ls --out --limit 1 --json | grep -o '"state": "downloaded"' | head -1)
check "delivery state" "$state" '"state": "downloaded"'

say "reconnect and catch up on what was missed"
kill "$WATCH_PID"; wait "$WATCH_PID" 2>/dev/null || true; WATCH_PID=""
echo "missed while offline" > "$WORK/missed.txt"
TRANSMAT_CONFIG=$A $TRANSMAT send "$WORK/missed.txt" --no-color > /dev/null
TRANSMAT_CONFIG=$B $TRANSMAT watch --dir "$DL" --once --no-color > /dev/null 2>&1
check "catch-up poll delivered it" "$(cat "$DL/missed.txt")" "missed while offline"

say "revoke deletes the bytes before they land"
echo "oops" > "$WORK/oops.txt"
id=$(TRANSMAT_CONFIG=$A $TRANSMAT send "$WORK/oops.txt" --json | grep -o '"transfer_id": "[^"]*"' | head -1 | cut -d'"' -f4)
TRANSMAT_CONFIG=$A $TRANSMAT rm "$id" --no-color > /dev/null
TRANSMAT_CONFIG=$B $TRANSMAT watch --dir "$DL" --once --no-color > /dev/null 2>&1
[ -f "$DL/oops.txt" ] && bad "a revoked transfer was downloaded" || ok "revoked transfer was not downloaded"

say "exit codes"
set +e
TRANSMAT_CONFIG="$WORK/nope.json" $TRANSMAT ls > /dev/null 2>&1;                      check "not logged in" "$?" "3"
TRANSMAT_CONFIG=$A TRANSMAT_TOKEN=wrong $TRANSMAT devices > /dev/null 2>&1;           check "bad token"     "$?" "4"
TRANSMAT_CONFIG=$A TRANSMAT_URL=http://localhost:1 $TRANSMAT devices > /dev/null 2>&1; check "server down"   "$?" "5"
TRANSMAT_CONFIG=$A $TRANSMAT rm does-not-exist > /dev/null 2>&1;                      check "not found"     "$?" "6"
TRANSMAT_CONFIG=$A $TRANSMAT frobnicate > /dev/null 2>&1;                             check "bad usage"     "$?" "2"
set -e

printf '\n\033[1m%d passed, %d failed\033[0m\n' "$pass" "$fail"
[ "$fail" -eq 0 ]
