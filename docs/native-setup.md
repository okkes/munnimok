# Getting the native apps running — your one-time checklist

Everything code-side is done. These are the accounts/keys only you can
create, in the order I'd do them. Steps 1–3 give you a working Android
app with push; 4 adds iOS.

## 1. GitHub repository variables (5 min) — makes CI builds real

The Android workflow bakes the hosted URLs into the app. Add these
under **repo → Settings → Secrets and variables → Actions → Variables**:

| Variable | Value |
|---|---|
| `NATIVE_API_URL` | `https://munni-api.okkes.synology.me` (or the test API while trying things out) |
| `NATIVE_PUBLIC_ORIGIN` | `https://munni.okkes.synology.me` |
| `NATIVE_LOGTO_ENDPOINT` | same value your web build uses |
| `NATIVE_LOGTO_APP_ID` | same value your web build uses |
| `NATIVE_LOGTO_RESOURCE` | same value your web build uses |

After the next merge to master, **Actions → Native Android → the run's
Artifacts** has `munni-android-debug` — an APK you can download, copy
to your phone and install (enable "install unknown apps" for your file
manager). No Play account needed for this.

## 2. Logto (2 min) — makes native sign-in work

Logto admin console → your munni application → **Redirect URIs** → add:

```
munni://auth-callback
```

That's it. Inside the shell the app signs in via this custom scheme;
demo/offline modes work without it.

## 3. Firebase (15 min, free) — makes native push work

1. [console.firebase.google.com](https://console.firebase.google.com) →
   **Add project** → name it `munni` → Analytics OFF (not needed).
2. In the project: **Add app → Android**. Package name: `app.munni`
   (must match exactly). Skip the SHA-1 field.
3. Download **`google-services.json`** → put it at
   `apps/native/android/app/google-services.json` → commit it (it
   contains no secrets, only project identifiers).
4. Project settings (gear) → **Service accounts** → **Generate new
   private key** → a JSON file downloads. This one IS secret.
5. On the NAS, open `deploy/env/.env` and set
   `FCM_SERVICE_ACCOUNT_JSON=` to the whole file **as one line**
   (remove the line breaks; the JSON itself already escapes the key's
   `\n`s). Redeploy the api container.
6. Done — the app registers its device token on first login, and the
   API fans out sync/social pushes to it exactly like web push.

## 4. iOS (later, needs money)

1. Apple Developer Program — [developer.apple.com](https://developer.apple.com/programs/enroll/),
   **$99/year**. Without it an iOS build can only run 7 days sideloaded.
2. Once enrolled, tell me — the remaining work is mine (certificates,
   provisioning profile, fastlane + TestFlight lane in CI). You'll then
   also flip the repo variable `IOS_BUILD_ENABLED=true` to activate the
   macOS workflow (it's off by default because macOS minutes cost 10×).
3. For push on iOS: Firebase console → your project → **Add app → iOS**
   (bundle id `app.munni`), plus uploading your APNs key from the Apple
   developer portal into Firebase → Cloud Messaging settings.

## 5. Optional: Google Play ($25 one-time)

Only if you want store distribution/updates instead of sideloading the
CI APK. [play.google.com/console](https://play.google.com/console) →
personal account → $25. Then I add a signing keystore to repo secrets
and a Play internal-track upload step.

## What works without any of this

The APK from step 1 already runs fully offline (demo/offline
identities), keeps data forever (app-scoped storage), and uses the
munni:// deep links. Steps 2–3 light up real sign-in and push.
