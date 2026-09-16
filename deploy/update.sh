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
# --logto-seed: only the Logto seed below (the poller retries a seed that
# could not run yet — Logto still booting for the first time)
MODE=apply
if [ "${1:-}" = "--logto-seed" ]; then MODE=seed; shift; fi
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

# ── Logto machine credentials as code (2026-09-17): the bundle's env carries
#    two credentials the IaC bootstrap minted; insert them into Logto's own
#    database once (idempotent: upsert by id, an older id of the same name
#    makes way) so the first sign-in setup needs no console visit —
#    `infra` in the default tenant with the Management API role (what the
#    bootstrap uses for apps, connectors, branding, users) and one in the
#    admin tenant with the roles of Logto's own console credential m-admin
#    (what claims the console's first admin). Logto creates its tables and
#    roles on first boot — wait for the role row; a seed that cannot run
#    yet leaves .logto-seed-pending, which the poller retries every cycle.
logto_seed() {
  SEED_ID="$(env_val LOGTO_SEED_INFRA_ID)"; SEED_SECRET="$(env_val LOGTO_SEED_INFRA_SECRET)"
  ADM_ID="$(env_val LOGTO_SEED_ADMIN_ID)"; ADM_SECRET="$(env_val LOGTO_SEED_ADMIN_SECRET)"
  if [ -z "$SEED_ID" ] || [ -z "$SEED_SECRET" ]; then return 0; fi
  grep -q '^  logto:' "$COMPOSE_FILE" || return 0
  ready=0
  for _ in $(seq 1 60); do
    n="$(docker compose --env-file "$ENV_FILE" -f "$COMPOSE_FILE" exec -T postgres psql -U munni -d logto -A -t -c "select count(*) from roles where tenant_id='default' and name='Logto Management API access';" 2>/dev/null | tr -d '[:space:]' || true)"
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
    -c "insert into applications (tenant_id, id, name, secret, description, type, oidc_client_metadata, custom_client_metadata) values ('default', '$SEED_ID', 'infra (munni setup)', '$SEED_SECRET', 'created by the munni IaC bootstrap', 'MachineToMachine', '$META', '{}') on conflict (id) do update set secret = excluded.secret, name = excluded.name;" \
    -c "insert into applications_roles (tenant_id, id, application_id, role_id) select 'default', 'link0' || substr(md5('$SEED_ID'), 1, 16), '$SEED_ID', r.id from roles r where r.tenant_id = 'default' and r.name = 'Logto Management API access' on conflict do nothing;"
  if [ -n "$ADM_ID" ] && [ -n "$ADM_SECRET" ]; then
    set -- "$@" \
      -c "delete from applications where tenant_id='admin' and name='infra admin (munni setup)' and id <> '$ADM_ID';" \
      -c "insert into applications (tenant_id, id, name, secret, description, type, oidc_client_metadata, custom_client_metadata) values ('admin', '$ADM_ID', 'infra admin (munni setup)', '$ADM_SECRET', 'created by the munni IaC bootstrap — claims the console admin', 'MachineToMachine', '$META', '{}') on conflict (id) do update set secret = excluded.secret, name = excluded.name;" \
      -c "insert into applications_roles (tenant_id, id, application_id, role_id) select 'admin', 'link1' || substr(md5('$ADM_ID'), 1, 16), '$ADM_ID', ar.role_id from applications_roles ar where ar.tenant_id = 'admin' and ar.application_id = 'm-admin' on conflict do nothing;"
  fi
  if docker compose --env-file "$ENV_FILE" -f "$COMPOSE_FILE" exec -T postgres psql -U munni -d logto -v ON_ERROR_STOP=1 -q "$@"; then
    echo "logto seed: machine credentials in place (infra + admin tenant) — the next IaC bootstrap turns sign-in into code"
    rm -f .logto-seed-pending
  else
    echo "logto seed FAILED — retried next cycle"
    touch .logto-seed-pending
  fi
}
if [ "$MODE" = "seed" ]; then
  logto_seed
  exit 0
fi

if [ -n "$GHCR_PAT" ]; then
  printf '%s' "$GHCR_PAT" | docker login ghcr.io -u "${GHCR_USER:-okkes}" --password-stdin
fi

# the api bind-mounts this folder; it is runtime data (gitignored), so
# bundles never carry it — ensure it exists or the api fails to create
# with "Bind mount failed"
mkdir -p import-watch

