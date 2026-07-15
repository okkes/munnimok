# NAS auto-deploy (GitHub → Synology, no SSH)

The flow: a push builds the images, then the **Deploy to NAS** workflow
uploads the deploy bundle (compose files, nginx conf, `update.sh` —
**never** `.env`) to the NAS over the FileStation API. A DSM Scheduled
Task on the NAS runs `apply.sh` every few minutes; when it sees a new
version stamp it unpacks the bundle and runs `update.sh`, which pulls
the images and restarts the stack.

Two channels, both handled:

| Branch | Uploads | What gets updated on the NAS |
|---|---|---|
| `master` | `munni-deploy.tgz` + `VERSION` | **production** stack, then **staging** (a release moves both) |
| `dev` | `munni-deploy-staging.tgz` + `VERSION_STAGING` | **staging** only (tests dev's compose changes before a release) |

## Where secrets live

`.env` (and optional `.env.staging`) stay **on the NAS only** — they are
not in the repo and not a GitHub secret. The repo carries
`deploy/env/.env.example` with placeholders as the reference. When a
release introduces a new key, add it to the NAS `.env` by hand (File
Station → edit) — the release notes will call it out.

**Formatting rule for values with spaces/quotes (e.g.
`FCM_SERVICE_ACCOUNT_JSON`)**: put the whole value in single quotes on
one line:

```
FCM_SERVICE_ACCOUNT_JSON='{"type": "service_account", ...}'
```

`update.sh` never `source`s the env file (that's what produced
`service_account,project_id:: command not found`) — docker compose
parses it directly, and the single quotes are stripped by compose.

## One-time NAS setup

1. **Make the NAS reachable** over HTTPS (QuickConnect or a port-forward
   to DSM, e.g. `https://okkes.synology.me:5001`).

2. **Dedicated deploy account** (Control Panel → User): e.g. `github-deploy`,
   member of a group with **FileStation** access and write permission to
   the target shared folder only. **Turn 2-Step Verification OFF** for this
   account — the login API cannot answer an interactive OTP. Give it no
   other privileges.

3. **Target folders** (File Station):
   - `…/docker/munni` — the live stack (holds `update.sh`, `.env`,
     compose files)
   - `…/docker/munni/published` — where GitHub drops new bundles

4. **Place `apply.sh`** at `…/docker/munni/apply.sh` (copy it from this
   folder; re-copy on the rare occasion it changes — it deliberately does
   NOT self-update from the bundle, since overwriting a running shell
   script corrupts it).

5. **DSM Task Scheduler** → Create → Scheduled Task → User-defined script:
   - User: `root` (needs docker)
   - Schedule: daily, **repeat every 5 minutes**
   - Run command:
     ```
     sh /volume1/docker/munni/apply.sh
     ```
   Adjust the path if your volume/share differs; override with
   `MUNNI_LIVE_DIR` / `MUNNI_PUBLISHED_DIR` env vars if needed.

## GitHub secrets to add

| Secret | Value |
|---|---|
| `SYNOLOGY_URL` | `https://okkes.synology.me:5001` (DSM HTTPS endpoint) |
| `SYNOLOGY_USER` | the `github-deploy` account |
| `SYNOLOGY_PASS` | its password |
| `SYNOLOGY_PATH` | `/docker/munni/published` (FileStation path, no volume prefix) |

That's all. Push to master or dev (or run the **Deploy to NAS** workflow
by hand) and watch `…/docker/munni/deploy.log` on the NAS.

## Why this shape

- **No SSH**: uploads use the FileStation HTTP API; the only thing that
  runs on the NAS is a local Task Scheduler script you installed.
- **No secrets in transit or in GitHub**: the bundle is pure infra;
  `.env` never leaves the NAS.
- **Atomic-ish**: the version stamp is uploaded last, so the poller
  never acts on a half-uploaded bundle. A failed `update.sh` leaves the
  running containers untouched and logs the error; prod and staging
  fail independently.
