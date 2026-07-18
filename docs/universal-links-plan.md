# Universal links (associated domains) — plan

> **Status 2026-07-18: UL1 + UL2 SHIPPED.** AASA + assetlinks.json are served by the web image (team id stamped at build from the APPLE_TEAM_ID secret), the iOS entitlement lists both domains for both apps, Android carries verified `autoVerify` intent filters per flavor, and `deepLinkToPath` routes the https forms. Scope was deliberately narrowed to **/gc-callback\*** and **/splits/join/\*** — sign-in/sign-out callbacks stay on the custom scheme so the app never hijacks a BROWSER user's OIDC exchange mid-flight. Split invites became real paths (`/splits/join/{token}`, the shell bounces them into the hash router) because OS link-matching cannot see `#` fragments. Remaining user-side: the **app.munni.dev** Play app's own signing-key SHA-256 (Play Console → the dev app → App integrity) still needs adding to assetlinks.json for Play-installed dev builds; the fingerprints for app.munni (signing + upload keys) are in. Verify on device after the next store builds: iOS Settings → Developer → Universal Links diagnostics / `adb shell pm get-app-links app.munni`.

**Goal:** replace the custom-scheme hops (`munni://…`) with real `https://munni.okkes.synology.me/…` links that open the native app directly. This removes the iOS "Open in munni?" confirmation popup, upgrades Android to verified App Links, and makes every share/invite link (splits, GC callback) open the app when it is installed and the website when it is not.

## How it works

- **iOS (Universal Links):** the website publishes `/.well-known/apple-app-site-association` (AASA). iOS downloads it when the app installs and, from then on, opens matching https links in the app — no popup, because Apple verified we own both the app and the domain.
- **Android (App Links):** same idea via `/.well-known/assetlinks.json` + `android:autoVerify="true"` intent filters. Android verifies at install; matching links skip the app-chooser dialog.

## Deliverables

### 1. Well-known files, served by the web image (UL1)

- `apple-app-site-association` (no extension, `Content-Type: application/json`, served at both `/.well-known/…` and root `/apple-app-site-association`, **no redirects** — Apple's fetcher refuses them):

```json
{
  "applinks": {
    "details": [
      { "appIDs": ["<TEAMID>.app.munni"],
        "components": [
          { "/": "/gc-callback*" },
          { "/": "/auth-callback*" },
          { "/": "/signed-out*" },
          { "/": "/splits/join/*" }
        ] }
    ]
  }
}
```

- `assetlinks.json` listing package `app.munni` with **two** SHA-256 fingerprints: the upload key *and* the Play App Signing key (Play Console → Setup → App integrity).
- Staging twins on `munni-test.okkes.synology.me` for `app.munni.dev`.
- nginx: a `location /.well-known/` block in the web image with explicit types; files templated at build time (TEAMID + package per channel via build args, same pattern as the other per-channel values).

### 2. App-side handling (UL2)

- **iOS:** add the Associated Domains entitlement (`applinks:munni.okkes.synology.me`, staging adds `applinks:munni-test.okkes.synology.me`) to `App.entitlements`; the dev-channel rebrand step must swap the domain the same way it swaps the bundle id.
- **Android:** `intent-filter` with `autoVerify` for the https host + the four path prefixes in `AndroidManifest.xml` (both flavors, host per flavor via `manifestPlaceholders`).
- **Web app:** `deepLinkToPath()` learns the https form — `https://<our-host>/gc-callback?…` maps to the same in-app routes the `munni://` form does today. Capacitor's `App.appUrlOpen` already delivers universal links, so the existing listener keeps working. The custom scheme **stays** as a fallback (QR codes, mail clients that strip link associations, dev builds without domain verification).

### 3. Flow upgrades once links verify (UL3)

- **GC consent return:** the bank's redirect to `https://…/gc-callback?ref=…` is a cross-origin top-level navigation — exactly the case universal links intercept. The app opens directly and completes in-app; the hosted callback page becomes the browser-only fallback. (Note: universal links deliberately do *not* fire from same-domain page JS redirects, so the current hosted auto-bounce keeps its scheme redirect as fallback.)
- **Splits invites:** `/splits/join/{token}` links shared from the app open straight into the join screen on phones with munni installed.
- **Logout return:** `/signed-out` https redirect replaces the scheme redirect registered in Logto (both post-logout URIs stay registered during migration).

## User-side prerequisites (cannot be automated)

1. Apple Developer portal → the App ID (`app.munni`, `app.munni.dev`) → enable the **Associated Domains** capability (automatic signing picks it up on the next CI build).
2. Play Console → App integrity → copy the **App signing key** SHA-256 for both apps (the upload-key SHA-256 we can derive from the committed keystore ourselves).
3. Confirm the prod/staging hostnames are final — changing the domain later re-triggers Apple's AASA cache dance (up to ~1 week of stale association on updated devices).

## Order of work

UL1 (files + nginx, zero app risk) → UL2 (entitlement + manifest + deepLinkToPath, ships in a normal native build) → verify on device (`Settings → Developer → Universal Links diagnostics` / `adb shell pm get-app-links`) → UL3 flow switches, keeping scheme fallbacks.

## Risks / notes

- AASA is cached by Apple's CDN; slow to propagate — don't debug against fresh edits, use the diagnostics screen.
- DSM reverse proxy must pass `/.well-known/` through to the web container untouched (no auth, no redirect-to-https loops on the http side).
- TestFlight builds verify associated domains normally; simulator does not.
