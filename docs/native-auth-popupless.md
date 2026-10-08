# Redirect flows — the unified best-practices plan

Status: **APPROVED** (2026-07-22). User mandate: *"best practices come
first, user experience second"* — for EVERY redirect in the product
(login, logout, bank consent), on native, PWA and web, we implement
the platform-sanctioned mechanism and accept whatever system UI that
brings. This document supersedes the earlier popup-only scope.

## Why the popup survived (context)

The universal-link work fixed WHICH app answers — but not the popup.
Two iOS rules make the Safari-redirect login structurally popup-bound:

1. **Universal links need a user tap.** Logto's return to
   `/native-auth` is a server redirect chain; iOS deliberately does not
   auto-open apps from redirects/JS navigations (anti-hijack).
2. **Same-domain links never universal-link.** The hosted page's
   custom-scheme bounce (`munni-dev://native-auth…`) always gets the
   "Open in …?" confirm.

Right app ✓, popup ✗ — unfixable inside a Safari-redirect flow.

## The redirect matrix (policy of record)

RFC 8252 (OAuth for Native Apps) is the governing best practice: native
apps MUST use an external user-agent, never a webview, and SHOULD use
the platform's dedicated auth session API.

| Flow | iOS native | Android native | PWA / web |
|---|---|---|---|
| Login / logout | `ASWebAuthenticationSession` (system auth sheet, shares Safari cookies, callback scheme handed straight back — no end-of-flow popup; one system consent alert at start is the sanctioned trade) | Chrome Custom Tabs (`androidx.browser`) + scheme callback — no confirm dialogs at all | Full-page same-tab OIDC redirect (no popups — popup flows fight blockers and mobile browsers) |
| Bank consent (GoCardless / EnableBanking) | System browser via `openUrl` — NOT the auth session: PSD2 app-to-app requires the bank page to be able to hand off to the bank's own app, which auth-session sheets suppress. Return = universal link `/gc-callback` (the bank's "return to munni" is a real user tap, so it opens the app directly) | Same: external browser / bank app, return via App Link `/gc-callback` | Same-tab redirect out, same-tab return to `/gc-callback` inside the PWA scope |
| Invite / join links (`/splits/join`, `/invite` — the invitation magic link) | Universal link (external tap — exactly what ULs are for) | App Link | Normal navigation |

Principles the matrix encodes:
- **Auth session APIs for first-party auth, external browser for
  third-party (bank) auth**, universal/app links only for flows that
  begin with an external user tap.
- Never a webview for credentials (RFC 8252 §8.12); never a popup
  window on web.
- Callback URLs are scheme-based on native (`munni(-dev)://…`) and
  path-based on web — both derived from the channel config
  (`config.ts` nativeScheme), never hardcoded.

## Slices

- NA1 **Capacitor plugin**: ~60-line Swift `AuthSession` plugin
  exposing `start(url, callbackScheme) → Promise<callbackUrl>` via
  ASWebAuthenticationSession (`prefersEphemeralWebBrowserSession:
  false` so the Logto cookie persists → subsequent logins are
  instant). Android twin on Custom Tabs — same JS API.
- NA2 **Web wiring**: on native, `signIn` builds the Logto authorize
  URL with redirect `munni(-dev)://auth-callback` and runs it through
  the plugin instead of navigating the webview; the returned callback
  URL feeds the existing `NativeCallbackScreen` handleSignInCallback
  path unchanged. Sign-out same shape (end-session in the session,
  callback `…://signed-out`).
- NA3 **Bank-consent audit**: verify GC/EB consent launches use
  `openUrl` (not webview navigation) on both platforms and that
  `/gc-callback` returns land via universal/app link into the running
  app; fix any drift. Web stays same-tab.
- NA4 **Cleanup**: the hosted `/native-auth` scheme-bounce stays as
  fallback for old builds, then retires; drop `/native-auth` from the
  AASA once no old build matters (`/gc-callback` and `/splits/join`
  stay — external-tap flows are where universal links shine).

Carried over from the (retired) universal-links plan — one pending
user action: the **app.munni.dev** Play app's own signing-key SHA-256
(Play Console → App integrity) still needs adding to
assetlinks.dev.json for Play-installed dev builds.

