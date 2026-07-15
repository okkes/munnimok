#!/bin/sh
# NAS-side deploy poller (user request: no SSH, no manual pulls).
#
# GitHub publishes bundles into $PUBLISHED via the Synology FileStation
# API (see .github/workflows/deploy-nas.yml):
#   munni-deploy.tgz + VERSION                  — from master (prod infra,
#       also refreshes staging so both stacks track a release)
#   munni-deploy-staging.tgz + VERSION_STAGING  — from dev (staging-only)
# This script — run every ~5 minutes by the DSM Task Scheduler (see
# deploy/nas/README.md) — notices a new stamp, unpacks the bundle over
# the live directory and runs update.sh for the affected stack(s).
#
# The master bundle includes .env, rendered by CI from the committed
# template + GitHub secrets — do NOT edit .env on the NAS by hand, the
# next deploy overwrites it. This script also ships IN the bundle and
# so updates itself; the scheduler must therefore never execute this
# file directly (tar would overwrite a running script) — it runs a
# throwaway copy instead:
#   cd /volume1/docker/munni && cp apply.sh .apply.run && sh .apply.run
# Idempotent: exits in milliseconds when nothing changed.
set -u

LIVE="${MUNNI_LIVE_DIR:-/volume1/docker/munni}"
PUBLISHED="${MUNNI_PUBLISHED_DIR:-$LIVE/published}"
LOG="$LIVE/deploy.log"

log() { echo "$(date '+%Y-%m-%d %H:%M:%S') $*" >>"$LOG"; }

# never run two applies at once (an image pull can outlast the schedule)
if command -v flock >/dev/null 2>&1; then
  exec 9>"$LIVE/.apply.lock"
  flock -n 9 || exit 0
fi

apply_channel() { # apply_channel STAMP BUNDLE MARKER STACKS...
  stamp="$1"; bundle="$2"; marker="$3"; shift 3
  [ -f "$PUBLISHED/$stamp" ] || return 0
  new="$(cat "$PUBLISHED/$stamp")"
  old="$(cat "$LIVE/$marker" 2>/dev/null || echo none)"
  [ "$new" = "$old" ] && return 0

  log "new deploy $stamp=$new (was $old) — unpacking $bundle"
  if ! tar -xzf "$PUBLISHED/$bundle" -C "$LIVE"; then
    log "unpack of $bundle FAILED — leaving stacks untouched"
    return 1
  fi
  echo "$new" >"$LIVE/$marker"

  ok=1
  for compose in "$@"; do
    log "updating $compose"
    if sh "$LIVE/update.sh" "$compose" >>"$LOG" 2>&1; then
      log "$compose ok"
    else
      log "$compose FAILED (see above) — its previous containers keep running"
      ok=0
    fi
  done
  [ "$ok" = 1 ]
}

rc=0
# master bundle refreshes prod AND staging (a release moves both stacks)
apply_channel VERSION munni-deploy.tgz .applied_version \
  docker-compose.yml docker-compose.staging.yml || rc=1
# dev bundle refreshes staging only
apply_channel VERSION_STAGING munni-deploy-staging.tgz .applied_version_staging \
  docker-compose.staging.yml || rc=1
exit $rc
