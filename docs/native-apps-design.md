# Native apps — design (ready to implement)

Status: **proposal 2026-07-15, decision made** (user delegated the
choice). Goal: real installed apps on Android + iOS that never lose
data and feel stable, while the PWA and the plain web version keep
working from the same codebase.

## The decision: Capacitor shell, not React Native, not Swift/Kotlin

| Option | New code to write | Ongoing maintenance | Solves storage wipes | Solves "unstable PWA" feel |
|---|---|---|---|---|
| **Capacitor** (chosen) | a thin native shell | one UI codebase (the existing one) | ✔ app-scoped WKWebView/WebView storage, never evicted | ✔ real app: no browser chrome, native nav feel, reliable redirects |
| React Native (Expo) | every screen re-written in RN primitives | TWO UI codebases forever | ✔ | ✔ |
| Native Swift + Kotlin | everything ×2 | THREE codebases | ✔ | ✔ |

Why this is the right call for THIS codebase and maintainer:

1. **The pain points are storage + stability, not rendering.** iOS
   evicts Safari-origin storage after 7 idle days; a Capacitor app's
   WKWebView storage is application data — backed up, never evicted,
   uninstall-only. That alone removes the wipe fear without touching
   Dexie.
2. **munni's UI is already mobile-designed** (tab bar, sheets, safe
   areas, press feedback). A webview shell is indistinguishable here;
   RN would re-buy what we already have.
3. **One codebase = every future feature lands on web, PWA and native
   simultaneously.** With RN, every arc doubles. Since Claude maintains
   this solo, the compounding cost decides it.
4. The domain/sync layers are pure TS and would survive an RN migration
   anyway — choosing Capacitor now does not burn the RN bridge later.

## Architecture

```
apps/web        ← unchanged: the single UI/domain/sync codebase
apps/native     ← NEW: Capacitor project (config + native projects)
  capacitor.config.ts   webDir: ../web/dist
  android/              generated, committed
  ios/                  generated, committed
  src/bridge.ts         platform adapter registrations (below)
```

The app ships the BUILT web bundle inside the binary (no remote-url
webview): offline-first stays true, app review stays happy, and a build
is reproducible from a git tag.

### Platform adapter seam (the only web-code change)

One tiny module, `apps/web/src/lib/platform.ts`, chooses implementations
at startup (`Capacitor.isNativePlatform()`), defaulting to the current
web behavior:

| Concern | Web/PWA (today) | Native (Capacitor plugin) |
|---|---|---|
| Storage persistence | `navigator.storage.persist()` | nothing needed — inherently persistent |
| Push | web push via service worker | `@capacitor/push-notifications` (FCM/APNs) |
| Bank-consent return | https redirect (browser tab, capability-token complete) | **deep link** `munni://gc-callback` + App/Universal Links — returns INTO the app |
| Biometric lock | WebAuthn | `capacitor-native-biometric` (Keychain/Keystore) |
| Store tokens (AH/Jumbo) | IndexedDB | `@capacitor/preferences` on top of Keychain/Keystore via secure-storage plugin |
| Safe areas / status bar | CSS env() | `@capacitor/status-bar` + same CSS |
| App updates | SW update toast | store update; optional Capgo live-update later |

Server change (small): `PushSubscriptionRow` gains `kind: webpush|fcm`
and the notifier fans out per kind (`FirebaseAdmin` for FCM; APNs rides
FCM). Everything else on the server is untouched.

### The consent redirect, fixed for real

Register `munni://` (custom scheme) plus Android App Links / iOS
Universal Links for `https://munni.<domain>/gc-callback`. The
requisition's redirect URL stays https (banks require it), but the OS
hands the link to the APP when installed — the anonymous-complete
fallback from July stays as the safety net for the browser case.

## Phases (each is one arc, shippable)

- **N1 — shell boots**: `apps/native` with Capacitor 6; pnpm/npm script
  `native:sync` (`npm run build -w @munni/web && npx cap sync`);
  Android Studio + Xcode projects committed; app icon/splash from the
  existing PWA assets; status-bar/safe-area verified against the
  hard-won viewport rules (memory: iPhone innerHeight truth).
- **N2 — platform seam**: `lib/platform.ts` adapter + capability
  detection replaces direct `navigator.storage`/push calls; PWA path
  proven unchanged by the full e2e suite.
- **N3 — deep links**: scheme + App/Universal Links, gc-callback and
  auth-callback routed into the running app; Logto redirect URIs
  extended.
- **N4 — native push**: FCM project, `kind` column + fan-out on the
  server, token registration through the adapter; web push untouched.
- **N5 — secure storage + biometrics**: store tokens move behind the
  adapter (Keychain/Keystore native, Dexie web); app-lock uses native
  biometrics when available.
- **N6 — CI + distribution**: GitHub Actions builds — Android
  `.aab`/`.apk` on ubuntu (signing key in repo secrets), iOS on a macos
  runner with fastlane; distribution: Android via Play internal track
  (or direct APK from the NAS), iOS via TestFlight.

## Costs & prerequisites (user-side, one-time)

- Apple Developer Program **$99/year** (TestFlight/App Store; without
  it iOS is limited to 7-day sideloads — not acceptable for a finance
  app).
- Google Play one-time **$25** (or skip Play entirely and sideload the
  signed APK from the NAS).
- A Firebase project (free) for FCM push.

## Risks & mitigations

- *WKWebView quirks* (keyboard, vaul sheets): the Android
  `interactive-widget` and iOS `innerHeight` rules are already encoded
  in the app; N1 explicitly re-verifies them inside the shell.
- *App-review friction (iOS)*: finance apps get scrutiny; the app is
  fully functional offline/demo without login, which historically
  passes review; no purchases, no card data.
- *Binary staleness vs NAS deploys*: the PWA updates instantly, the
  binary lags. Mitigation: the what's-new nudge + optional Capgo
  live-updates for the web layer (deferred until it hurts).

## Explicit non-goals

- No React Native / native rewrite; revisit only if a feature demands
  truly native UI (widgets, watch apps) — those can be added as small
  native extensions inside the same Capacitor projects.
- No remote-webview shell (kills offline and app review).
