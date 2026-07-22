# infra/ — Infrastructure as Code (docs/iac-plan.md)

One entry point per stack:

```sh
node infra/bootstrap.mjs --list
node infra/bootstrap.mjs --stack munni-iac-prod      # first run: mint secrets, render, runbook
node infra/bootstrap.mjs --stack munni-iac-staging
node infra/bootstrap.mjs --stack munni-iac-prod --verify
node infra/bootstrap.mjs --stack munni-iac-prod --rotate NAS_GLITCHTIP_SECRET_KEY
```

- `stacks/*.jsonc` — the single source of a stack's domains, ports,
  channel and features. The prod twin of a pair carries the shared
  Logto + GlitchTip; the staging twin reuses them. Nothing here may
  reference the live prod/staging stacks.
- `secrets.manifest.json` — every secret with its owner
  (generated/operator), scope and rotation policy; `--verify` fails on
  drift.
- `rendered/<stack>/` — compose + env template + first-time runbook.
  Deployment onto a host goes through the same NAS bundle pipeline as
  the live stacks (new channel per stack — IAC4, after the Pi arc).
- Modules: `secrets.mjs` (mint + GitHub Environment writes via gh),
  `logto.mjs` (apps/resources as code through the pair's one
  operator-created "infra" M2M credential), `render.mjs`,
  `runbook.mjs`.

First-time vs steady-state: the runbook lists every manual step with
the actual generated values inlined (DSM proxy rules, the pair's one
Logto OOBE step, GlitchTip DSN creation, the store-mandated first
.aab/.ipa uploads). After those, every deploy is automatic.
