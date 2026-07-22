# Popup-less native sign-in — why the popup survives, and the fix

Status: **DESIGN — awaiting approval** (2026-07-22).

## Why "Open this page in munni dev?" still appears

The universal-link work fixed WHICH app answers — but not the popup.
Two iOS rules make the current flow structurally popup-bound:

1. **Universal links need a user tap.** Logto's return to
   `/native-auth` is a server redirect chain; iOS deliberately does not
   auto-open apps from redirects/JS navigations (anti-hijack). So the
   hosted page loads in Safari instead of the app opening.
2. **Same-domain links never universal-link.** The hosted page's
   fallback bounce (`munni-dev://native-auth…`) is a custom-scheme
   navigation — and THOSE always get the "Open in …?" confirm.

So: right app ✓ (the per-channel fix), popup ✗ — it cannot be removed
within the Safari-redirect flow. Android Custom Tabs don't have this
confirm, so Android is popup-free once its own flow lands app links.

## The fix Apple built for exactly this: ASWebAuthenticationSession

`ASWebAuthenticationSession` is iOS's OAuth primitive: an in-app
browser sheet that shares Safari's cookies (SSO works), takes a
callback scheme, and hands the callback URL straight back to the app —
**no "Open in app?" popup at the end**. The trade: iOS shows ONE system
alert at the START ("munni dev wants to use okkes.synology.me to sign
in") — unavoidable, but it reads as intended behavior, happens before
typing credentials, and the flow never leaves the app.

## Plan

- NA1 **Capacitor plugin**: a ~60-line Swift plugin (`AuthSession`)
  exposing `start(url, callbackScheme) → Promise<callbackUrl>` via
  ASWebAuthenticationSession (+ `prefersEphemeralWebBrowserSession:
  false` so the Logto session cookie persists → subsequent logins are
  instant). Android twin uses Chrome Custom Tabs
  (`androidx.browser`) + the existing scheme callback — same JS API.
- NA2 **Web wiring**: on native, `signIn` builds the Logto authorize
  URL with redirect `munni(-dev)://auth-callback` (already registered
  in Logto) and runs it through the plugin instead of navigating the
  webview; the returned callback URL feeds the existing
  `NativeCallbackScreen` handleSignInCallback path unchanged. Sign-out
  gets the same treatment (end-session in the auth session, callback
  `…://signed-out`).
- NA3 **Cleanup**: the hosted `/native-auth` scheme-bounce stays as the
  fallback for old builds, then retires; the universal-link paths for
  `/native-auth` can drop out of the AASA once no old build matters
  (gc-callback and splits/join stay — those come from EXTERNAL taps,
  where universal links genuinely shine).

Result: munni dev → in-app auth sheet → back in munni dev, zero
end-of-flow popups, on both platforms. Bank-consent returns
(/gc-callback) keep the universal-link path — the bank page tap IS a
user gesture, so those open the app directly.