# ── one-shot PostgreSQL 17 → 18 (2026-07-17): a major can't open the old
#    data directory. Dump everything with a throwaway 17 server reading
#    the old volume, let 18 initialise the new volume, restore after up.
#    The old volume stays untouched as the rollback.
case "$COMPOSE_FILE" in
  *staging*)
    # ONLY the live staging stack shares the prod folder under the
    # munni-staging compose project. Any other folder (the iac twins,
    # whose compose files also match *staging*) is its own project with
    # default volume names — without this guard an iac-staging deploy
    # would inspect/remove the LIVE staging volumes.
    if [ "$(basename "$(pwd)")" = "munni" ]; then
      PG_PROJECT="munni-staging"; PG_OLD="pgdata_staging"; PG_NEW="pgdata18_staging"
    else
      PG_PROJECT="$(basename "$(pwd)")"; PG_OLD="pgdata"; PG_NEW="pgdata18"
    fi ;;
  *) PG_PROJECT="$(basename "$(pwd)")"; PG_OLD="pgdata"; PG_NEW="pgdata18" ;;
esac
# r2: the r1 attempt restored into the image's TEMPORARY bootstrap
# server (first-boot init) and died at its shutdown — the versioned
# name makes r1 markers invalid so those volumes get redone
PG_MARKER="pg18-restored-r2-$(basename "$COMPOSE_FILE" .yml).ok"
PG_RESTORE=""
# what the "old" volume really holds: a major is only migrated FROM 17.
# The iac twins keep their PostgreSQL 18 data in a volume named pgdata
# (found live 2026-09-16: this guard took each twin down, started a 17
# server on 18-format data, died on it, and did that every cycle — 502 on
# every host). 17 keeps PG_VERSION at the volume root, 18 under
# <major>/docker (the image's versioned data layout); no file = no data.
pg_data_version() {
  docker run --rm -v "$1":/d alpine:3 sh -c 'v=$(cat /d/PG_VERSION 2>/dev/null || cat /d/*/docker/PG_VERSION 2>/dev/null | head -n 1); echo "${v:-none}"' 2>/dev/null || echo unknown
}
if docker volume inspect "${PG_PROJECT}_${PG_OLD}" >/dev/null 2>&1 && [ ! -f "$PG_MARKER" ]; then
  PG_OLD_VERSION="$(pg_data_version "${PG_PROJECT}_${PG_OLD}")"
  case "$PG_OLD_VERSION" in
  17)
  echo "postgres 17->18: migrating (old volume present, no completion marker)"
  docker compose --env-file "$ENV_FILE" -f "$COMPOSE_FILE" down --remove-orphans >/dev/null 2>&1 || true
  # a half-migrated new volume (failed or RACED attempt — the 2026-07-17
  # outage: first-boot seeds beat the restore) is not data. Drop it; the
  # untouched 17 volume stays the source of truth and the rollback.
  docker volume rm "${PG_PROJECT}_${PG_NEW}" >/dev/null 2>&1 || true
  docker rm -f munni-pg17-dump >/dev/null 2>&1 || true
  docker run -d --name munni-pg17-dump \
    -v "${PG_PROJECT}_${PG_OLD}":/var/lib/postgresql/data postgres:17-alpine >/dev/null
  for _ in $(seq 1 30); do
    docker exec munni-pg17-dump pg_isready -U munni >/dev/null 2>&1 && break
    sleep 2
  done
  PG_RESTORE="pg17-to-18-$(date +%F).sql"
  # local socket = trust auth on the image's initdb defaults
  docker exec munni-pg17-dump pg_dumpall -U munni > "$PG_RESTORE"
  docker rm -f munni-pg17-dump >/dev/null
  [ -s "$PG_RESTORE" ] || { echo "pg dump came out empty — refusing to continue" >&2; exit 1; }
  ;;
  18)
    echo "postgres: ${PG_PROJECT}_${PG_OLD} already holds PostgreSQL 18 data — nothing to migrate"
    date > "$PG_MARKER" ;;
  *)
    echo "postgres: ${PG_PROJECT}_${PG_OLD} holds no PostgreSQL data to migrate (PG_VERSION=$PG_OLD_VERSION) — compose initialises it" ;;
  esac
fi

