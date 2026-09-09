# Setup wizard: the family and its environments (design, 2026-09-09)

Status: proposal for review — nothing built yet. Applies to the local
track first; the NAS track keeps its current sections until slice S5.

## Why

Today the wizard is one long list. Shared credentials (GitHub, the
registry token, GoCardless, the Play service account, the Apple key…)
sit next to things that belong to ONE environment (the return URL of
its Logto, its Play record, its phone build), and the same card mixes
both: the Apple sign-in card holds the family-wide Services ID and, in
the same fold, every environment's domain + return URL. Once an
environment is spun up, the work you do FOR it is scattered over three
sections. With more than one environment this gets messy fast.

The fix is two clear levels that mirror how the machine store already
routes values (`SHARED_LOCAL_NAMES` vs per-env stores):

1. **The family** — configured once per machine: credentials, shared
   services, the network mode, the updater.
2. **Each environment** — its own workspace that appears when the
   environment exists: lifecycle, the registrations it needs at the
   providers, its phones, its access.

## Who owns what

| Family (once) | Environment (each) |
|---|---|
| Platform + features | Lifecycle: create / start / stop / re-run / delete, release channel |
| GitHub connection (PAT, repo) | Its URLs (app, admin, api, Logto) and network mode view |
| Registry pull token | Sign-in wiring (automatic) + admin access (`NAS_ADMIN_SUBS`) + M2M fallback |
| GoCardless secrets | Crash tracking wiring (automatic) |
| Enable Banking application (id + key) | Enable Banking redirect URL registration |
| logo.dev keys, crash-report mail | Google redirect URI registration |
| Play service account, App Store Connect key + Team ID | Apple domain + return URL registration |
| Machine keystore, Apple certificate, push sender (all automatic) | Firebase app registrations (automatic with Build) |
| Google OAuth client (id + secret) | Android: package, Play record, publish state, Build, push pill |
| Apple Services ID + key | iOS: bundle, App Store Connect record, Build |
| Shared services + LAN mode + certificate trust | Phone-side certificate (browser use) |
| Automatic updates + logon task | Its own to-do list |
| APNs key upload (team-wide, Firebase project) | |

Rule of thumb: a **credential** is family-wide; a **registration** of a
URL, record or app that carries an environment's name is that
environment's.

## Page structure

```
┌ header ─────────────────────────────────────────────────────────┐
│ munni setup            Family ✓ 9/9   Environments: prod ● dev ○ │
└──────────────────────────────────────────────────────────────────┘
 1  Where will munni run?              (unchanged)
 2  Which features do you want?        (family-level, unchanged)
 3  The family — set up once
    ┌ What's left for the family ───────────────────────────────┐
    │ ✓ Docker · ✓ credentials · ✓ Set up & start · ☐ APNs key   │
    └───────────────────────────────────────────────────────────┘
    Credentials (cards, grouped):  Connections · Bank providers ·
       Stores & signing · Sign-in providers · Extras
       (Google/Apple cards: credential + Check; the line
        "registered per environment below ↓" instead of URL lists)
    Shared services: status, links, vault, network mode + trust,
       Set up & start everything · Stop · Delete everything
    Keeps itself up to date (updater card, unchanged)
 4  Environments
    [＋ Add environment]
    ┌ Production ● running · dev releases ─ app · admin · api · logto ┐
    │ ▶ Start ■ Stop ↻ Re-run  ✕ Delete                                │
    │ ┌ Overview ┐┌ Registrations 2/3 ┐┌ Phones ┐┌ Access ┐          │
    │ │ sign-in ✓ crash ✓ push ✓ store records ✓  — to-do list      │
    │ └──────────────────────────────────────────────────────────┘  │
    └────────────────────────────────────────────────────────────────┘
    ┌ Development ○ not running … (collapsed) ────────────────────────┐
 5  (NAS-only sections stay as they are on the NAS track)
```

### The environment workspace

One card per environment. The header is always visible (name, channel,
status pill, links, lifecycle buttons). The body has four tabs; each
tab label carries a count or pill so nothing is hidden by the tab
being closed:

- **Overview** — sign-in / crash tracking / push / store records as
  pills, plus this environment's to-do list (the per-env half of today's
  "What's left for you").
- **Registrations** — only the providers whose features are ticked.
  Per provider: what to register (domain, URL) as copy blocks, a link
  to the exact console page, a **Verify** button that asks the provider
  about THIS environment's URLs only (the existing `/api/validate`
  probes with a one-element list), and a pill (registered ✓ / refused +
  reason / not checked). Enable Banking has no probe, so it gets a
  checkbox.
- **Phones** — the Android and iOS cards as they are today, but bound
  to this environment: package/bundle fields, store-record pills, Build
  buttons, the one-time folds. The environment picker disappears; the
  card IS the environment.
- **Access** — admin access (`NAS_ADMIN_SUBS`), re-run sign-in / crash
  tracking, the M2M and GlitchTip-token fallbacks (today's fold).

The workspace of the environment you last touched stays open; others
collapse to their header.

### Order of execution

Family first (credentials → Set up & start), then each environment's
tabs left to right: Overview tells what is missing, Registrations
needs the environment's URLs (which exist once it runs), Phones needs
GitHub + the stores, Access is optional. The header strip shows the
family's state and each environment's readiness at a glance.

## What moves where

| Today | Tomorrow |
|---|---|
| Step 3 cards (all) | Family → Credentials, grouped |
| Apple/Google/EB per-environment URL lists inside shared cards | Environment → Registrations |
| Step 4 Status + Set up & start + updater + shared services + vault | Family → Shared services (+ updater) |
| Step 4 env cards (start/stop/fold) | Environment header + Access tab |
| Step 5 environment picker + Android/iOS/push cards | Environment → Phones (one copy per environment) |
| One "What's left for you" | Family list + per-environment list |
| Fixed output drawer | unchanged |

## Helper (serve.mjs) impact

Small. Everything is already per stack: `/api/local/store-status?stack=`,
`/api/local/firebase-setup {stack}`, `/api/local/ios-appid {stack}`,
`/api/validate` with `redirectUris`. Needed:

- the wizard's native flows take the environment from the card instead
  of a global picker (wizard-side only);
- store-status polling per environment (loop over the workspaces,
  still paused while a build publishes);
- optionally one `GET /api/local/env-status?stack=` that merges stack
  status + store status + registration verdicts, so a workspace refresh
  is one call.

## Slices

- **S1 Skeleton** — sections 3 and 4 as above, cards moved, no
  behaviour change; header strip.
- **S2 Registrations** — the tab with per-environment Verify (Google,
  Apple) and the Enable Banking checkbox; the shared cards lose their
  URL lists.
- **S3 Phones per environment** — native cards bound to the workspace,
  polls per environment, picker removed.
- **S4 To-do split** — family list + per-environment list; Overview tab.
- **S5 NAS parity** (later) — iac-prod / iac-staging as workspaces.

## Decisions to take before S1

1. Tabs inside the workspace (proposed) or stacked sub-cards?
2. APNs key: family list (proposed, it is team-wide) or under each iOS
   card?
3. Features stay family-level (proposed) or can an environment opt out
   of phones?
4. NAS parity now or later (proposed later)?
