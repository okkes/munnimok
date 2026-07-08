# Security review — local-first munni

Scope: does the local-first architecture leak secrets or authority to
the client? Verified against the code on `dev` (2026-07-08).

## Verified safe

| Concern | Status |
|---|---|
| GoCardless secrets | ✅ Server-only (`GoCardless__Secret*` env → API). The UI only calls `/gocardless/*`; requisition creation, completion and fetching happen server-side. No secret ever reaches the browser. |
| VAPID private key | ✅ Server-only; the browser gets the public key via `/health`, which is by design public material. |
| Admin authority | ✅ Every `/admin/*` endpoint checks the `Admin:Subs` allowlist server-side; the new standalone admin app carries no extra authority — it is just a client. |
| Sync authorization | ✅ push/pull/bootstrap/SSE all check space membership per request; readers are rejected on push; SSE filters events to the caller's memberships (integration-tested). |
| Test auth | ✅ `X-User-Sub` only honored when `Auth:TestMode=true`; not set in prod/staging compose. |
| CORS | ✅ Explicit origin allowlist per environment (web, admin, localhost dev). |
| Input validation | ✅ All request bodies FluentValidated (entity whitelist, length caps, https-only endpoints/redirects). |
| Error monitoring | ✅ `sendDefaultPii: false`; bodies never sent to GlitchTip. |

## Accepted trade-offs (documented, not bugs)

1. **OIDC tokens in localStorage.** Required for PWA restart-survival
   (local-first law). Mitigation is XSS hygiene: React escaping, no
   `dangerouslySetInnerHTML`, no third-party scripts. Hardening below.
2. **IndexedDB is not encrypted.** No installable web app can do
   better; the biometric/PIN lock is a UI gate, same trade-off as
   banking PWAs. Documented in the lock's code and to the user.
3. **Bank files are parsed on-device** (CAMT/CSV never uploaded) —
   this is a privacy *win* of local-first.

## Findings to fix

| # | Severity | Finding | Fix |
|---|---|---|---|
| S1 | ~~High~~ **fixed 2026-07-08 (B P2)** | Feed-space ids are deterministic (`uuidv5(feed:IBAN)`), and any authenticated user became owner of an unknown space id by pushing to it first — an IBAN-knowing attacker could pre-claim a victim's feed. | Done: the generic first-push rule now REJECTS version-5 (feed-shaped) ids; feeds are born only via `POST /feeds` from the owning flows. Registration is idempotent for the owner and returns 409 for anyone else — a squatter gains no read/write access ever, and the legitimate user's client can fall back to a personal (salted) feed id, losing only cross-user dedupe, never data. Members derive read access through server-side attachments; raw writes stay owner-only. Integration-tested end to end (squat attempt, capped archive reads, revive on rejoin). |
| S2 | ~~Medium~~ **fixed 2026-07-08** | No rate limiting: login-adjacent and sync endpoints can be hammered. | Done: global per-sub (per-IP pre-auth) token bucket (600 burst, 360/min sustained) + a strict `social-mutations` fixed window (30/min) on every write that reaches another person. Configurable via `RateLimits:*`; TestMode defaults to unlimited so functional suites never throttle; `RateLimitTests` pins the 429 behavior with explicit low limits. |
| S3 | ~~Medium~~ **fixed 2026-07-08** | nginx serves the SPA without security headers (CSP, `X-Frame-Options`, `Referrer-Policy`). CSP is the real XSS backstop for the localStorage-token trade-off. | Done: shared `deploy/nginx/security-headers.conf` included by web + admin nginx (re-included in every `add_header` location — nginx inheritance rule). CSP locks `script-src 'self'` (the XSS backstop; index.html has no inline scripts); `connect-src` stays `*` so one image serves every environment — blocking foreign *script* is the protection that matters, and env-templated images can revisit this later. Verified: headers present on `/index.html`, app boots under CSP with zero violations. |
| S4 | ~~Low~~ **fixed 2026-07-08** | Route/query params (spaceId etc.) are length-checked nowhere on some endpoints; harmless today (string keys), but belongs in the validation net. | Done: `RouteParamShapeFilter` (`^[A-Za-z0-9_-]{1,64}$`) on the sync, social, admin and gocardless groups; `country` query param validated as a 2-letter code. Integration-tested (400 on malformed, guids and refs pass). |
| S5 | Low | Admin app and member app share the Logto tenant; a member token could be replayed against `/admin/*` (it fails on the allowlist, which is correct) — but the admin app should ideally demand a dedicated Logto app id so consent/audience differ. | Already supported (`VITE_LOGTO_APP_ID_ADMIN`); register a separate Logto SPA app for it. |

S2–S4 shipped on 2026-07-08 (rate limiter + param shape filter on the
API, security headers/CSP in both nginx images). S1 remains designed
into B P2 and is the next arc's hard requirement.
