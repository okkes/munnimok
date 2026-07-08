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
| S1 | **High (before feature B P2)** | Feed-space ids are deterministic (`uuidv5(feed:IBAN)`), and today *any* authenticated user becomes owner of an unknown space id by pushing to it first. Someone who knows a victim's IBAN could pre-claim their feed space. Harmless today (feeds unused), fatal once B lands. | Feed spaces must be created only via owning flows (GoCardless completion / import endpoint); block generic first-push creation for feed-shaped ids, or introduce server-side feed registration tied to proof of account access. Tracked as a hard requirement in the B design. |
| S2 | Medium | No rate limiting: login-adjacent and sync endpoints can be hammered. | ASP.NET `AddRateLimiter` — per-user token bucket on `/sync/*`, stricter on `/friends/requests`. |
| S3 | Medium | nginx serves the SPA without security headers (CSP, `X-Frame-Options`, `Referrer-Policy`). CSP is the real XSS backstop for the localStorage-token trade-off. | Add headers to `apps/web/nginx.conf` + admin nginx: `default-src 'self'; connect-src 'self' <api> <logto>; frame-ancestors 'none'`. Needs the env-specific API/Logto origins, so template it at image build. |
| S4 | Low | Route/query params (spaceId etc.) are length-checked nowhere on some endpoints; harmless today (string keys), but belongs in the validation net. | Endpoint filter for param shape (`^[A-Za-z0-9_-]{1,64}$`). |
| S5 | Low | Admin app and member app share the Logto tenant; a member token could be replayed against `/admin/*` (it fails on the allowlist, which is correct) — but the admin app should ideally demand a dedicated Logto app id so consent/audience differ. | Already supported (`VITE_LOGTO_APP_ID_ADMIN`); register a separate Logto SPA app for it. |

S2–S4 are small server/nginx changes; S1 is designed into B P2. None
block current production use.
