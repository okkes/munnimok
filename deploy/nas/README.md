# The NAS side of the IaC twins

Everything here runs on the Synology NAS without SSH: GitHub publishes
through the FileStation API, a root Task Scheduler entry (the poller)
applies. The legacy live pipeline was archived on 2026-09-17 under the
git tag `archive/legacy-cicd`; this folder serves the IaC twins only.

## The one rule: live dir = the parent of `SYNOLOGY_PATH`

`SYNOLOGY_PATH` is the published folder (e.g. `/docker/munni-iac/published`).
Its parent is the live dir (`/docker/munni-iac` → `/volume1/docker/munni-iac`,
resolved through the share's real path, never guessed). The live dir
holds `apply.sh`, `deploy.log`, the stamp markers; the twins unpack NEXT to
it: `/volume1/docker/munni-iac-prod`, `/volume1/docker/munni-iac-staging`.

## What Deploy uploads (deploy-nas.yml, channel iac-prod | iac-staging | iac-both)

- `apply.sh` into the live dir (the task runs a throwaway copy, so
  overwriting the running script is safe);
- `munni-deploy-iac-<twin>.tgz` (compose + env rendered from the twin's
  GitHub Environment + `update.sh` + initdb) into the published folder;
- `VERSION_IAC_<TWIN>` last, so the poller never sees a stamp before its
  bundle. The stamp is `<sha>.<run number>`: every deploy is new.

## The poller (`apply.sh`, every 5 minutes, root)

Ensured by the prod twin's IaC bootstrap (DSM Task Scheduler through the
API, `munni deploy poller`); by hand the same command:

```
cd "<live dir>" && cp apply.sh .apply.run && MUNNI_LIVE_DIR="<live dir>" MUNNI_PUBLISHED_DIR="<live dir>/published" sh .apply.run
```

Each cycle: a new stamp → unpack the bundle into the twin's folder → run
its `update.sh` (registry login, the Postgres 17→18 migration guard that
reads the volume's real version, `docker compose up -d`, then the seeds:
the Logto machine credentials and the GlitchTip admin + API token the
bootstrap minted, inserted once, idempotently). A seed the service is not
ready for leaves a pending marker the next cycle retries. Everything is
logged to `deploy.log` — `--verify` and Deploy's after-apply step print
its tail through FileStation, so nothing needs SSH.

## Removal

`bootstrap --cleanup` (the wizard's Clean up) uploads a stamp reading
`remove`: the next cycle stops the twin's containers (`docker compose
down -v --remove-orphans` with its env file), deletes its folder, bundle
and stamp, and writes `removed` into the marker so the workflow can tell.
A pair cleanup then deletes the poller task and the live dir through the
DSM API.

## Locks and markers

`.apply.lock2` + `.apply.pid` (flock; a wedged holder is killed by age),
`.applied_version_iac_prod` / `_iac_staging` (what is applied),
`.logto-seed-pending` / `.glitchtip-seed-pending` (retry), `pg18-restored-*.ok`.
