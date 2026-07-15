# NAS auto-deploy (GitHub → Synology, no SSH)

The flow: a master push builds the images, then the **Deploy to NAS**
workflow renders `.env` from a secret and uploads the deploy bundle to
the NAS over the FileStation API. A DSM Scheduled Task on the NAS runs
`apply.sh` every few minutes; when it sees a new `VERSION` it unpacks the
bundle and runs `update.sh` (which pulls the images and restarts the
stack).

## One-time NAS setup

1. **Make the NAS reachable** over HTTPS (QuickConnect or a port-forward
   to DSM, e.g. `https://okkes.synology.me:5001`).

2. **Dedicated deploy account** (Control Panel → User): e.g. `github-deploy`,
   member of a group with **FileStation** access and write permission to
   the target shared folder only. **Turn 2-Step Verification OFF** for this
   account — the login API cannot answer an interactive OTP. Give it no
   other privileges.

3. **Target folders** (File Station):
   - `…/docker/munni` — the live stack (already holds `update.sh` + `.env`)
   - `…/docker/munni/published` — where GitHub drops new bundles

4. **Place `apply.sh`** at `…/docker/munni/apply.sh` (copy it from this
   folder once; future updates ride inside the bundle).

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
| `NAS_ENV_FILE` | the **entire** production `.env` (every key in `env/.env.example`, real values) — this is what gets rendered into the bundle |

That's all — I need nothing else from you. Push to master (or run the
**Deploy to NAS** workflow by hand) and watch `…/docker/munni/deploy.log`
on the NAS.

## Why this shape

- **No SSH**: uploads use the FileStation HTTP API; the only thing that
  runs on the NAS is a local Task Scheduler script you installed.
- **Atomic-ish**: `VERSION` is uploaded last, so the poller never acts on
  a half-uploaded bundle. A failed `update.sh` leaves the running
  containers untouched and logs the error.
- **Secrets stay in GitHub**: `.env` is assembled at build time from
  `NAS_ENV_FILE` and delivered straight into the bundle; it never lives
  in the repo.
