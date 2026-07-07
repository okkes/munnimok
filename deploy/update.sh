#!/bin/sh
# munni update script for the DSM Scheduled Task (run as root):
#   bash /volume1/docker/munni/update.sh                            # production
#   bash /volume1/docker/munni/update.sh docker-compose.staging.yml # staging (dev images)
# Re-authenticates to GHCR from .env on every run, so it keeps working
# even if /root/.docker/config.json is ever wiped (DSM upgrade etc.).
set -eu
cd "$(dirname "$0")"
COMPOSE_FILE="${1:-docker-compose.yml}"

# load GHCR_USER / GHCR_PAT (and everything else) from the sibling .env
set -a
. ./.env
set +a

if [ -n "${GHCR_PAT:-}" ]; then
  printf '%s' "$GHCR_PAT" | docker login ghcr.io -u "${GHCR_USER:-okkes}" --password-stdin
fi

docker compose -f "$COMPOSE_FILE" pull
docker compose -f "$COMPOSE_FILE" up -d
docker image prune -f
