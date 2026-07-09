#!/bin/sh
# munni update script for the DSM Scheduled Task (run as root):
#   bash /volume1/docker/munni/update.sh                            # production (.env)
#   bash /volume1/docker/munni/update.sh docker-compose.staging.yml # staging   (.env.staging)
# Each environment has its own env file next to this script; compose is
# pointed at it explicitly with --env-file, so prod and staging never
# share or overwrite each other's secrets.
# Re-authenticates to GHCR from the env file on every run, so it keeps
# working even if /root/.docker/config.json is ever wiped (DSM upgrade).
set -eu
cd "$(dirname "$0")"
COMPOSE_FILE="${1:-docker-compose.yml}"
case "$COMPOSE_FILE" in
  *staging*) ENV_FILE=".env.staging" ;;
  *)         ENV_FILE=".env" ;;
esac
[ -f "$ENV_FILE" ] || { echo "missing $ENV_FILE next to update.sh" >&2; exit 1; }

# load GHCR_USER / GHCR_PAT (and everything else) for this environment
set -a
. "./$ENV_FILE"
set +a

if [ -n "${GHCR_PAT:-}" ]; then
  printf '%s' "$GHCR_PAT" | docker login ghcr.io -u "${GHCR_USER:-okkes}" --password-stdin
fi

docker compose --env-file "$ENV_FILE" -f "$COMPOSE_FILE" pull
docker compose --env-file "$ENV_FILE" -f "$COMPOSE_FILE" up -d
docker image prune -f
