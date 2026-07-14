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

## 5. iOS (later, needs money)

1. Apple Developer Program — [developer.apple.com](https://developer.apple.com/programs/enroll/),
   **$99/year**. Without it an iOS build can only run 7 days sideloaded.
2. Once enrolled, tell me — certificates, provisioning and a TestFlight
   lane in CI are my job. Then flip the repo variable
   `IOS_BUILD_ENABLED=true` (off by default; macOS minutes cost 10×).
3. Push on iOS: Firebase console → Add app → iOS (bundle id
   `app.munni`) + upload your APNs key from the Apple portal into
   Firebase → Cloud Messaging.

## What works today

The debug APK runs fully offline (demo/offline identities), keeps data
forever (app-scoped storage), uses munni:// deep links, and — once the
FCM key is on the NAS — receives pushes. Native sign-in works as soon
as the app is built with the new `NATIVE_LOGTO_APP_ID` (next master
merge).
