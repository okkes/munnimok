#!/bin/sh
# NAS-side deploy poller (user request: no SSH, no manual pulls).
#
# GitHub publishes bundles into $PUBLISHED via the Synology FileStation
# API (see .github/workflows/deploy-nas.yml):
#       also refreshes staging so both stacks track a release)
# This script — run every ~5 minutes by the DSM Task Scheduler (see
# deploy/nas/README.md) — notices a new stamp, unpacks the bundle over
# the live directory and runs update.sh for the affected stack(s).
#
# template + GitHub secrets — do NOT edit .env on the NAS by hand, the
# next deploy overwrites it. This script also ships IN the bundle and
# so updates itself; the scheduler must therefore never execute this
# file directly (tar would overwrite a running script) — it runs a
# throwaway copy instead:
#   cd "<live dir>" && cp apply.sh .apply.run && MUNNI_LIVE_DIR="<live dir>" MUNNI_PUBLISHED_DIR="<live dir>/published" sh .apply.run
# Idempotent: exits in milliseconds when nothing changed.
set -u

LIVE="${MUNNI_LIVE_DIR:-$(cd "$(dirname "$0")" && pwd)}" # the poller task passes it; the script's own dir otherwise
PUBLISHED="${MUNNI_PUBLISHED_DIR:-$LIVE/published}"
LOG="$LIVE/deploy.log"

log() { echo "$(date '+%Y-%m-%d %H:%M:%S') $*" >>"$LOG"; }

# never run two applies at once (an image pull can outlast the schedule).
# But a HOLDER that outlives any sane apply is a hung apply: on
# 2026-07-20 a wedged docker pull held this lock for 40+ hours and the
# silent `exit 0` froze BOTH stacks while newer bundles sat in
# published/ — so a long-stale holder is now killed (next cycle applies).
# heartbeat: every scheduler cycle stamps this file, so "the scheduler
# stopped" and "an apply is stuck" become distinguishable from the
# outside (nas-diag list shows mtimes) — the 2026-07-22 outage was
# invisible for two days because silence looked like idleness
date +%s >"$LIVE/.apply.heartbeat" 2>/dev/null || true

# .apply.lock2: v2 lock name. A holder of the OLD lock that predates the
# pid file could never be killed (no pid to target) and starved every
# cycle via silent exit 0 — a fresh name breaks that class of wedge once,
# and the pid+age kill below handles future ones.
if command -v flock >/dev/null 2>&1; then
  exec 9>"$LIVE/.apply.lock2"
  if ! flock -n 9; then
    holder="$(cat "$LIVE/.apply.pid" 2>/dev/null || echo)"
    started="$(cat "$LIVE/.apply.started" 2>/dev/null || echo 0)"
    age=$(( $(date +%s) - started ))
    # 90 min covers the slowest image pull; /proc guard: never kill a
    # recycled PID that is not an apply run
    if [ -n "$holder" ] && [ "$age" -gt 5400 ] && grep -q "apply" "/proc/$holder/cmdline" 2>/dev/null; then
      log "apply held by PID $holder for ${age}s — killing the stale holder; next cycle retries"
      if command -v pgrep >/dev/null 2>&1; then
        for child in $(pgrep -P "$holder" 2>/dev/null); do kill -9 "$child" 2>/dev/null; done
      fi
      kill -9 "$holder" 2>/dev/null
    elif [ "$age" -gt 5400 ]; then
      # no identifiable holder (pre-pid-file wedge): say so instead of
      # exiting silently — the log is the only witness we have
      log "apply lock held >90min with no identifiable holder — waiting; if this repeats, reboot the NAS or clear the lock"
    fi
    # stdout reaches the DSM Run Result — a manual run must never LOOK
    # like it did nothing (2026-07-24: a silent skip hid a live apply)
    echo "another apply is running (pid ${holder:-?}, ${age}s) — skipped"
    exit 0
  fi
  echo $$ >"$LIVE/.apply.pid"
  date +%s >"$LIVE/.apply.started"
fi

