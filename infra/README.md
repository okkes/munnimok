# infra/ — from zero to a running munni pair, step by step

**Start here: open `infra/setup/index.html` in your browser** (straight
from the checkout — no server, no install). The setup wizard walks this
whole document interactively: it explains every third-party account,
stores the secrets for you (client-side sealed-box encryption, straight
to the GitHub API), runs the bootstrap and deploy workflows at the click
of a button, and shows live per-step status. It only ever talks to
api.github.com; the PAT you paste stays in the tab's memory.

The text below is the same flow as prose — the fallback and the
reference. The NAS and Raspberry Pi tracks share Part A and split in
Part B; the **local track** (full ecosystem on Docker Desktop) is
self-contained in the wizard and in `runbook.munni-local.md` after a
`node infra/bootstrap.mjs --stack munni-local`.

> The NAS domain is a SECRET here (public repo): wherever you see
> `<domain>`, that's the value of the `IAC_DOMAIN` secret.

---

## Part A — shared groundwork (once ever)

**A1. Repo secrets.** The wizard's step 0–3 create all of these for you
(GitHub → Settings → Secrets and variables → Actions → *Repository*
secrets, if doing it by hand):

| Secret | What |
|---|---|
| `IAC_DOMAIN` | your DDNS domain (e.g. `xxxx.synology.me`) |
| `IAC_GH_PAT` | fine-grained PAT, THIS repo, permissions: Administration RW + Secrets RW + Variables RW + Actions RW (bootstrap writes environment secrets — `GITHUB_TOKEN` cannot; the wizard also dispatches workflows with it) |
| `SYNOLOGY_URL` / `_USER` / `_PASS` / `_PATH` | DSM deploy account (FileStation + reverse-proxy writes; admin rights, 2FA off AND Adaptive MFA off for administrators — B1-1) — shared with deploy-nas.yml |
| `NAS_GHCR_PAT` | optional — the munni images are public; a classic PAT with read:packages only for private images |
| `NAS_GOCARDLESS_SECRET_ID` / `_KEY` | GoCardless portal |
| optional: `NAS_ENABLEBANKING_*`, `NAS_FCM_SERVICE_ACCOUNT_JSON`, `NAS_LOGODEV_*`, `LOGTO_GOOGLE_*`, `LOGTO_APPLE_*` | as per feature |

`infra/secrets.manifest.json` is the authoritative inventory (owners,
scopes, platform tags); `bootstrap --verify` fails loudly on drift and
the wizard cross-checks its own coverage against it.

**A2. First bootstrap run.** Wizard step 4 — or Actions → *IaC
bootstrap* → Run workflow → stack `munni-iac-prod`, then
`munni-iac-staging`. It creates the `iac-production`/`iac-staging`
environments, mints every generated secret (postgres, VAPID, GlitchTip
key…), renders compose+env and uploads them plus a personalized
`runbook.<stack>.md` as the run artifact; the bootstrap output also
lands in the run's step summary. **The runbook artifact is your
worksheet for everything below.**

**A3. DNS.** With Synology DDNS the `*.<domain>` wildcard already
resolves; external registrars need records for the hosts listed in the
runbook (`munni-iac.<domain>`, `munni-iac-test.<domain>`, …).

---

## Part B1 — NAS track

