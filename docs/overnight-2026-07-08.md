# Overnight report — 8 Jul 2026

Everything you asked for is done, verified and pushed to `dev`
(16 commits). Suites: **web 268/268 unit** (repeatedly clean, also
under coverage), **API 54/54**, **Playwright 43/43**, **Sonar 0 open
issues on both dashboards**. Local + e2e docker stacks rebuilt and
smoke-checked; dev CI green.

## What landed

| Area | Where to look |
|---|---|
| Overview (earned/spent/saved/invested, bar chart, category drill-down, home tiles) | `/overview/:kind`, `domain/overview.ts`, `domain/periods.ts` |
| Onboarding step 2: connect bank / import / later (legacy parity) | `OnboardingScreen.tsx` |
| ING CSV imports (current, Oranje savings, credit card) + CAMT in one detecting pipeline | `lib/statements/` — verified against your three real exports (958/18/234 rows, deterministic idempotent refs) |
| Feature B P1: feed/overlay schema + join layer (dual-read seam) | `db/joined.ts`, `domain/feedIds.ts`, design in `docs/shared-accounts-design.md` |
| Scalar API reference | `http://localhost:8180/scalar` (and NAS API domain `/scalar`) |
| Admin console as its own app + container (same API — justified in the commit/readme) | `apps/admin`, port 8085 prod / `npm run dev -w @munni/admin` (5175); removed from the member app |
| The three review docs you asked for | `docs/architecture-review.md`, `docs/security-review.md`, `docs/design-review.md` |
| Security S2-S4 already fixed (bonus arc) | API rate limiting (global per-sub bucket + strict social-mutations window, 7 new tests), route-param shape validation, CSP/security headers in both nginx images (app verified booting under CSP) |

## The one real battle: the "flaky" test suite

Full vitest runs kept dying overnight (30-45 min hangs, 4 GB worker
OOM, "1 unhandled error") while scoped daytime runs passed. Root cause
was **one test**: the overview saving test clicked period bars *inside*
a `waitFor` callback. Every click mutates the DOM → testing-library
re-runs the callback on mutation → clicks again — a self-feeding loop
that starves waitFor's own timeout, so it could neither fail nor
finish. It only tripped when the asserted condition was false, which
depended on where the demo deposits fell relative to the wall clock —
hence "overnight-only". Fixed by computing the deposit-bearing bar from
the seed and clicking once, outside waitFor. Full suite now runs in
**12 seconds**. Two related hardenings: money assertions use `/€[1-9]/`
(the old `/€\d/` happily matched the pre-load €0.00), and the demo seed
now always has a purchase in the current period (`daysAgo` 0/1 rows) —
which also makes the demo look alive today.

## Needs your eyes (nothing blocks)

1. **Design review** — items marked *[needs your agreement]*:
   spaces-settings sheet → screen, home hierarchy, desktop two-column,
   language chips in onboarding, folding Friends into space members.
2. **Architecture review** — R1 (application layer) is the refactor I
   recommend interleaving with feature B P2-P4; the rest can wait.
3. **Security review** — S2-S4 are already fixed and verified (see
   table); only S1 (feed-space squatting) remains, designed into B P2
   as a hard requirement.
4. **Your side for the admin console**: third Logto SPA app +
   `VITE_LOGTO_APP_ID_ADMIN` repo variable + `munni-admin.` reverse
   proxy (LAN-only) — steps in `deploy/README.md`.

## Next up (my queue)

Feature B P2: server-side account attachment endpoints + feed-space
creation locked to owning flows (closes S1), then the attach-to-space
prompt after connect/import, the 'Shared' accounts section, migration,
e2e.
