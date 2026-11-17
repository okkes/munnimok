#!/bin/sh
# NAS-side deploy poller (DSM Task Scheduler, ~5 min): GitHub publishes munni-<stack>.tgz + a stamp
# VERSION_<STACK> into $PUBLISHED (deploy-nas.yml); a new stamp unpacks the bundle and runs update.sh.
# A stamp reading "remove" tears the stack down. .applied_<stack> in $LIVE holds the last stamp applied.
#
# It ships IN every bundle and updates itself, so the scheduler runs a throwaway copy (tar would
# overwrite a running script):
#   cd "<live dir>" && cp apply.sh .apply.run && MUNNI_LIVE_DIR="<live dir>" MUNNI_PUBLISHED_DIR="<live dir>/published" sh .apply.run
set -u

LIVE="${MUNNI_LIVE_DIR:-$(cd "$(dirname "$0")" && pwd)}"
PUBLISHED="${MUNNI_PUBLISHED_DIR:-$LIVE/published}"
LOG="$LIVE/deploy.log"

log() { echo "$(date '+%Y-%m-%d %H:%M:%S') $*" >>"$LOG"; }

date +%s >"$LIVE/.apply.heartbeat" 2>/dev/null || true

# never run two applies at once (an image pull can outlast the schedule);
# a holder older than 90 minutes is a hung apply and is killed
if command -v flock >/dev/null 2>&1; then
  exec 9>"$LIVE/.apply.lock2"
  if ! flock -n 9; then
    holder="$(cat "$LIVE/.apply.pid" 2>/dev/null || echo)"
    started="$(cat "$LIVE/.apply.started" 2>/dev/null || echo 0)"
    age=$(( $(date +%s) - started ))
    if [ -n "$holder" ] && [ "$age" -gt 5400 ] && grep -q "apply" "/proc/$holder/cmdline" 2>/dev/null; then
      log "apply held by PID $holder for ${age}s — killing the stale holder; next cycle retries"
      if command -v pgrep >/dev/null 2>&1; then
        for child in $(pgrep -P "$holder" 2>/dev/null); do kill -9 "$child" 2>/dev/null; done
      fi
      kill -9 "$holder" 2>/dev/null
    elif [ "$age" -gt 5400 ]; then
      log "apply lock held >90min with no identifiable holder — waiting; if this repeats, reboot the NAS or clear the lock"
    fi
    echo "another apply is running (pid ${holder:-?}, ${age}s) — skipped"
    exit 0
  fi
  echo $$ >"$LIVE/.apply.pid"
  date +%s >"$LIVE/.apply.started"
fi

stack_of() { echo "$1" | sed 's/^VERSION_//' | tr 'A-Z_' 'a-z-' | sed 's/^/munni-/'; }

apply_stack() { # apply_stack STACK
  stack="$1"
  stamp="VERSION_$(echo "$stack" | sed 's/^munni-//' | tr 'a-z-' 'A-Z_')"
  bundle="$stack.tgz"
  marker=".applied_$stack"
  compose="docker-compose.$stack.yml"
  target="$(dirname "$LIVE")/$stack"
  [ -f "$PUBLISHED/$stamp" ] || return 0
  new="$(cat "$PUBLISHED/$stamp" | tr -d '[:space:]')"
  old="$(cat "$LIVE/$marker" 2>/dev/null || echo none)"
  # "remove" is checked BEFORE the nothing-new shortcut: an older script stored it as a version marker
  if [ "$new" = "remove" ]; then
    [ "$old" = "removed" ] && return 0
    if [ -d "$target" ]; then
      log "removal requested for $stack — stopping its containers and deleting $target"
      (cd "$target" && docker compose --env-file .env -f "$compose" down -v --remove-orphans) >>"$LOG" 2>&1 || log "compose down failed for $stack (continuing with the folder)"
      rm -rf "$target"
    fi
    rm -f "$PUBLISHED/$bundle" "$PUBLISHED/$stamp"
    echo removed >"$LIVE/$marker"
    log "$stack removed"
    return 0
  fi
  [ "$new" = "$old" ] && return 0
  mkdir -p "$target"
  log "new deploy $stamp=$new (was $old) — unpacking $bundle into $target"
  if ! tar -xzf "$PUBLISHED/$bundle" -C "$target"; then
    log "unpack of $bundle FAILED — leaving $stack untouched"
    return 1
  fi
  log "updating $stack"
  if sh "$target/update.sh" "$compose" >>"$LOG" 2>&1; then
    log "$stack ok"
    echo "$new" >"$LIVE/$marker"
  else
    log "$stack FAILED (see above) — its previous containers keep running; retried next cycle"
    return 1
  fi
}

rc=0
# the shared stack first: the environments join its network
shared=""
envs=""
for f in "$PUBLISHED"/VERSION_*; do
  [ -f "$f" ] || continue
  s="$(stack_of "$(basename "$f")")"
  case "$s" in *-shared) shared="$s" ;; *) envs="$envs $s" ;; esac
done
[ -n "$shared" ] && { apply_stack "$shared" || rc=1; }
for s in $envs; do apply_stack "$s" || rc=1; done

# .logto-seed-pending / .glitchtip-seed-pending: a seed that could not run yet (service booting), retried each cycle
for d in "$(dirname "$LIVE")"/munni-*; do
  [ -d "$d" ] || continue
  if { [ -f "$d/.logto-seed-pending" ] || [ -f "$d/.glitchtip-seed-pending" ]; } && [ -f "$d/update.sh" ]; then
    compose="$(ls "$d"/docker-compose.*.yml 2>/dev/null | head -n 1)"
    log "seed pending in $(basename "$d") — retrying"
    (cd "$d" && sh ./update.sh --seed "$(basename "$compose")") >>"$LOG" 2>&1 || log "seed retry in $(basename "$d") failed — next cycle"
  fi
done

state=""
for m in "$LIVE"/.applied_*; do [ -f "$m" ] && state="$state $(basename "$m" | sed 's/^.applied_//')=$(cat "$m")"; done
echo "cycle done rc=$rc${state:- (nothing applied yet)}"
exit $rc
