#!/bin/sh
# NAS-side deploy poller (user request: no SSH, no manual pulls).
#
# GitHub uploads a fresh bundle to $PUBLISHED via the Synology FileStation
# API (see .github/workflows/deploy-nas.yml). This script — run every few
# minutes by the DSM Task Scheduler (see deploy/nas/README.md) — notices a
# new VERSION, unpacks it over the live directory and runs update.sh.
#
# Idempotent: it exits in milliseconds when nothing changed, so a 5-minute
# schedule is cheap.
set -eu

LIVE="${MUNNI_LIVE_DIR:-/volume1/docker/munni}"
PUBLISHED="${MUNNI_PUBLISHED_DIR:-$LIVE/published}"
LOG="$LIVE/deploy.log"

log() { echo "$(date '+%Y-%m-%d %H:%M:%S') $*" >>"$LOG"; }

[ -f "$PUBLISHED/VERSION" ] || exit 0
NEW="$(cat "$PUBLISHED/VERSION")"
OLD="$(cat "$LIVE/.applied_version" 2>/dev/null || echo none)"
[ "$NEW" = "$OLD" ] && exit 0

log "new deploy $NEW (was $OLD) — unpacking"
# extract over the live dir; the bundle carries compose files, nginx conf,
# update.sh and the freshly-rendered .env (built from GitHub secrets)
tar -xzf "$PUBLISHED/munni-deploy.tgz" -C "$LIVE"
echo "$NEW" >"$LIVE/.applied_version"

log "running update.sh"
if sh "$LIVE/update.sh" >>"$LOG" 2>&1; then
  log "deploy $NEW ok"
else
  log "deploy $NEW FAILED (see above) — keeping previous containers running"
  exit 1
fi
