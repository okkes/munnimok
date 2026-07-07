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

## Staging environment (dev branch)

Pushes to the `dev` branch build `:dev`-tagged images. The staging stack
(`docker-compose.staging.yml`) runs beside production with its own
database, sharing the production Logto/GlitchTip containers:

1. Reverse proxy: `munni-test.` → `localhost:8095`, `munni-test-api.` →
   `localhost:8096` (same wildcard cert).
2. Logto console: register a second SPA app for
   `https://munni-test.<domain>` (redirect `/auth-callback`, post
   sign-out `/`, CORS origin) and an API resource
   `https://munni-test-api.<domain>`; put the app id in the repo's
   Actions **Variables** as `VITE_LOGTO_APP_ID_DEV`.
3. Start/update: `bash update.sh docker-compose.staging.yml` (own
   scheduled task, or run on demand).

Flow: feature work merges into `dev` → verify at munni-test → merge
`dev` into `master` → production picks it up on the next update.

## Local full-stack test (before touching the NAS)

Everything except HTTPS/reverse-proxy, on localhost:

1. `docker compose --env-file deploy/env/.env.local -f deploy/docker-compose.local.yml up -d --build`
   (from the repo root; GoCardless keys are passed through if present)
2. Open the Logto admin console at **http://localhost:3002**, create the
   admin account, then:
   - *Applications* → Create → **Single-page app**, name `munni`:
     - Redirect URI: `http://localhost:5173/auth-callback`
     - Post sign-out redirect URI: `http://localhost:5173/`
     - CORS allowed origin: `http://localhost:5173`
   - *API resources* → Create: identifier exactly `http://localhost:8180`
3. Put the app id into `apps/web/.env.local` (git-ignored):
   ```
   VITE_API_URL=http://localhost:8180
   VITE_LOGTO_ENDPOINT=http://localhost:3001
   VITE_LOGTO_APP_ID=<the app id from step 2>
   VITE_LOGTO_RESOURCE=http://localhost:8180
   ```
4. `npm run dev` (repo root) and open http://localhost:5173 — the login
   screen now shows the real **Sign in** button. Create a user in the
   Logto sign-up flow, and you're in a fully syncing account: open a
   second browser (or private window), sign in with the same user, and
   watch edits flow between them.
5. Bank connect (optional, uses your real GoCardless account): add
   account → *Connect your bank*. The consent redirect returns to
   `http://localhost:5173/gc-callback`.

Tear down with `docker compose -f deploy/docker-compose.local.yml down`
(add `-v` to also wipe the local database volume).

## Local test stack (CI / development)

`docker-compose.test.yml` runs api+postgres only, with header-based test
auth (`X-User-Sub`) instead of Logto:

```sh
docker compose -f deploy/docker-compose.test.yml up --build -d
curl -H "X-User-Sub: alice" http://localhost:8181/health
```

## SonarQube analysis (local machine only)

SonarQube needs ~2-3 GB RAM, so it never runs on the NAS — spin it up
locally when you want a quality report:

1. `docker compose -f deploy/docker-compose.sonar.yml up -d` and wait
   for http://localhost:9000 (first boot takes a minute or two).
2. First time only: log in `admin` / `admin`, set a new password, then
   *My Account → Security → Generate token* and add
   `SONAR_TOKEN=<token>` to `deploy/env/.env.local`.
3. `./deploy/sonar/analyze.ps1` — runs the web tests with coverage and
   uploads the `munni-web` analysis (the scanner runs in Docker, nothing
   to install). The API is analyzed too if `dotnet-sonarscanner` +
   Java 17 are installed; otherwise CodeQL in CI keeps covering C#.
4. `docker compose -f deploy/docker-compose.sonar.yml down` when done
   (analysis history survives in the named volumes).
