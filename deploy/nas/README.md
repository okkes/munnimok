# NAS auto-deploy (GitHub → Synology, no SSH, no manual uploads)

The flow: a push builds the images, then the **Deploy to NAS** workflow
assembles a deploy bundle and uploads it to the NAS over the FileStation
API. A DSM Scheduled Task runs `apply.sh` every few minutes; on a new
version stamp it unpacks the bundle over the live directory (scripts
included — everything self-updates) and runs `update.sh`, which pulls
the images and restarts the stack.

Two channels, both handled:

| Branch | Uploads | What gets updated on the NAS |
|---|---|---|
| `master` | `munni-deploy.tgz` + `VERSION` | **production** stack, then **staging** (a release moves both) — bundle includes compose files, nginx conf, scripts and the rendered `.env` |
| `dev` | `munni-deploy-staging.tgz` + `VERSION_STAGING` | **staging** only (tests dev's compose changes before a release) |

## Secrets: template + placeholders

`deploy/env/.env.nas` is committed to the repo with real values for
everything non-secret and `${NAS_*}` placeholders for secrets:

```
POSTGRES_PASSWORD=${NAS_POSTGRES_PASSWORD}
FCM_SERVICE_ACCOUNT_JSON='${NAS_FCM_SERVICE_ACCOUNT_JSON}'
```

CI renders it with `render-env.sh`: each placeholder is filled from the
**same-named GitHub repository secret**. Adding a key = add the line to
the template + create the `NAS_*` secret; no workflow change. The render
fails the deploy if `NAS_GHCR_PAT` or `NAS_POSTGRES_PASSWORD` are
missing; other empty secrets just leave their feature off.

⚠ The rendered `.env` **overwrites** the one on the NAS with every
master deploy — never edit `.env` on the NAS by hand.

### NAS_* secrets to create

Required: `NAS_GHCR_PAT`, `NAS_POSTGRES_PASSWORD`.
Feature secrets (empty = feature off): `NAS_GLITCHTIP_SECRET_KEY`,
`NAS_GLITCHTIP_EMAIL_URL`, `NAS_API_SENTRY_DSN`,
`NAS_GOCARDLESS_SECRET_ID`, `NAS_GOCARDLESS_SECRET_KEY`,
`NAS_ADMIN_SUBS`, `NAS_PGADMIN_PASSWORD`, `NAS_PUSH_VAPID_PUBLIC_KEY`,
`NAS_PUSH_VAPID_PRIVATE_KEY`, `NAS_FCM_SERVICE_ACCOUNT_JSON` (paste the
raw one-line JSON, no surrounding quotes — the template quotes it),
`NAS_LOGODEV_SECRET_KEY`, `NAS_LOGODEV_PUBLIC_TOKEN`,
`NAS_IMPORT_WATCH_OWNER_SUB`, `NAS_ENABLEBANKING_APPLICATION_ID`,
`NAS_ENABLEBANKING_PRIVATE_KEY_PEM`.

## One-time NAS setup

1. **Make the NAS reachable** over HTTPS (QuickConnect or a port-forward
   to DSM, e.g. `https://okkes.synology.me:5001`).

2. **Dedicated deploy account** (Control Panel → User): e.g. `github-deploy`,
   member of a group with **FileStation** access and write permission to
   the target shared folder only. **Turn 2-Step Verification OFF** for this
   account — the login API cannot answer an interactive OTP. Give it no
   other privileges.

3. **Target folders** (File Station):
   - `…/docker/munni` — the live stack
   - `…/docker/munni/published` — where GitHub drops new bundles

4. **Bootstrap `apply.sh`** once: copy it from this folder to
   `…/docker/munni/apply.sh`. After that it self-updates from every
   bundle — this is the only manual upload, ever.

5. **DSM Task Scheduler** → Create → Scheduled Task → User-defined script:
   - User: `root` (needs docker)
   - Schedule: daily, **repeat every 5 minutes**
   - Run command (the copy makes self-update safe — tar must never
     overwrite the script the shell is currently reading):
     ```
     cd /volume1/docker/munni && cp apply.sh .apply.run && sh .apply.run
     ```
   Adjust the path if your volume/share differs; override with
   `MUNNI_LIVE_DIR` / `MUNNI_PUBLISHED_DIR` env vars if needed.

## GitHub secrets for the upload itself

| Secret | Value |
|---|---|
| `SYNOLOGY_URL` | `https://okkes.synology.me:5001` (DSM HTTPS endpoint) |
| `SYNOLOGY_USER` | the `github-deploy` account |
| `SYNOLOGY_PASS` | its password |
| `SYNOLOGY_PATH` | `/docker/munni/published` (FileStation path, no volume prefix) |

Then push to master or dev (or run **Deploy to NAS** by hand) and watch
`…/docker/munni/deploy.log` on the NAS.

## Why this shape

- **No SSH**: uploads use the FileStation HTTP API; the only thing that
  runs on the NAS is the local Task Scheduler script.
- **No secret values in git**: the template carries placeholders; values
  live in GitHub secrets and are injected at render time.
- **Atomic-ish**: the version stamp is uploaded last, so the poller
  never acts on a half-uploaded bundle. A failed `update.sh` leaves the
  running containers untouched and logs the error; prod and staging
  fail independently.
