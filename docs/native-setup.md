# Getting the native apps running — your one-time checklist

Status 2026-07-15: **steps 1–3 are DONE** (repo variables set, native
Logto app created, Firebase json committed + FCM key on the NAS is the
only piece left there). What remains is finishing Play (step 4) and,
later, Apple (step 5).

## 1. GitHub repository variables — DONE ✓

`NATIVE_API_URL`, `NATIVE_PUBLIC_ORIGIN`, `NATIVE_LOGTO_ENDPOINT`,
`NATIVE_LOGTO_APP_ID`, `NATIVE_LOGTO_RESOURCE` are set. The resource is
the **API resource indicator** — the identifier of the API in Logto's
"API resources" (here `https://munni-api.okkes.synology.me`), which the
app requests access tokens FOR. Same value the web build uses as
`VITE_LOGTO_RESOURCE`.

Every master merge now produces, under **Actions → Native Android →
Artifacts**: `munni-android-debug` (sideloadable APK) and
`munni-android-release` (Play-ready signed .aab).

## 2. Logto — DONE ✓ (with a correction)

You were right to create a **separate Native-type application** instead
of reusing the SPA app — Logto validates redirect types per app kind,
and `munni://auth-callback` only fits a native app. The original
instruction here said otherwise; corrected. `NATIVE_LOGTO_APP_ID` now
carries the native app's id. One follow-up inside Logto: if the API
resource uses role-based access control, grant the native app the same
role as the SPA — without RBAC nothing more is needed.

## 3. Firebase — DONE ✓ (one NAS step left)

`google-services.json` is committed and the shell builds with the FCM
plugin active. Remaining: put the **service-account key** (Project
settings → Service accounts → Generate new private key) into the NAS
env as one line: `FCM_SERVICE_ACCOUNT_JSON=` in `deploy/env/.env`, then
redeploy the api container. Until then native devices register fine but
receive no pushes.

## 4. Google Play — account exists; three steps left

Signing is fully handled: an upload keystore was generated, lives in
the repo secrets (`ANDROID_KEYSTORE_*`) and as a local copy at
`deploy/env/upload.keystore` (gitignored; password in
`deploy/env/.env.local`). CI already produces the signed .aab.

1. **Create the app** in the Play Console (your Jinbu account): Create
   app → name "munni" → package name will bind on first upload. Note:
   the old `com.okkes.munni.preview` / `com.ashblossom.munni.preview`
   entries are the legacy prototype — this is a NEW app with package
   **`app.munni`**. Also register `app.munni` under the "Android
   developer verification" banner you're seeing.
2. **Upload the first .aab by hand** (Play's API cannot create apps):
   download `munni-android-release` from the latest master Actions run
   and drop it into Internal testing → Create release. Enable **Play
   App Signing** when asked (default) — our key is then just the upload
   key and can be reset if ever lost.
3. **Service account for CI uploads**: Play Console → Setup → API
   access → link a Google Cloud project → create a service account with
   the "Release manager" role → download its JSON key → save it as the
   repo secret `PLAY_SERVICE_ACCOUNT_JSON`. From then on every master
   merge publishes to the internal track automatically.

## 5. iOS — enrolled ✓, TestFlight lane is built; four steps left

The CI lane exists (signed archive + TestFlight upload via an App
Store Connect API key, automatic signing — no certificates to manage
by hand). Your remaining steps:

1. **App record**: [App Store Connect](https://appstoreconnect.apple.com)
   → Apps → **+ New App** → platform iOS, name "munni", bundle ID
   `app.munni` (register it as an explicit App ID when prompted), SKU
   `munni`.
2. **API key**: App Store Connect → Users and Access → **Integrations →
   App Store Connect API** → Team Keys → generate, role **Admin**. Note
   the Key ID + Issuer ID and download the `.p8` (one chance!).
   > ⚠ The role must be **Admin**, not App Manager. CI signs the build
   > with a *cloud-managed distribution certificate*, which only an
   > Admin key may create — an App Manager key fails the export with
   > "Cloud signing permission error / No signing certificate 'iOS
   > Distribution' found" (this is what the first TestFlight run hit).
   > Also make sure any pending agreements are accepted under
   > Business / Agreements, Tax, and Banking, or cert creation is blocked.
3. **Repo secrets**: `ASC_KEY_ID` (key id), `ASC_ISSUER_ID` (issuer),
   `ASC_KEY_P8` (the .p8 file base64-encoded:
   `base64 -w0 AuthKey_XXXX.p8`), `APPLE_TEAM_ID` (Membership page).
4. Flip the repo variable **`IOS_BUILD_ENABLED=true`** — the next
   master merge archives, signs and uploads build N to TestFlight.
   (With the variable on but no secrets, CI only does a cheap unsigned
   smoke build.)

Push on iOS additionally needs: Apple portal → Keys → create an
**APNs key**, upload it in Firebase → Project settings → Cloud
Messaging → Apple app configuration (add an iOS app with bundle
`app.munni` there first, and drop its `GoogleService-Info.plist` into
`apps/native/ios/App/App/` — tell me when it exists and I wire it in).

## Dev-branch builds (public repo = free minutes)

Both native workflows also run on **dev** pushes. What you get per dev
push, with no extra setup:

- **Android**: a debug APK and a signed release `.aab` as downloadable
  workflow artifacts (versionName `X.Y.Z-dev`). NOT auto-published to
  Play — a dev build sharing the prod internal track would reach your
  real testers and could collide on version codes.
- **iOS**: uploaded to **TestFlight** as a normal build (TestFlight
  lists every build; the build number = commit count distinguishes dev
  from master). Marketing version stays numeric per Apple's rule.

**Optional — point dev builds at a staging stack**: set repo variables
`NATIVE_API_URL_DEV`, `NATIVE_PUBLIC_ORIGIN_DEV`,
`NATIVE_LOGTO_APP_ID_DEV`, `NATIVE_LOGTO_RESOURCE_DEV`. When absent, dev
builds use the production values (fine while there's one stack).

**To actually publish a separate Android dev channel** (installable
side-by-side with prod), it needs its own identity — tell me and I'll
add a `dev` product flavor with `applicationId app.munni.dev`, its own
Play app and its own Firebase Android app. That's the only clean way;
Play won't let two builds of the same package live on different tracks
for different audiences.

## What works today

The debug APK runs fully offline (demo/offline identities), keeps data
forever (app-scoped storage), uses munni:// deep links, and — once the
FCM key is on the NAS — receives pushes. Native sign-in works as soon
as the app is built with the new `NATIVE_LOGTO_APP_ID` (next master
merge).
