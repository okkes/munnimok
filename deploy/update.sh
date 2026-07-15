#!/bin/sh
# munni update script for the Synology NAS (run as root):
#   bash /volume1/docker/munni/update.sh                            # production (.env)
#   bash /volume1/docker/munni/update.sh docker-compose.staging.yml # staging
# Invoked by deploy/nas/apply.sh when GitHub publishes a new bundle, or
# by hand. Compose reads the env file via --env-file; staging uses
# .env.staging when present and falls back to the production .env
# (the staging compose only needs a subset of its keys).
# Re-authenticates to GHCR from the env file on every run, so it keeps
# working even if /root/.docker/config.json is ever wiped (DSM upgrade).
set -eu
cd "$(dirname "$0")"
COMPOSE_FILE="${1:-docker-compose.yml}"
case "$COMPOSE_FILE" in
  *staging*) ENV_FILE=".env.staging"; [ -f "$ENV_FILE" ] || ENV_FILE=".env" ;;
  *)         ENV_FILE=".env" ;;
esac
[ -f "$ENV_FILE" ] || { echo "missing $ENV_FILE next to update.sh" >&2; exit 1; }

# Read ONLY the registry credentials out of the env file. Never `source`
# it: values like FCM_SERVICE_ACCOUNT_JSON contain spaces/quotes that the
# shell would execute as commands ("service_account: command not found").
# docker compose parses the file itself (dotenv rules), not via the shell.
env_val() {
  sed -n "s/^$1=//p" "$ENV_FILE" | head -n 1 | tr -d '\r' \
    | sed "s/^'\(.*\)'$/\1/; s/^\"\(.*\)\"\$/\1/"
}
GHCR_USER="$(env_val GHCR_USER)"
GHCR_PAT="$(env_val GHCR_PAT)"

if [ -n "$GHCR_PAT" ]; then
  printf '%s' "$GHCR_PAT" | docker login ghcr.io -u "${GHCR_USER:-okkes}" --password-stdin
fi

docker compose --env-file "$ENV_FILE" -f "$COMPOSE_FILE" pull
docker compose --env-file "$ENV_FILE" -f "$COMPOSE_FILE" up -d
docker image prune -f
