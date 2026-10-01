# infra/ — platforms, environments and the setup wizard

munni runs on **platforms** (`lcl` = this computer with Docker Desktop,
`nas` = a Synology NAS; `rpi` is reserved) and every platform runs the
same shape: one **shared stack** (crash reports, the vault, pgAdmin, the
control cockpit, OCR) plus any number of **environments** (web, admin,
api, its own Logto, its own Postgres). The model is JSON under
`infra/platforms/` (see its README for every field) — on this computer, and on
GitHub as one repository variable per platform (`MUNNI_PLATFORM_<ID>`, #416): the
wizard publishes it on every save, every workflow job materializes it first,
nothing is committed; secrets never live in it. The setup wizard writes that
config, stores the credentials, and
hands everything to GitHub Actions — which builds the images and the
phone apps for every platform and deploys the NAS.

```
infra/setup/index.html + serve.mjs   the wizard page + its local helper (node infra/setup/serve.mjs, or start.cmd); a pull that moves serve.mjs leaves the running helper on the old code — the page says so at the top and restarts it on a click (automatic updates do it by themselves)
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
   store (`infra/rendered/wizard/.secrets.json`), one set per platform:
   platforms share nothing — values, ticks, the GitHub token and the
   upload keystore are each their own; only the Apple Development
   certificate is this computer's (Apple caps those per account).
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
   (and in every environment's), publishes the config and dispatches the
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
   publishes, dispatches Bootstrap + Deploy. From then on every successful
   image build deploys the environments on that channel by itself, and
   every push builds the phone apps of the environments that enable them.
   A stack whose GitHub environment does not exist yet is skipped by pushes
   and image builds — only a Bootstrap dispatch names it, and creates it.

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
publishes the platform's variable without it. The shared stack goes last, once no
environment is left (rules, containers, poller task, live dir, its
environment). Two things stay by hand — store records, and on a PC the
trusted roots of earlier https families — the Clean up tab and the local
platform card name the console steps, and the Clean up log counts the roots.

## Secrets

`infra/secrets.manifest.json` names every secret with its owner and
scope. `generated` ones are minted by the bootstrap (nas: into the GitHub
environment; lcl: into the stack's store); `operator` ones are typed once
per platform in the wizard and copied wherever the manifest says (platform scope →
`<platform>-shared` and every `<platform>-<env>`; env scope → the
environments whose features need it); `module` ones are written back by
Logto/GlitchTip after they ran. `--verify` fails loudly on drift. The
connector platform's entries (#367) follow the same rules: an environment
with `features.connectors` mints `CONNECTOR_SEAL_KEY_K1`,
`CONNECTOR_ENROLLMENT_HMAC` and `CONNECTOR_SUBJECT_SALT` and gets
`CONNECTOR_M2M_APP_ID/SECRET` written back by the Logto module (like
`LOGTO_M2M_APP_ID/SECRET`, the secret is the module's own application
secret `munni bootstrap` on the machine app, read back on every run —
Logto's application endpoints carry none); the platform mints
`CONNECTOR_FLEET_CODE` is the environment's own too (#420): its pooled
browser agents enroll with it at the control plane beside them; so is
`CONNECTOR_PRIVATE_CODE` (#420 A2), which its hosted private slots enroll
with — a different code on purpose, because a slot must serve nobody until
the operator binds it (the control plane refuses to start when the two are
equal).
Repository-level secrets and variables are not used, except the first-boot
latch `MUNNI_INITIALIZED` the wizard sets at Connect.

## Applied vs configured

A card that changes a platform or environment file shows a strip whenever what is
configured is not what runs — computed from facts, never remembered by the page.
On the NAS the applied config is what the last successful Bootstrap / Deploy run
recorded on the stack's GitHub environment (`MUNNI_APPLIED`: the config it ran with,
normalized the way every reader normalizes it), and the configured side has to be on
GitHub too (the platform's variable) before a run can read it; on this computer it is the
config the stack was last started with (`infra/rendered/<stack>/applied.json`,
stamped when the stack comes up). The strip names the changed keys
(`features.connectors: off → on`) and the one action that applies them — Bootstrap +
Deploy for anything that mints or registers something, Deploy again for the app
signing fingerprint alone, Publish first for a save GitHub does not hold yet,
Re-run setup on this computer — with a button that runs it and a *where is it?* that
scrolls to and flashes the card's own button. While a run that started after the last
publish is in flight the strip says so and clears when the run is through; a run that
started before it does not count. The checklists carry the same item, and a feature tile (a default for
the next environment) says which existing environments do not run it yet, linking to
their Settings.

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
