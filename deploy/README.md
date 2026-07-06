# Deploying munni on the Synology NAS

## One-time setup

1. **Folders**: create a share for the stack, e.g. `/volume1/docker/munni`,
   and copy this `deploy/` folder into it. Copy `env/.env.example` to
   `env/.env.local` and fill in every value.
2. **Container Manager**: create a *Project* pointing at
   `docker-compose.yml`, with the env file set to `env/.env.local`.
3. **Reverse proxy** (DSM → Login Portal → Advanced → Reverse Proxy), all
   HTTPS with the `*.okkes.synology.me` wildcard certificate:
   | Source | Destination |
   |---|---|
   | `munni.okkes.synology.me:443` | `localhost:8090` |
   | `munni-api.okkes.synology.me:443` | `localhost:8091` |
   | `logto.okkes.synology.me:443` | `localhost:3001` |
   | `logto-admin.okkes.synology.me:443` | `localhost:3002` |
   | `glitchtip.okkes.synology.me:443` | `localhost:8092` |

   For `munni-api` add WebSocket support off, and for all of them enable
   HTTP/2. Restrict `logto-admin` to LAN in DSM firewall rules.
4. **Logto** (first run): open `https://logto-admin.<domain>`, create the
   admin account, then:
   - Application → *munni* (Single-page app), redirect URI
     `https://munni.<domain>/#/auth/callback`, post-logout
     `https://munni.<domain>/`.
   - API resource → `https://munni-api.<domain>` (must equal
     `LOGTO_API_RESOURCE` in the env file).
5. **GlitchTip** (first run): open `https://glitchtip.<domain>`, create the
   organization + a project each for `munni-web` and `munni-api`; put the
   DSNs into the env file (`API_SENTRY_DSN`) and the web build config.
6. **Backups**: point Hyper Backup at `${BACKUP_DIR}` (nightly SQL dumps,
   14-day retention inside the container, longer retention via Hyper
   Backup). Do one restore drill: `psql -f munni-<date>.sql`.

## Updating

Images are built by GitHub Actions and pushed to `${REGISTRY}`. On the NAS,
a DSM Scheduled Task (root, daily or on demand) runs:

```sh
cd /volume1/docker/munni && docker compose --env-file env/.env.local pull && docker compose --env-file env/.env.local up -d
```

## Local test stack (CI / development)

`docker-compose.test.yml` runs api+postgres only, with header-based test
auth (`X-User-Sub`) instead of Logto:

```sh
docker compose -f deploy/docker-compose.test.yml up --build -d
curl -H "X-User-Sub: alice" http://localhost:8180/health
```
