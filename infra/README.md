# infra/ — platforms, environments and the setup wizard

munni runs on **platforms** (`lcl` = this computer with Docker Desktop,
`nas` = a Synology NAS; `rpi` is reserved) and every platform runs the
same shape: one **shared stack** (crash reports, the vault, pgAdmin, the
control cockpit, OCR) plus any number of **environments** (web, admin,
api, its own Logto, its own Postgres). The model lives in committed JSON
under `infra/platforms/` (see its README for every field); secrets never
do. The setup wizard writes that config, stores the credentials, and
hands everything to GitHub Actions — which builds the images and the
phone apps for every platform and deploys the NAS.

```
infra/setup/index.html + serve.mjs   the wizard page + its local helper (node infra/setup/serve.mjs, or start.cmd)
infra/platforms/<p>/platform.json    the platform (delivery, registry, published path, control environment)
infra/platforms/<p>/envs/<env>.json  one environment (slot, channel, features, store ids)
infra/secrets.manifest.json          every secret: owner (generated | operator | module), scope (env | platform | stack | wizard), feature
infra/bootstrap.mjs                  the ONE entry point per stack (nas: in GitHub Actions; lcl: run by the helper)
infra/modules/                       stack model, render, secrets, Logto, GlitchTip, vault, DSM
infra/ci/matrix.mjs                  the workflows' matrices from the config
infra/rendered/                      gitignored: rendered compose/env files, the wizard's own store, the lcl stores
```

## How a platform comes to life

### lcl — this computer

1. Start the helper (`infra/setup/start.cmd`), connect GitHub (a
   fine-grained token for this repo: Administration, Secrets, Variables,
   Actions, Contents — read/write), tick the features you want and store
   the credentials on their tiles. Every value lands in the wizard's own
   store (`infra/rendered/wizard/.secrets.json`).
2. On the platform card: *Set up & start*. The helper mints the shared
   stack's secrets, renders it, starts it (GlitchTip, the vault, pgAdmin,
   control, the family Caddy), then does the same for every environment
   you add: own Postgres, own Logto — seeded straight into Logto's
   database with the minted machine credentials, so apps, the API
   resource with its `admin` scope, the `munni admin` role, social
   connectors, branding and the console's admin all become code without
   a console visit; GlitchTip's admin and API token are created inside
   the container; every credential is kept in the platform's vault.
3. LAN mode moves the family onto real https hostnames
   (`munni-<env>-lcl.<ip-dashed>.sslip.io`, a local CA the helper trusts
   on this PC and the phone apps carry); the helper keeps the family
   current by itself (pull, re-render, up) and can start at logon.

### nas — the Synology NAS

1. Platform card: the domain (Synology DDNS covers `*.<domain>`), the
   deploy account (a DSM administrator with DSM + File Station allowed,
   2FA off — the wizard checks it from here), the published folder, the
   platform's vault account (generated). *Set up shared services* creates
   the GitHub environment `nas-shared`, stores the platform values there
   (and in every environment's), commits the config and dispatches the
   **Bootstrap** workflow for `munni-nas-shared` with a chained Deploy.
2. The Bootstrap (GitHub Actions, `iac.yml`) mints the shared stack's
   secrets, mirrors the platform-scoped ones into every `nas-<env>`
   environment, writes the reverse-proxy rules through the DSM API,
   requests the wildcard Let's Encrypt certificate through DSM and binds
   the rules to it, puts the poller script in the live dir and creates
   the Task Scheduler entry. **Deploy** (`deploy-nas.yml`) renders the
   bundle from the config, fills the env from the GitHub environment
   (every secret named explicitly — never `toJSON(secrets)`), uploads it
   through File Station; the poller composes it up within five minutes,
   the seeds run inside the containers, and the workflow re-runs the
   Bootstrap once the services answer with the seeded credentials so the
   app ids and DSNs are written back (deploy/nas/README.md has the
   mechanics).
3. *Add environment*: name, channel (`dev` = the dev branch's images,
   `latest` = releases), features, store ids. The wizard writes
   `envs/<env>.json`, creates `nas-<env>`, stores what its features need,
   commits, dispatches Bootstrap + Deploy. From then on every successful
   image build deploys the environments on that channel by itself, and
   every push builds the phone apps of the environments that enable them.

Hosts: `munni-<env>-nas.<domain>` (+ `-api`, `-admin`, `-logto`,
`-logto-admin`) and `glitchtip-nas`, `vault-nas`, `control-nas`,
`pgadmin-nas`. LAN-restrict the admin, console, vault, control and pgAdmin
hosts in the DSM firewall, and allow `172.16.0.0/12` (docker) so Logto
reaches its own console endpoint through the host.

## Admin access

The API admits a token carrying the `admin` scope; the environment's
Logto grants that scope to users holding the `munni admin` role. The
wizard's **Access** tab lists the environment's users (name, e-mail, id)
and toggles the role — nobody types a subject anywhere. On the NAS the
wizard reads the environment's machine credential from the platform's
vault (folder `<stack>`), where the Bootstrap keeps everything it mints.

## Phones

One store identity per environment (`app.munni.<platform>.<env>` by
default, changeable per environment). The wizard registers the Apple App
ID with its capabilities, registers both apps at Firebase (push) with the
Play service account's own project, writes the environment's `NATIVE_*`
variables into `<platform>-<env>`, and dispatches the builds; the signed
artifacts publish to Play internal testing and TestFlight once the store
records exist. Creating those records is the one thing Apple and Google
keep manual — the Phones tab says exactly which.

## Cleanup

Clean up on an environment: lcl — GoCardless consents revoked, GlitchTip
projects removed, containers + volumes + network destroyed, the config
file removed; nas — the Bootstrap workflow with `cleanup=true` does the
same through the API and the poller, deletes the GitHub environment and
commits the removed config file. The shared stack goes last, once no
environment is left (rules, containers, poller task, live dir, its
environment). Two things stay by hand — store records, and on a PC the
trusted roots of earlier https families — the wizard's Leftovers card
lists them and the Clean up log counts the roots.

## Secrets

`infra/secrets.manifest.json` names every secret with its owner and
scope. `generated` ones are minted by the bootstrap (nas: into the GitHub
environment; lcl: into the stack's store); `operator` ones are typed once
in the wizard and copied wherever the manifest says (platform scope →
`<platform>-shared` and every `<platform>-<env>`; env scope → the
environments whose features need it); `module` ones are written back by
Logto/GlitchTip after they ran. `--verify` fails loudly on drift.
Repository-level secrets and variables are not used, except the first-boot
latch `MUNNI_INITIALIZED` the wizard sets at Connect.

## Day-2

- Every push to dev builds `dev` images and deploys the `dev`-channel
  environments; every release (master) builds `latest` and deploys the
  `latest`-channel ones.
- Rotate a generated secret: dispatch Bootstrap with `rotate=<NAME>`
  (a Logto machine credential re-seeds on the next deploy).
- `nas-diag.yml` fetches the poller's log; every Bootstrap summary prints
  its last lines and what the NAS holds (certificate, task, bindings).
- `node infra/bootstrap.mjs --stack <name> --verify` probes reality (nas:
  with the platform secrets in the shell).
