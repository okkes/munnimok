# Deploying munni on the Synology NAS

## One-time setup

0. **Images**: GitHub Actions builds and pushes `munni-api` / `munni-web`
   to **GHCR** (`ghcr.io/okkes/...`, private) on every push to master
   (`.github/workflows/release-images.yml`). The Synology registry stays
   LAN-only — GitHub runners cannot reach it, so it is not used for CI.
   Nothing can be pulled before that workflow has run green at least once.
1. **Folders**: create a share for the stack, e.g. `/volume1/docker/munni`,
   and copy this `deploy/` folder into it. Fill in `env/.env.example` →
   `env/.env.local`, then copy it to a file named exactly `.env` **next to
   `docker-compose.yml`** — Container Manager has no env-file picker;
   docker compose only auto-reads a sibling `.env`:
   ```sh
   cp env/.env.local .env
   ```
2. **Registry login** (pulling private GHCR images needs credentials —
   the "no basic auth credentials" error means this step is missing):
   - Create a GitHub **fine-grained PAT** (or classic token) with only
     `read:packages`: github.com → Settings → Developer settings →
     Personal access tokens.
   - Once via SSH on the NAS (covers Container Manager and scheduled
     tasks): `sudo docker login ghcr.io -u okkes` and paste the token as
     the password.
   Then create the *Project* in Container Manager pointing at
   `docker-compose.yml` in that folder.
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

Images are built by GitHub Actions and pushed to GHCR. On the NAS, a DSM
Scheduled Task (user: root, daily or on demand) runs:

```sh
bash /volume1/docker/munni/update.sh
```

`update.sh` re-authenticates to ghcr.io from the `GHCR_USER`/`GHCR_PAT`
values in `.env` on every run, then pulls and restarts changed services —
so it keeps working across reboots and even if Docker's stored login is
ever wiped. The one-time manual `docker login` in step 2 is only needed
for the very first pull via the Container Manager GUI.

## Local test stack (CI / development)

`docker-compose.test.yml` runs api+postgres only, with header-based test
auth (`X-User-Sub`) instead of Logto:

```sh
docker compose -f deploy/docker-compose.test.yml up --build -d
curl -H "X-User-Sub: alice" http://localhost:8180/health
```
