#!/bin/sh
# munni update script for the Synology NAS (run as root) — one stack:
#   sh /volume1/docker/munni-nas-prod/update.sh docker-compose.munni-nas-prod.yml
# Invoked by deploy/nas/apply.sh when GitHub publishes a new bundle, or by
# hand. Compose reads .env next to this script (rendered by CI — never
# edit it on the NAS, the next deploy overwrites it). Re-authenticates to
# GHCR from the env file when a token is present.
set -eu
cd "$(dirname "$0")"
# --seed: only the seeds below (the poller retries a seed that could not run yet)
MODE=apply
if [ "${1:-}" = "--seed" ]; then MODE=seed; shift; fi
COMPOSE_FILE="${1:-docker-compose.yml}"
ENV_FILE=".env"
[ -f "$ENV_FILE" ] || { echo "missing $ENV_FILE next to update.sh" >&2; exit 1; }

# Read single values out of the env file. Never `source` it: values like
# FCM_SERVICE_ACCOUNT_JSON contain spaces/quotes the shell would execute.
env_val() {
  sed -n "s/^$1=//p" "$ENV_FILE" | head -n 1 | tr -d '\r' \
    | sed "s/^'\(.*\)'$/\1/; s/^\"\(.*\)\"\$/\1/"
}
GHCR_USER="$(env_val GHCR_USER)"
GHCR_PAT="$(env_val GHCR_PAT)"
compose() { docker compose --env-file "$ENV_FILE" -f "$COMPOSE_FILE" "$@"; }
# the postgres service of an environment stack carries the environment's name (postgres-<env>); the in-stack alias is "postgres"
pg_service() { grep -oE '^  postgres(-[a-z0-9]+)?:' "$COMPOSE_FILE" | head -n 1 | tr -d ' :'; }

# ── Logto machine credentials as code: the env carries two credentials the
#    bootstrap minted; insert them into Logto's own database once
#    (idempotent) — `infra` in the default tenant with the Management API
#    role, and one in the admin tenant with the console credential's roles.
#    Logto creates its tables on first boot: wait for the role row; a seed
#    that cannot run yet leaves .logto-seed-pending for the poller.
logto_seed() {
  SEED_ID="$(env_val LOGTO_SEED_INFRA_ID)"; SEED_SECRET="$(env_val LOGTO_SEED_INFRA_SECRET)"
  ADM_ID="$(env_val LOGTO_SEED_ADMIN_ID)"; ADM_SECRET="$(env_val LOGTO_SEED_ADMIN_SECRET)"
  if [ -z "$SEED_ID" ] || [ -z "$SEED_SECRET" ]; then return 0; fi
  grep -qE '^  logto(-[a-z0-9]+)?:' "$COMPOSE_FILE" || return 0
  PG="$(pg_service)"
  ready=0
  for _ in $(seq 1 60); do
    n="$(compose exec -T "$PG" psql -U munni -d logto -A -t -c "select count(*) from roles where tenant_id='default' and name='Logto Management API access';" 2>/dev/null | tr -d '[:space:]' || true)"
    if [ "$n" = "1" ]; then ready=1; break; fi
    sleep 10
  done
  if [ "$ready" -ne 1 ]; then
    echo "logto seed: Logto has not created its roles yet — retried next cycle"
    touch .logto-seed-pending
    return 0
  fi
  META='{"redirectUris":[],"postLogoutRedirectUris":[]}'
  set -- \
    -c "delete from applications where tenant_id='default' and name='infra (munni setup)' and id <> '$SEED_ID';" \
    -c "insert into applications (tenant_id, id, name, secret, description, type, oidc_client_metadata, custom_client_metadata) values ('default', '$SEED_ID', 'infra (munni setup)', '$SEED_SECRET', 'created by the munni setup', 'MachineToMachine', '$META', '{}') on conflict (id) do update set secret = excluded.secret, name = excluded.name;" \
    -c "insert into applications_roles (tenant_id, id, application_id, role_id) select 'default', 'link0' || substr(md5('$SEED_ID'), 1, 16), '$SEED_ID', r.id from roles r where r.tenant_id = 'default' and r.name = 'Logto Management API access' on conflict do nothing;"
  if [ -n "$ADM_ID" ] && [ -n "$ADM_SECRET" ]; then
    set -- "$@" \
      -c "delete from applications where tenant_id='admin' and name='infra admin (munni setup)' and id <> '$ADM_ID';" \
      -c "insert into applications (tenant_id, id, name, secret, description, type, oidc_client_metadata, custom_client_metadata) values ('admin', '$ADM_ID', 'infra admin (munni setup)', '$ADM_SECRET', 'created by the munni setup — claims the console admin', 'MachineToMachine', '$META', '{}') on conflict (id) do update set secret = excluded.secret, name = excluded.name;" \
      -c "insert into applications_roles (tenant_id, id, application_id, role_id) select 'admin', 'link1' || substr(md5('$ADM_ID'), 1, 16), '$ADM_ID', ar.role_id from applications_roles ar where ar.tenant_id = 'admin' and ar.application_id = 'm-admin' on conflict do nothing;"
  fi
  if compose exec -T "$PG" psql -U munni -d logto -v ON_ERROR_STOP=1 -q "$@"; then
    echo "logto seed: machine credentials in place (infra + admin tenant) — the next bootstrap turns sign-in into code"
    rm -f .logto-seed-pending
  else
    echo "logto seed FAILED — retried next cycle"
    touch .logto-seed-pending
  fi
}

