# Benefiting from the native shell — plan (PLAN, awaiting approval)

Status: proposal 2026-07-15. Now that munni ships as a real Capacitor
app, several things the PWA could only approximate become first-class.
Each item below names the plugin/approach, the platform seam it hangs
off (`lib/platform.ts`), and whether it's a quick win or needs a
device-tested arc.

## 0. Data persistence — already solved (answering the question)

**Yes: the native app's data is no longer wiped.** The PWA's risk was
iOS clearing Safari-origin storage after ~7 idle days. Inside the
Capacitor shell the WebView's IndexedDB is *application data*: backed
up, migrated, and only removed when the user deletes the app. Nothing
to build — it's a property of the shell we already ship. (`platform.ts`
already skips `navigator.storage.persist()` there.) The improvements
below are about doing MORE than the PWA could, not fixing the wipe.

## 1. Native biometrics instead of WebAuthn + PIN  ·  arc (device-tested)

Today the app-lock uses a WebAuthn platform authenticator with a PIN
fallback — it works in a browser but is clunky and the PIN exists
mainly because WebAuthn in a webview is unreliable.

**Plan**: add `capacitor-native-biometric` behind the platform seam.
- `platform.biometricAuth()` → native Face ID / Touch ID / Android
  BiometricPrompt when `isNativeApp()`, else the current WebAuthn path.
- The lock config gains `kind: 'webauthn' | 'native' | 'pin'`; native
  devices default to `native`, PIN stays as the always-available
  fallback (device with no enrolled biometrics, or 3 failed scans).
- The secret that gates unlock (today a PIN hash) moves into the
  device keychain/keystore (see §2), so "unlock" is a biometric gate
  over a keystore-held token rather than a hash compare.
Needs a real device to verify the prompts and the lockout behavior.

## 2. Encryption at rest  ·  arc (security-sensitive, device-tested)

The data is app-scoped but not encrypted; a rooted/jailbroken device or
a device backup could read the IndexedDB.

**Plan** (native only; the web/PWA stays as-is):
- Hold a random 256-bit **data key** in the OS secure storage
  (`@capacitor/preferences` backed by Keychain / EncryptedSharedPrefs,
  or `capacitor-secure-storage-plugin`). The keystore itself is
  hardware-backed on modern devices.
- Encrypt the sensitive Dexie tables' values with AES-GCM using that
  key (a thin `EncryptedCodec` in the Repo write/read path — the sync
  envelope/HLC metadata stays plaintext so LWW still works; only the
  field payloads are sealed). Decision point: whole-value vs
  selected-fields (IBANs, notes, amounts) — whole-value is simpler and
  safer, at some query cost (we already load per-space into memory).
- Gate the data key behind the biometric unlock from §1, so the DB is
  unreadable until the user authenticates.
This is the biggest item and wants its own security review.

## 3. Match device language & theme, with override  ·  QUICK WIN

`prefers-color-scheme` already flows into the theme, but the app
defaults to its own stored choice and English on first run.

**Plan** (small, mostly web — works in the PWA too):
- On first launch only (no stored preference yet): default the language
  from `navigator.language` / Capacitor `Device.getLanguageCode` when it
  maps to en/nl/tr, and the theme from `prefers-color-scheme`.
- The moment the user picks a language or toggles the theme, that choice
  wins forever (we already persist both) — so this only changes the
  *initial* default, never overrides a deliberate choice.
- Add a "Follow device" option to both the language and theme pickers
  for users who want to keep tracking the system.

## 4. "Update available" prompt  ·  QUICK WIN (small server touch)

The native binary ships a fixed web bundle; when we release a newer app,
the shell can't self-update (that's a store update) — but it also
shouldn't nag like the PWA's service-worker toast (already suppressed
in the shell). Instead it should point the user to the store when a
newer version actually exists.

**Plan**:
- `/health` already returns the deployed web `build`. Add a tiny
  `minNativeVersion` / `latestNativeVersion` to it (or a dedicated
  `/native-version` endpoint) sourced from a config value we bump on
  release.
- On app open (native only, throttled to once/day), compare the running
  app version (`@capacitor/app` `getInfo().version`) against
  `latestNativeVersion`. If lower, show a dismissible sheet: "A new
  version of munni is available — Update" linking to the store
  (`market://details?id=app.munni` / the App Store URL). A
  `minNativeVersion` above the running one makes the sheet
  non-dismissible (hard cutoff for a breaking API change).
- This replaces the misleading PWA "new version" popup you saw with an
  honest, store-aware one.

## 5. Smaller native niceties  ·  quick wins, opportunistic

- **Status bar / safe areas**: `@capacitor/status-bar` to tint the bar
  to the brand and follow the theme (we already handle safe-area CSS).
- **Haptics** on key confirmations (`@capacitor/haptics`) — review
  confirm, budget over-limit.
- **Share sheet** for CSV/JSON export (`@capacitor/share`) so an export
  can go straight to Files/email instead of a download.
- **App shortcuts / quick actions** (long-press the icon → "Add
  transaction", "Review").
- **Deep-linked push taps**: already partly handled; wire notification
  taps to the right screen through the existing NAVIGATE bridge.

## Suggested order

1. §3 language/theme + §4 update prompt — quick, high perceived value,
   mostly web so they benefit the PWA too. (One small arc together.)
2. §1 native biometrics — needs a device but self-contained.
3. §2 encryption at rest — the big one; do it last, with a security
   review, once §1's keystore seam exists.
4. §5 niceties — fold in opportunistically.

Nothing here changes the web/PWA behavior except the first-run defaults
in §3; every native-only path hangs off `isNativeApp()`.