apply_channel_dir() { # apply_channel_dir STAMP BUNDLE MARKER DIR COMPOSE
  # like apply_channel, but the bundle owns its own directory NEXT TO the
  # live one (the IaC twins: /volume1/docker/munni-iac-prod …). The bundle
  # carries its own update.sh; markers stay in $LIVE with the others.
  stamp="$1"; bundle="$2"; marker="$3"; dir="$4"; compose="$5"
  [ -f "$PUBLISHED/$stamp" ] || return 0
  new="$(cat "$PUBLISHED/$stamp" | tr -d '[:space:]')"
  old="$(cat "$LIVE/$marker" 2>/dev/null || echo none)"
  target="$(dirname "$LIVE")/$dir"
  # cleanup as code (2026-09-17): a stamp reading "remove" (bootstrap --cleanup
  # uploads it) stops the twin's containers, drops its volumes and deletes
  # its folder and bundle; the marker says "removed" so the wizard can tell.
  # Checked BEFORE the nothing-new shortcut: a marker that already reads
  # "remove" (an older script took it for a version) must still remove.
  if [ "$new" = "remove" ]; then
    [ "$old" = "removed" ] && return 0
    if [ -d "$target" ]; then
      envf=".env"; case "$compose" in *staging*) [ -f "$target/.env.staging" ] && envf=".env.staging" ;; esac
      log "removal requested for $dir — stopping its containers and deleting $target"
      (cd "$target" && docker compose --env-file "$envf" -f "$compose" down -v --remove-orphans) >>"$LOG" 2>&1 || log "compose down failed for $dir (continuing with the folder)"
      rm -rf "$target"
    fi
    rm -f "$PUBLISHED/$bundle" "$PUBLISHED/$stamp"
    echo removed >"$LIVE/$marker"
    log "$dir removed"
    return 0
  fi
  [ "$new" = "$old" ] && return 0
  mkdir -p "$target"
  log "new deploy $stamp=$new (was $old) — unpacking $bundle into $target"
  if ! tar -xzf "$PUBLISHED/$bundle" -C "$target"; then
    log "unpack of $bundle FAILED — leaving $dir untouched"
    return 1
  fi

  log "updating $dir/$compose"
  if sh "$target/update.sh" "$compose" >>"$LOG" 2>&1; then
    log "$dir/$compose ok"
    echo "$new" >"$LIVE/$marker"
  else
    log "$dir/$compose FAILED (see above) — its previous containers keep running; retried next cycle"
    return 1
  fi
}

rc=0
# iac twins: each in its own directory, deployed only when their bundles
# appear (deploy-nas.yml channel=iac-*) — absent stamps skip in µs
apply_channel_dir VERSION_IAC_PROD munni-deploy-iac-prod.tgz .applied_version_iac_prod \
  munni-iac-prod docker-compose.munni-iac-prod.yml || rc=1
apply_channel_dir VERSION_IAC_STAGING munni-deploy-iac-staging.tgz .applied_version_iac_staging \
  munni-iac-staging docker-compose.munni-iac-staging.yml || rc=1
# one status line to stdout: the DSM Run Result then always tells what
# a Logto or GlitchTip seed that could not run yet (still booting the first
# time; update.sh left .logto-seed-pending / .glitchtip-seed-pending) is
# retried every cycle
for dir in munni-iac-prod munni-iac-staging; do
  d="$(dirname "$LIVE")/$dir"
  if { [ -f "$d/.logto-seed-pending" ] || [ -f "$d/.glitchtip-seed-pending" ]; } && [ -f "$d/update.sh" ]; then
    compose="$(ls "$d"/docker-compose.*.yml 2>/dev/null | head -n 1)"
    log "seed pending in $dir — retrying"
    (cd "$d" && sh ./update.sh --seed "$(basename "$compose")") >>"$LOG" 2>&1 || log "seed retry in $dir failed — next cycle"
  fi
done

# state the cycle LEFT things in, even when nothing changed
echo "cycle done rc=$rc iac-prod=$(cat "$LIVE/.applied_version_iac_prod" 2>/dev/null || echo none) iac-staging=$(cat "$LIVE/.applied_version_iac_staging" 2>/dev/null || echo none)"
exit $rc
