# Deploying to the Synology NAS

The `nas` platform (infra/platforms/nas) is deployed by GitHub Actions
through the DSM File Station API — no SSH, nothing typed on the NAS.

## The one rule

`SYNOLOGY_PATH` (a platform secret, e.g. `/docker/munni-nas/published`)
is the File Station folder bundles land in. The **live dir is its
parent** (`/volume1/docker/munni-nas`): the poller script and the markers
live there, and every stack composes up in its own folder next to it
(`/volume1/docker/munni-nas-shared`, `/volume1/docker/munni-nas-prod`, …).

## Bundles and stamps

`deploy-nas.yml` renders each stack from the committed config
(`node infra/bootstrap.mjs --stack <name> --render-only`), fills the env
template from the stack's GitHub environment (`deploy/nas/render-env.sh`),
and uploads:

- `<stack>.tgz` (e.g. `munni-nas-prod.tgz`) — compose file, `.env`,
  `update.sh`, `initdb/`, and for the shared stack `pgadmin-servers.json`;
- `VERSION_<STACK>` — the stamp (`<sha>.<run number>`; a stamp reading
  `remove` tears the stack down);
- `apply.sh` into the live dir (the poller script rides along with every
  deploy, so it updates itself).

It runs on every successful image build (dev branch → stacks on channel
`dev`, master → `latest`) and on dispatch from the wizard or the Actions
UI.

## The poller

`deploy/nas/apply.sh` is a DSM Task Scheduler entry (root, every five
minutes) the shared stack's bootstrap creates through the DSM API. Each
cycle it looks at every `VERSION_*` stamp in the published folder — the
shared stack first, then the environments — unpacks a new bundle into the
stack's folder and runs `update.sh` there (`docker compose pull` + `up
-d`, then the seeds). Markers in the live dir: `.applied_<stack>` holds
the stamp last applied (or `removed`), `deploy.log` is the poller's own
log (read by every bootstrap and by `nas-diag.yml`).

Seeds (`deploy/update.sh`): an environment's first deploy inserts the
minted Logto machine credentials into Logto's database (`infra` with the
Management API role, and the admin-tenant credential that claims the
console); the shared stack's deploy creates GlitchTip's admin and API
token inside the container. A seed that cannot run yet (the service still
booting) leaves `.logto-seed-pending` / `.glitchtip-seed-pending` and the
poller retries it every cycle. `deploy/nas/after-apply.mjs` waits in the
workflow until the marker matches and the services answer with the
seeded credentials, then the Bootstrap runs once more and writes the app
ids and DSNs back.

## Cleanup

`iac.yml` with `cleanup=true` (the wizard's Clean up button): the
environment's GlitchTip projects, its reverse-proxy rules, a `remove`
stamp (the poller stops the containers, drops the volumes, deletes the
folder), its GitHub environment and its platform file (committed by the
workflow). The shared stack goes last, once no environment is left: its
rules, containers, the poller task and the live dir. The wildcard
certificate stays.

## Diagnostics

`nas-diag.yml` downloads `deploy.log` (or any file of the live dir) as an
artifact; every Bootstrap prints the poller's last lines in its summary.