docker compose --env-file "$ENV_FILE" -f "$COMPOSE_FILE" pull

if [ -n "$PG_RESTORE" ]; then
  # restore BEFORE anything else boots: logto/glitchtip seed themselves
  # on an empty database, and a seed racing the restore leaves roles and
  # tenant rows disagreeing (the sign-in outage)
  echo "postgres 18: restoring $PG_RESTORE before dependents start"
  docker compose --env-file "$ENV_FILE" -f "$COMPOSE_FILE" up -d postgres
  # TCP, not the unix socket: the first-boot entrypoint runs a TEMPORARY
  # server (socket-only, TCP off) for initdb scripts and then shuts it
  # down — a socket pg_isready said "ready" and the r1 restore died at
  # that shutdown. Only the final server answers on TCP; require a few
  # consecutive OKs so a flapping start can't slip through either.
  PG_READY=0
  for _ in $(seq 1 90); do
    if docker compose --env-file "$ENV_FILE" -f "$COMPOSE_FILE" exec -T postgres pg_isready -h 127.0.0.1 -U munni >/dev/null 2>&1; then
      PG_READY=$((PG_READY + 1))
      [ "$PG_READY" -ge 3 ] && break
    else
      PG_READY=0
    fi
    sleep 2
  done
  [ "$PG_READY" -ge 3 ] || { echo "postgres 18 never became ready — aborting" >&2; exit 1; }
  # psql rolls past benign "already exists" lines but exits non-zero when
  # the session itself dies (the r1 failure mode) — only a clean run with
  # actually-restored data earns the marker
  RESTORE_RC=0
  docker compose --env-file "$ENV_FILE" -f "$COMPOSE_FILE" exec -T postgres psql -U munni -d postgres < "$PG_RESTORE" > pg18-restore.log 2>&1 || RESTORE_RC=$?
  [ "$RESTORE_RC" -eq 0 ] || { echo "pg restore aborted (rc=$RESTORE_RC) — see pg18-restore.log" >&2; exit 1; }
  SYNC_TABLES=$(docker compose --env-file "$ENV_FILE" -f "$COMPOSE_FILE" exec -T postgres psql -U munni -d munni -tAc "select count(*) from information_schema.tables where table_schema='public'" 2>/dev/null | tr -d '[:space:]')
  [ -n "$SYNC_TABLES" ] && [ "$SYNC_TABLES" -gt 0 ] || { echo "restored munni db has no tables — refusing the marker" >&2; exit 1; }
  date > "$PG_MARKER"
fi

# don't die before the status dump below — it captures WHY up failed
UP_RC=0
docker compose --env-file "$ENV_FILE" -f "$COMPOSE_FILE" up -d || UP_RC=$?
[ "$UP_RC" -eq 0 ] && logto_seed
docker image prune -f

# ── post-deploy status dump (survives container recreation; readable via
#    File Station / the NAS-diagnostics workflow) ─────────────────────────
sleep 20
{
  echo "=== status $(date '+%Y-%m-%d %H:%M:%S') $COMPOSE_FILE ==="
  docker compose --env-file "$ENV_FILE" -f "$COMPOSE_FILE" ps
  df -h /volume1 | tail -1
  # capture recent logs of anything not cleanly running — and always the
  # api, whose crash loop shows as "running (n seconds)" between restarts
  docker compose --env-file "$ENV_FILE" -f "$COMPOSE_FILE" ps --format '{{.Service}} {{.State}}' 2>/dev/null \
    | while read -r svc state; do
        case "$state" in
          running|*healthy*) : ;;
          *) echo "--- $svc ($state) last 60 log lines ---"
             docker compose --env-file "$ENV_FILE" -f "$COMPOSE_FILE" logs --tail=60 "$svc" 2>&1 ;;
        esac
      done
  echo "--- api last 40 log lines ---"
  docker compose --env-file "$ENV_FILE" -f "$COMPOSE_FILE" logs --tail=40 api 2>&1
  # logto restarts fast enough to look "running" at sample time — same
  # trick as the api: always capture it (absent in staging: harmless)
  echo "--- logto last 40 log lines ---"
  docker compose --env-file "$ENV_FILE" -f "$COMPOSE_FILE" logs --tail=40 logto 2>&1
} > "status-$(basename "$COMPOSE_FILE" .yml).log" 2>&1 || true
exit $UP_RC