**B1-1 (once per NAS).** Make sure the deploy account (SYNOLOGY_USER)
has DSM *administrator* rights and may use the DSM and File Station
applications (User & Group → the user → Applications; a group's Deny
beats Allow) — every NAS step below is admin-only on DSM, and no
account can grant itself those rights (that is why this one step is
yours). And switch **Adaptive MFA** off for administrators (Control
Panel → Security → Account): DSM applies Adaptive MFA by default to every administrator without 2FA, treats a sign-in from GitHub's runners as risky (external network, unknown device) and, with no e-mail on the account to send the code to, grants a plain user's session — every Control Panel API then answers 105 while File Station uploads still work (found live 2026-09-16); DSM's own init data
says `is_admin=false` for such a session and `--verify` prints it per
login shape. The alternative — 2FA on for the account with its OTP
secret in the pipeline — is not supported yet. A `dsm: … failed` line in the bootstrap output with code 402
(the account may not use the application the login names) or 105
(not an administrator) is exactly that — but check the `login shapes`
line `--verify` prints on a 402 first: DSM 7.3.2 refuses a session name
it does not know with the same 402 (found live 2026-09-16 with a correct
account: `session=Core` refused, no session and `FileStation` accepted),
which is why the bootstrap logs in without one, like DSM's own UI. With the account right, the IaC workflow does the rest through
the DSM API, idempotently on every run: every reverse-proxy rule, the
wildcard Let's Encrypt certificate (`<domain>;*.<domain>`, requested
through DSM's own wizard call and set as default — the DDNS default
covers only `<domain>` itself — and the stack's rules are bound to it,
because DSM keeps a rule on the certificate it was created with), the
live dir (`apply.sh` + the published folder; the live dir is the PARENT
of `SYNOLOGY_PATH`, one rule everywhere), and the poller task (root,
every 5 minutes, running a throwaway copy of `apply.sh`, which every
deploy re-uploads). The prod twin owns those NAS-wide pieces; the
staging run only binds its own rules to the certificate it finds. The
wizard dispatches the prod twin with `chain=staging,deploy-both` (once
the SYNOLOGY_* secrets are stored — the run reads them from GitHub): a
green run bootstraps the staging twin and then deploys both — no click
left after the account fix (the Bootstrap button chains `deploy` for its
twin; iac.yml serializes applies per stack, verifies collapse in a group
of their own). A NAS step failing for anything but the account's rights
makes the run red — including a Let's Encrypt request still running when
the six-minute wait ends (the next run adopts the certificate; never
re-request by hand, every request counts against the 5-per-week limit).
Optional secret `IAC_ACME_EMAIL` is the Let's Encrypt contact (default
`admin@<domain>`).
A run DSM refuses (402/105) stays green for the Logto/GlitchTip work
it did, but chains NOTHING (step output `nas=blocked`, a notice in the
summary) — a Deploy over a NAS without rules would only fail at the
FileStation login. Every verify/apply of the prod twin publishes the
NAS verdict as the repo variable `IAC_NAS_STATE` (flags and counts, no
host names): the wizard's readiness card shows it as its first row with
the exact DSM clicks written under the rows, and its **Bootstrap now**
button dispatches the chained run — no retyping in the tile. A verify
you dispatch (`verify_only`) is red while gaps remain; pushes only warn.
A poller made by hand (the README one-liner, any name) for the SAME live
dir is adopted by bootstrap — renamed, pointed at the resolved dirs —
never doubled; one for another dir is another pipeline's and stays as it
is. (The legacy live pipeline was archived on 2026-09-17 — tag
`archive/legacy-cicd`; the twins are the only NAS deployment now.)
The wizard's **NAS readiness** card (Deploy step, with the helper running)
probes every reverse-proxy host from outside and names the step each one
still misses — DNS, the wildcard certificate, the rule (DSM answers Web
Station's page when none matches), the applied bundle (a rule answering
502) — and a Synology check that DSM accepts dispatches Bootstrap by
itself (after the secrets are stored). Only two more things stay manual
(the workflow's verify step probes both):
- Firewall: allow `172.16.0.0/12` in the access profile; restrict the
  `*-admin` hosts to LAN.
- Certificate: automated for Synology DDNS domains (above); own domains
  need acme.sh with the `synology_dsm` deploy hook (docs/iac-plan.md §4)
  because only Synology's DDNS can validate a wildcard. `--verify` names
  every host the certificate misses and reports the certificate and
  poller task DSM holds.

**B1-2 (once per stack — one workflow click).** Wizard step 5, or
Actions → *Deploy to NAS* → Run workflow → channel `iac-prod` /
`iac-staging` / `iac-both`. The workflow renders the stack from its
GitHub Environment (secrets AND written-back variables, each one named
in the workflow's `env:` — never `toJSON(secrets)`, the pattern GitHub's
scanner holds public-repo runs for; a placeholder without its line fails
`infra/tests/deploy-nas.test.mjs`), publishes the bundle via FileStation, and the NAS poller unpacks it into
`/volume1/docker/<stack>/` and runs `docker compose up -d` there. No
SSH, no manual copying.

## Part B2 — Raspberry Pi track (after PI3 lands)

**B2-1 (once per Pi).** Flash Raspberry Pi OS Lite (64-bit), attach an
SSD (Postgres on SD cards dies young), then run
`deploy/pi/install.sh` — it installs docker + compose, creates
`/opt/munni`, and arms the systemd bundle-poll timer. *(install.sh is
slice PI3 of docs/raspberry-pi-plan.md — until it lands, this track
is not yet available; the wizard shows it as planned.)*

**B2-2 (once per stack).** Same artifact files to `/opt/munni/<stack>/`,
`docker compose up -d`. The bundled Caddy (PI4) terminates HTTPS with
Let's Encrypt — no DSM, no reverse-proxy console, DNS must point at
the Pi.

---

## Part C — auth + observability (once per PAIR)

Social sign-in stays a paste, by provider design: Google has no API that
creates a consent screen or an OAuth client (only Identity-Aware-Proxy
clients, unusable for sign-in) and Apple's App Store Connect API stops
at bundle ids, certificates and profiles (no Services IDs, no keys). The
wizard does everything around it: the Google card deep-links both
console pages into the Play service account's project, both cards list
every environment's callback (domain + return URL for Apple) with copy
buttons, the Apple Team ID is taken from the TestFlight card, and
Check/Save ask Google and Apple whether each callback is registered —
both authorization endpoints judge a redirect without a user, so a
missing one is named before the first sign-in ever fails.

**C1. Logto — nothing manual (2026-09-17).** Wizard step 6 is a status
card. The prod twin's bootstrap mints two machine credentials for the
pair (`IAC_LOGTO_INFRA_M2M_*` for the Management API, `IAC_LOGTO_ADMIN_M2M_*`
for the console's admin tenant) into both environments; the first Deploy
of the prod twin carries them in its `.env` and the NAS poller inserts
them into Logto's own database (`deploy/update.sh`, idempotent — a seed
Logto is not ready for is retried every cycle). Deploy then waits for
the poller (`deploy/nas/after-apply.mjs`), sees Logto accept the
credential and runs the bootstrap once more, which turns sign-in into
code: web/admin/native apps, redirect URIs, CORS, API resources and the
account-deletion M2M app, their ids written back; the console's admin
(`admin`, password in `LOGTO_CONSOLE_PASSWORD`); the app's first user
(`munni_admin`, the admin area's subject `NAS_ADMIN_SUBS`); every
credential in the pair's vault (C4b). That run chains the staging twin
and Deploy again so the frontends pick the ids up — the loop ends by
itself once `VITE_LOGTO_APP_ID` exists. By hand only for an own Logto:
the old three steps sit under "Doing it by hand" in step 6, and
`gh secret set IAC_LOGTO_INFRA_M2M_ID/SECRET --env iac-production`
(and `--env iac-staging`) replaces the minted credential.

**C2. Google sign-in (optional, once).** Google Cloud console →
Credentials → Create OAuth client (Web) → authorized redirect URI
`https://logto-iac.<domain>/callback/google-universal` → store
`LOGTO_GOOGLE_CLIENT_ID` + `LOGTO_GOOGLE_CLIENT_SECRET` (the wizard's Google tile)
→ re-run the workflow. The connector + sign-in-experience wiring is code.

**C3. Apple sign-in (optional, once).** Apple developer portal →
Identifiers → new *Services ID* (this is `LOGTO_APPLE_CLIENT_ID`),
enable Sign in with Apple, return URL
`https://logto-iac.<domain>/callback/apple-universal`; Keys → new key
with Sign in with Apple → store `LOGTO_APPLE_TEAM_ID`,
`LOGTO_APPLE_KEY_ID`, `LOGTO_APPLE_PRIVATE_KEY` (the .p8 contents) →
re-run the workflow.

**C4. GlitchTip — nothing manual (2026-09-17).** Wizard step 7 is a status
card. The prod twin's bootstrap mints the admin's password
(`IAC_GLITCHTIP_ADMIN_PASSWORD`, account `admin@<domain>`) and an API
token (`IAC_GLITCHTIP_API_TOKEN`) for the pair; the first Deploy of the
prod twin carries them in its `.env` and the NAS poller creates the
superuser and the token inside the container (`deploy/update.sh`, a
Django shell, idempotent). Deploy waits for GlitchTip to accept the
token and runs the bootstrap once more, which creates the org, the team
and the per-stack projects and writes every DSN back
(`NAS_API_SENTRY_DSN` secret, `VITE_GLITCHTIP_DSN`/`_ADMIN` variables),
then chains staging and Deploy so the frontends pick them up. The login
and the token are kept in the pair's vault (C4b). By hand only for an
own GlitchTip: the token paste sits under "Doing it by hand" in step 7.

---

## Part D — native apps (store-mandated manual firsts)

Wizard step 9, or the runbook's §5: dispatch `native-android.yml` /
`native-ios.yml` with the `environment` input set to `iac-production`,
upload the first `.aab` to a new Play app (`app.munni.iac`) and create
the ASC record for TestFlight. Every build after the first is CI.

---

## The local track (full ecosystem on one machine)

**Double-click `infra/setup/start.cmd`** (or `node infra/setup/serve.mjs`).
That starts the wizard's LOCAL HELPER: it serves the same page on
127.0.0.1 and gives it hands — the page then stores the values you paste
(gitignored local store, GitHub not involved), runs bootstrap and
`docker compose` for you, streams every step's output live, and offers
one-click buttons for the dev stack and the tooling containers
(SonarQube + analyze, e2e stack, WebKit lane). The helper executes only
a fixed command allowlist, binds to 127.0.0.1, and requires the per-run
token it injects into the page.

The same flow by hand, if you prefer a terminal:

```sh
$env:NAS_GHCR_PAT = '<read:packages PAT>'
node infra/bootstrap.mjs --stack munni-local
cd infra/rendered/munni-local
docker compose --env-file .env.munni-local -f docker-compose.munni-local.yml up -d
```

Secrets are minted into `infra/rendered/munni-local/.secrets.local.json`
(gitignored, stable across re-runs); the rendered `.env` carries real
values. The generated `runbook.munni-local.md` walks the Logto OOBE and
GlitchTip token steps against `localhost`. This is distinct from the
from-source DEV stack (`deploy/docker-compose.local.yml`) — the wizard's
local track covers both.

### How the page is organised (2026-09-09)

Two levels, mirroring how the machine store routes values: the
**family** (credentials once per machine, grouped by kind; the shared
services, network mode and updater) and one **workspace per
environment** with Overview, Registrations (the Google/Apple callbacks
and the Enable Banking redirect that carry that environment's name,
verified with the provider), Phones (its Android/iOS builds and store
records) and Access tabs. A sticky stepper and a status rail read the
same facts and name the next step. Design: `docs/wizard-family-env-plan.md`.

Since 2026-09-10 features and their accounts are ONE step of **tiles**
(*Features & accounts*): it opens with an **Integration health** card —
one line per integration the picked features need, its state (Needs
setup · Configured · Checked ✓ · Needs attention · Check failed ·
Optional · Skipped), and *Check all*, which has the helper re-verify
every saved value against its provider without the page seeing a
secret — followed by one grid: a tile per connection (GitHub, the
registry; domain and Synology on the NAS track) and a tile per feature
(brand mark, toggle, one-line purpose, tags, the chip of its account).
*Manage* on a tile opens that account in a popup — what the service is,
why munni needs it, where the values come from, the fields, Save /
Check / Skip — nothing on the page moves (Escape, the backdrop, Close
and the browser's back button all close it); *Select recommended* turns
the recommended set on. Optional integrations (the crash-mail SMTP url;
the registry token, because the munni images are public — the helper
proves it with an anonymous pull and the tile reads "Not needed") never
count as blocking, and *Skip for now* counts an integration as done
everywhere (chip, health, rail, stepper) until a value is saved or the
skip is undone. Connecting GitHub stores the connection token as
`IAC_GH_PAT` by itself (no separate button) — ONE token: the registry
tile only exists when the helper finds the images private (then a
classic PAT with read:packages, or the connection token when it is one).
A copy made by the wizard follows upstream's pipeline: at Connect (and
via *Sync pipeline from upstream*) the workflows, deploy scripts and
the whole infra/ tree (tests and helper included — the copy's bootstrap
runs those tests) are compared blob by blob with okkes/munnimok@dev and
written onto the copy's branches where they differ (a fork is merged through
GitHub instead) — the app code stays the copy's own; the token needs
Contents + Workflows read and write for that. The header, the stepper and the output
drawer share the main column's width. On the local track the helper
also reads this user's Windows Root store while the family runs, so
"Trust the family certificate on this PC" is a detected fact, not a
tick; DSM login failures come with the meaning of the code (402 = the
application the login names is denied for the account — or unknown to
DSM: `session=Core` was refused for a correct account on DSM 7.3.2 on
2026-09-16, so the bootstrap logs in without a session name now and
`--verify` prints which login shapes DSM accepts).

### Day-2 on the local track: it keeps itself up to date

The wizard is a ONE-TIME bootstrap. Afterwards the helper is the PC's
counterpart of the NAS deploy poller (nothing can push to a PC, so it
pulls): with **automatic updates** on (card in step 4) it fetches the
checkout's branch every 10 minutes, fast-forwards when the working tree
is clean (a dirty dev checkout pauses the pull and says so — run the
autonomous helper from a clean clone), re-renders every stack from the
machine store after a pull, pulls the newest image of each channel
(channel tags move; `up` alone never re-pulls), brings the family up and
restarts itself when its own code moved. **Run the helper at logon**
registers a Task Scheduler entry (current user, no admin) that starts
`infra/setup/autonomy.cmd` minimized, without a browser tab. The machine
store never leaves the PC. Native apps update through the stores on
their own; the machine-owned Apple Development certificate (minted once
by the first iOS build through `mint-apple-cert.yml`, shared by the whole
Apple team — the hosted repo-level secret, every environment and the
machine store hold the same p12; CI refuses to build with a revoked one
instead of minting throwaways, and the wizard re-mints by itself when
Apple no longer lists it) keeps CI from minting and revoking throwaway
certificates.

---

## Day-2: how it stays healthy

- Pushes touching `infra/` run the module tests and VERIFY both stacks
  in CI (no writes).
- Manual dispatch of *IaC bootstrap* re-applies a stack idempotently;
  its output lands in the run's step summary.
- The `rotate` input (or `--rotate NAME`) re-mints a generated secret;
  redeploy afterwards.
- Retrieving generated passwords: see docs/secrets-access-plan.md —
  GitHub secrets are write-only by design.
- Local track: the helper's update loop (above) — its card shows the
  last verdict (pulled / paused and why / containers recreated), and
  "Check for updates now" runs one cycle on demand.