Result: login never leaves the app and ends popup-free on both
platforms; bank consent keeps full app-to-app capability; web keeps
plain redirects everywhere.

## Status 2026-09-29

- **Built — app links per environment**: the web image no longer ships
  static per-channel files; its start script renders both files from the
  deployment's env (package + Play app-signing fingerprint from the
  committed environment config, team id + bundle id from the env file).
  The wizard's Phones tab carries the App links card: the one manual value
  (the Play fingerprint) with its console path, a Check against the live
  host and Google's statement list, and a todo item per environment.
- **Built — NA1/NA2**: sign-in on the phone runs in the platform's auth
  session — ASWebAuthenticationSession on iOS (the AuthSession plugin in
  AppDelegate.swift), a Custom Tab (@capacitor/browser) on Android — with
  the app's scheme as the callback (`munni-<env>-<platform>://auth-callback`,
  `…://signed-out`). The hosted `/native-auth` bounce stays for builds that
  predate this (NA4's retirement waits for them to age out).
- The Play fingerprint pending item above is superseded by the card.

## Refresh tokens on the phone (2026-10-08)

**The finding (prod Logto logs, masked).** The native app got
`invalid_grant` on a refresh once a day (2026-10-07 16:20, 2026-10-08
10:41); the user's screenshot at 12:41 shows the "session expired" banner
and, popping up by itself, the iOS "wants to use <domain> to sign in"
prompt — the "silent" re-entry had opened an ASWebAuthenticationSession.
Logto 1.43 rotates the refresh token of a PUBLIC client (native and SPA,
token endpoint auth `none`) on every refresh: oidc-provider's default
policy, and Logto consults only `customClientMetadata.rotateRefreshToken`
to switch it off. The webview sometimes loses the rotated token (its
localStorage is not flushed when iOS suspends or kills the app), presents
the previous one, and Logto's reuse detection destroys the whole grant:
sign in again. Nothing in our code can make localStorage durable on the
phone, so the policy is the lever.

**The policy.** The native application carries `rotateRefreshToken: false`
and `refreshTokenTtlInDays: 90` (the longest Logto allows). A refresh
token that never rotates cannot die to reuse detection when the phone
loses a write. The SPAs (web, admin, lab, control) keep rotation: a
browser keeps localStorage, and the cross-tab Web Lock in
`app/authToken.ts` serialises their refreshes.

**The trade-off.** With rotation the phone's session slid along (every
refresh minted a new 14-day token, up to oidc-provider's one-year cap) and
could die at any moment to a lost write; without it the session is a fixed
90-day window, then a sign-in through the auth session — the Logto session
cookie usually survives in Safari's store, so it is one tap (credentials
once when it did not). Rotation exists to detect a stolen refresh token
(OAuth 2.1 for public clients); on the phone the token lives in the app's
own storage — a copy needs the unlocked device — and the account's
logged-in devices still disconnect a device the person does not recognise.
Accepted for the phone only.

**What applies it.** Bootstrap (`infra/modules/logto.mjs`: appDefinitions
→ applyApps). An existing application is PATCHed with its whole
metadata, so the policy converges on every environment's next Bootstrap —
one run per environment (dev, staging, prod). The Google connector gains
`prompts: ['select_account']` in the same run (Google's own session
continued the same account after "Use another account"; the chooser is one
tap on a normal sign-in and the only way to switch).

**Existing phone sessions.** The moment Bootstrap ran, their refresh
tokens stop rotating — but the token each phone holds keeps the TTL it was
issued with (14 days from its last rotation); the 90-day window starts
with the next sign-in. Until then an expiry shows the banner, whose Sign
in button is the door.

**The app's side (the same day).** The "silent" re-entry never runs on
the phone (`attemptSilentReentry` answers false under the shell — the auth
session is never silent); the token getter marks the session expired on an
`invalid_grant` it sees itself and backs off 15 s after any failed refresh
(`REFRESH_RETRY_AFTER_MS`, `app/authToken.ts`), so no page can hammer a
dead grant; the admin portal, which refreshed a dead grant 669 times in
three minutes on 2026-10-06, got the same guard (`apps/admin/src/auth.tsx`)
with its own "Your session expired — sign in again" note.