# ── GlitchTip admin + API token as code (the shared stack): create the
#    superuser and the token inside the container once (idempotent) so the
#    bootstrap can write DSNs back without anyone registering by hand.
glitchtip_seed() {
  GT_EMAIL="$(env_val GLITCHTIP_SEED_EMAIL)"; GT_PASSWORD="$(env_val GLITCHTIP_SEED_PASSWORD)"; GT_TOKEN="$(env_val GLITCHTIP_SEED_TOKEN)"
  if [ -z "$GT_EMAIL" ] || [ -z "$GT_PASSWORD" ] || [ -z "$GT_TOKEN" ]; then return 0; fi
  grep -q '^  glitchtip:' "$COMPOSE_FILE" || return 0
  ready=0
  for _ in $(seq 1 60); do
    if compose exec -T glitchtip ./manage.py migrate --check >/dev/null 2>&1; then ready=1; break; fi
    sleep 10
  done
  if [ "$ready" -ne 1 ]; then
    echo "glitchtip seed: GlitchTip has not applied its migrations yet — retried next cycle"
    touch .glitchtip-seed-pending
    return 0
  fi
  GT_PY='
import os
from django.contrib.auth import get_user_model
from apps.api_tokens.models import APIToken
email = os.environ["GT_ADMIN_EMAIL"]
password = os.environ["GT_ADMIN_PASSWORD"]
token = os.environ["GT_TOKEN"]
U = get_user_model()
u = U.objects.filter(email=email).first()
if u is None:
    u = U.objects.create_superuser(email, password)
    print("USER:created")
else:
    print("USER:existing")
if APIToken.objects.filter(token=token).exists():
    print("TOKEN:existing")
else:
    flags = getattr(APIToken._meta.get_field("scopes"), "flags", []) or []
    APIToken.objects.create(user=u, token=token, scopes=(1 << len(flags)) - 1)
    print("TOKEN:created")
'
  if GT_ADMIN_EMAIL="$GT_EMAIL" GT_ADMIN_PASSWORD="$GT_PASSWORD" GT_TOKEN="$GT_TOKEN" compose exec -T -e GT_ADMIN_EMAIL -e GT_ADMIN_PASSWORD -e GT_TOKEN glitchtip ./manage.py shell -c "$GT_PY"; then
    echo "glitchtip seed: admin + API token in place — the next bootstrap writes the DSNs back"
    rm -f .glitchtip-seed-pending
  else
    echo "glitchtip seed FAILED — retried next cycle"
    touch .glitchtip-seed-pending
  fi
}
if [ "$MODE" = "seed" ]; then
  logto_seed
  glitchtip_seed
  exit 0
fi

if [ -n "$GHCR_PAT" ]; then
  printf '%s' "$GHCR_PAT" | docker login ghcr.io -u "${GHCR_USER:-okkes}" --password-stdin
fi

compose pull

# don't die before the status dump below — it captures WHY up failed
UP_RC=0
compose up -d || UP_RC=$?
[ "$UP_RC" -eq 0 ] && { logto_seed; glitchtip_seed; }
docker image prune -f

# ── post-deploy status dump (readable via File Station / the NAS-diagnostics workflow)
sleep 20
{
  echo "=== status $(date '+%Y-%m-%d %H:%M:%S') $COMPOSE_FILE ==="
  compose ps
  df -h /volume1 | tail -1
  compose ps --format '{{.Service}} {{.State}}' 2>/dev/null \
    | while read -r svc state; do
        case "$state" in
          running|*healthy*) : ;;
          *) echo "--- $svc ($state) last 60 log lines ---"
             compose logs --tail=60 "$svc" 2>&1 ;;
        esac
      done
  for svc in $(compose ps --services 2>/dev/null | grep -E '^(api|logto)' || true); do
    echo "--- $svc last 40 log lines ---"
    compose logs --tail=40 "$svc" 2>&1
  done
} > "status-$(basename "$COMPOSE_FILE" .yml).log" 2>&1 || true
exit $UP_RC
