# Infrastructure as Code — whole-ecosystem plan

Status: **APPROVED with amendments** (2026-07-22). Goal (user): "I
provide the root credentials once; everything else is generated, stored
and deployed by code."

User rulings folded in:
- **Zero reuse of production.** The IaC stacks share NOTHING with the
  running prod/staging stacks — no shared Logto, no shared Postgres,
  no shared containers. Every service is deployed fresh per stack.
- **Twin stacks, iac naming.** IaC deploys a dev + prod pair mirroring
  today's channels: **munni-iac-staging** and **munni-iac-prod**. Both
  must come up from the same `bootstrap` path; only the stack file
  differs. Prod adopts the pipeline only after BOTH twins pass.
- **Ordering: Raspberry Pi first.** The Pi arc (multi-arch images,
  docs/raspberry-pi-plan.md) changes what a "host" is; IaC modules
  must target both DSM and the Pi, so the Pi work lands before the
  host-facing IaC slices (IAC4+). IAC1–IAC3 are host-agnostic and can
  proceed in parallel.

## What exists today (baseline)

Deploys are already push-button but the SETUP was manual: GitHub
Environments hold per-stack values, secrets were typed in by hand,
Logto apps/redirects were clicked together in its console, the NAS got
its DSM reverse-proxy rules and certificates by hand, and the compose
files assume those all exist.

## Target architecture

One repo directory `infra/` owns everything:

```
infra/
  stacks/            # one folder per stack
    munni-iac-staging.jsonc  # domains, ports, channels, feature flags
    munni-iac-prod.jsonc
  modules/
    github.ps1|sh    # repo variables/secrets via gh api
    logto.mjs        # Logto Management API: apps, redirects, resources
    postgres.sh      # role/db creation, password rotation
    dsm.mjs          # DSM API: reverse proxy rules, cert deploy
  bootstrap.mjs      # the ONE entry point: reads a stack file, applies all
```

### 1. Secrets: generated, never typed

- `bootstrap.mjs --stack munni-iac` generates every derivable secret on
  the spot (Postgres passwords, GlitchTip SECRET_KEY, VAPID pair, CSK
  salts) with `crypto.randomBytes`, then writes them to GitHub
  **Environment secrets** via `gh api` — the same names the workflows
  already read. Re-running rotates only what `--rotate` names.
- Root credentials the operator must still provide ONCE (stored as
  GitHub secrets, consumed by bootstrap): GoCardless secret id/key,
  EnableBanking app id + PEM, Apple/Play store credentials, Synology
  account, Logto admin M2M credential (see below), logo.dev keys.
- An inventory file `infra/secrets.manifest.json` lists every secret
  with owner (generated | operator), scope, and rotation policy — the
  bootstrap fails loudly when the manifest and reality drift (the
  missing-secret-at-deploy class of surprise dies here).

### 2. Logto as code

Logto has a full Management API (we already use it for user deletion).
- `infra/modules/logto.mjs` + per-stack app definitions: web SPA, admin
  SPA, native iOS, native Android, M2M — each with redirect URIs,
  post-logout URIs, CORS origins, resource indicators derived from the
  stack file's domains. Apply = upsert by app name; ids written back to
  GitHub variables (`VITE_LOGTO_APP_ID`, …).
- **Each IaC stack runs its OWN Logto instance** (user ruling: no
  reuse of production). The Logto container + its database are part of
  the stack render; its OOBE + one "infra" M2M credential is the
  single manual step *per stack*, after which apps/redirects/resources
  are all code.

### 3. Stack rendering (compose + env)

- Today's `deploy/env/.env.nas` + render-env.sh pattern generalizes:
  `bootstrap` renders `docker-compose.<stack>.yml` + `.env.<stack>`
  from the stack file — ports, domains, image tags, feature flags all
  come from one JSON. The NAS bundle pipeline stays as-is; it just
  gains a third channel (`munni-iac`).

### 4. NAS automation (no SSH, DSM API)

DSM has a full web API (we already drive FileStation):
- **Reverse proxy rules**: `SYNO.Core.AppPortal.ReverseProxy` — create
  `munni-iac.<domain>` → container port mappings from the stack file.
- **Certificates**: `SYNO.Core.Certificate` upload — pair with a
  Let's Encrypt DNS-01 issuance in CI (acme.sh, DNS provider API) so
  cert renewal is a scheduled workflow, not a DSM click.
- **Firewall**: DSM's firewall API is undocumented/fragile — rules
  stay manual, but `bootstrap --verify` PROBES the outcome (container
  subnets reachable, ports answering) and prints exactly what to fix.
- **Task scheduler**: the apply.sh 5-min task — creatable via
  `SYNO.Core.TaskScheduler`; bootstrap ensures it exists.

### 5. The munni-iac proof twins

Acceptance test for the whole plan: from a clean checkout,
`bootstrap --stack munni-iac-staging` and `--stack munni-iac-prod`
must each produce a fully self-contained stack (web + api + **own
Logto instance** + own postgres + own subdomains + own secrets) with
ZERO console visits beyond the documented per-stack Logto OOBE step,
then `bootstrap --destroy <stack>` removes it all. Only after both
twins pass does prod adopt the same path.

## Inevitably manual (documented, verified, never scripted)

- store uploads (first .aab/.ipa per app), App Store/Play listings
- Apple capabilities (Associated Domains enable per App ID)
- Logto OOBE + the one "infra" M2M credential per instance
- DSM firewall rules (probed by `--verify`)
- DNS records at the registrar (probed by `--verify`)

## Slices

Ordering rule: PI1–PI3 (raspberry-pi-plan.md) land first; IAC1–IAC3
are host-agnostic and may run in parallel with them.

- IAC1 `infra/` skeleton + twin stack files + secrets manifest +
  generator (GitHub secrets writer)
- IAC2 Logto module (own instance per stack; apps as code, ids
  written back)
- IAC3 stack rendering unification (compose/env from stack file)
- IAC4 host module (DSM reverse proxy + task scheduler + verify
  probes; Pi twin of the same interface)
- IAC5 cert automation (DNS-01 in CI, host upload)
- IAC6 munni-iac-staging + munni-iac-prod end-to-end bootstrap +
  destroy + runbook
