# Admin panel redesign — design (PLAN, awaiting approval)

Status: proposal 2026-07-16. The current panel is a single plain page;
this makes it a modern, minimal, **desktop-first** operator console —
same brand voice as the app (dark mint #08372B accents, the serif
wordmark, calm surfaces), but denser and keyboard-friendly, because
its user sits at a desk.

## Layout

Fixed left sidebar (200px, brand-dark background, white text):
**munni · admin** wordmark, then nav — Overview, Users, Bank
connections — and the signed-in operator + sign-out pinned at the
bottom. Content area: max-width 1200px, generous whitespace, one
`h1` per screen, cards on `--m-surface` with the app's radius/line
tokens. Light/dark follows the OS (same tokens as the app). No mobile
layout beyond "don't break": sidebar collapses to a top bar under
768px.

## Screens

### 1 · Overview (new)
Stat tiles + health, the "is everything fine?" glance:
- **Users** (total / active last 30d), **Spaces**, **Feed accounts**.
- **Bank connections**: linked / expiring within 14d / expired — the
  expiring ones listed right there with the owner.
- **GoCardless quota** (user request): connections used vs plan limit
  and **when it resets**, plus per-scope API rate limits — see §Quota.
- **Server**: build number, capability flags straight from /health
  (fcm, push, gocardless, logos, ocr) as green/grey chips.

### 2 · Users
A real table: avatar+name, email, OIDC sub (copy button), spaces
count, feed accounts, last sync, **admin badge**. Row actions:
- **Promote to admin / demote** (user request) — see §Admin storage.
- Existing user actions (delete stale users etc.) move into a row
  overflow menu.
Search box filters by name/email/sub. Sorted by last activity.

### 3 · Bank connections
The current requisition list as a table (owner, institution, status,
created, expires, accounts) with the existing delete action, plus an
"expiring soon" filter chip. Institution logo where logo.dev knows it.

## Admin storage (user decision: "up to you")

New table `admin_grants` (sub, grantedBySub, grantedAtUtc). Effective
admin = `Admin:Subs` env (bootstrap/emergency, cannot be demoted from
the UI) **∪** `admin_grants`. Endpoints:

```
GET    /admin/admins            → grants + env-bootstrap subs (flagged)
POST   /admin/admins/{sub}      → grant (records who granted)
DELETE /admin/admins/{sub}      → revoke (env-bootstrap subs → 400)
```

Guards: you cannot demote yourself (avoids locking the last admin
out); every grant/revoke is written to the api log. The existing
`RequireAdmin` check reads env + table (cached 1 min).

## GoCardless quota (user request)

Two distinct numbers, both surfaced on Overview:
1. **Connection allowance** — the free plan caps new requisitions per
   rolling window. GoCardless reports remaining allowance via response
   headers on requisition creation; we also count our own requisitions
   created in the last 30 days as a fallback display.
2. **API rate limits** — every GC response carries
   `HTTP_X_RATELIMIT_LIMIT / _REMAINING / _RESET` (and the per-account
   daily scopes for details/balances/transactions). The GC client gets
   a delegating handler that stores the latest headers per endpoint
   scope in a small `provider_quota` table; `GET /admin/quota` returns
   the snapshots with their age. Overview renders: "Account details:
   x/y left · resets in 3h".

No extra GC calls are made just to measure — we piggyback on the
nightly sync traffic, so the numbers are as fresh as the last sync.

## Slices

- **AD1**: layout shell (sidebar, tokens, dark mode) + Users/
  Connections as tables (pure restyle of existing data).
- **AD2**: admin_grants table + endpoints + promote/demote UI.
- **AD3**: quota capture handler + provider_quota + Overview screen.

AD1 is fast (styling over existing endpoints); AD2/AD3 are small api
arcs with tests. Admin stays at ≥85% coverage.
