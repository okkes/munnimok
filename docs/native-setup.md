# Phones — Android and iOS, from nothing to the stores

What the wizard does and what stays yours, per platform and per
environment. The wizard (`infra/setup/index.html`, run by the helper)
is the working surface; this page is the same story in prose, for when
you want to know what a button is about to do. Nothing here is a
status list — the Setup status rail on the page is.

## 1. The model

- Every **platform** (`lcl` = this computer, `nas` = the Synology) is
  independent: its own Google Cloud project, its own service account,
  its own Apple keys, its own upload keystore. Platforms share exactly
  one thing on purpose: the Apple Development certificate, because Apple
  caps those per developer account (it identifies the machine that
  builds, not a platform).
- Every **environment** of a platform is its own app in the stores:
  package and bundle id `app.munni.<platform>.<env>` (the Phones tab
  shows them), its own deep-link scheme, its own Firebase apps, its own
  GlitchTip projects, its own Logto native app. CI builds it
  (`native-android.yml`, `native-ios.yml`) from the committed platform
  config and delivers to the Play internal track and TestFlight.
- The tiles under **Features & accounts** hold the credentials
  (Google Play, App Store Connect key, Firebase Cloud Messaging); the
  **Phones** tab of an environment holds the buttons (Build, Wire
  Firebase push, Register the App ID, Retire).

## 2. Google, per platform: project, service account, roles, Play

One Google Cloud project per platform keeps them apart (name it after
the platform, e.g. `munni-nas`). In it:

1. **Project:** console.cloud.google.com → project picker → New project.
2. **Service account:** IAM & Admin → Service Accounts → Create service
   account (any name) → Done. Open it → Keys → Add key → JSON. That
   whole file is the value of the **Google Play** tile — it publishes
   to Play *and* drives Firebase; a fresh project has no other accounts
   and needs none (the `firebase-adminsdk-…` agent you may know from an
   older project is created by Firebase itself, see 3).
3. **Roles:** IAM & Admin → IAM → Grant access → the service account's
   email → **Firebase Admin** and **Service Usage Admin** → Save.
   Firebase Admin alone cannot switch the Firebase Management API on;
   Service Usage Admin can.
4. **Play API:** APIs & Services → Library → *Google Play Android
   Developer API* → Enable (same project).
5. **Play Console:** Users and permissions → Invite new user → the
   service account's email → account-level *Release to testing tracks*
   and *View app information*. Every new munni package is covered
   without re-inviting.
6. **The app record**, once per environment, by hand (Play has no API
   for it): Play Console → Create app → name and package as the Phones
   tab shows. The page polls the store status and turns publishing on
   by itself once the record exists; CI's first upload binds the
   package. Content rating and Data safety are Play's own forms, also
   yours.

## 3. Firebase push, per platform — wired by the wizard

The api sends push with the same service account; the apps carry a
Firebase config that CI bakes in. The Firebase tile asks for nothing:
it unlocks once a phone app is ticked and the Google Play tile is
saved, and its **Check** verifies the two roles from step 2.3 by
switching the Firebase Management API on with that account (which
Build needs anyway) and reading the project — a missing role is named
with the IAM page to fix it on. With the roles in place, **Build** (or
**Wire Firebase push**) on an environment's Phones tab: adds Firebase to the project if it is not one yet, registers the
environment's Android and iOS apps there, hands CI their
`google-services.json` / `GoogleService-Info.plist`, stores the sender
credential on the Firebase tile (`FCM_SERVICE_ACCOUNT_JSON`) and, on
lcl, restarts the api so it carries it. A missing role is named in the
output; fix it in IAM and press again. The environment's `/health`
answers `fcm: true` once the api holds the credential.

**iOS push** additionally needs an APNs key, once per Apple team:
developer.apple.com → Keys → Apple Push Notifications service →
download the .p8 → Firebase console → Project settings → Cloud
Messaging → Apple app configuration → upload. Until then iPhones
register but receive nothing (Leftovers card, item 4).

The Firebase tile's text field is only for a deliberately separate
sender (Firebase console → Project settings → Service accounts →
Generate new private key).

## 4. Apple, per platform

1. **App Store Connect key** (tile *App Store Connect key*): App Store
   Connect → Users and Access → Integrations → App Store Connect API →
   generate with **Admin** access (the upload signs with Apple's
   cloud-managed Distribution certificate, which an App Manager key may
   not use unless "Access to Cloud Managed Distribution Certificate" is
   ticked on it); note Key ID and Issuer ID, download the .p8 once and
   paste its content. The Team ID is on
   developer.apple.com → Membership details.
2. **App ID and capabilities:** nothing to click at developer.apple.com —
   Build (or *Register the App ID*) registers the App ID with push,
   Sign in with Apple and the associated domains through the API.
3. **Development certificate:** minted once for this machine by the
   *Mint Apple signing certificate* workflow, kept in the helper's store
   and shipped into every iOS environment of every platform. Never mint
   a second one by hand: Apple caps them and a revocation breaks every
   build that used the old one.
4. **The app record**, once per environment, by hand: App Store Connect
   → Apps → New App with the pre-registered bundle id, any name and SKU.
   Every push builds the environment's iOS app as well; until the record
   exists a build archives and signs and says so in a notice, and the
   first build after the record uploads to TestFlight by itself. Accept
   any pending agreements under Business first, or uploads fail.

## 5. Per environment: build and check

- **Build** on the Phones tab dispatches CI for that environment and
  follows the run; the pills say what is wired (store record, push,
  App ID). LAN https is needed on lcl for the phones to reach the
  environment; Set up & start turns it on when a phone feature is
  ticked.
- Check: the Play internal track lists the release, TestFlight lists
  the build, `/health` says `fcm: true`, and a phone with notifications
  switched on in munni registers a push token.
- **Sign-in registrations** (Registrations tab): Google's redirect URI
  and Apple's return URL per environment — the tab lists the exact
  values and verifies them where a provider offers an API.
- **Sign in with Apple** is configured on its tile only after the first
  environment with Apple exists and the App Store Connect key is saved:
  the tile then names that environment's App ID (the wizard registers
  it), a platform-specific Services ID name, and every environment's
  domain and return URL for the Services ID configuration; the key is
  created against the same App ID. Before that the tile says "Not yet"
  and why.

## 6. Removing

**Retire** withdraws the Play internal release and expires the
TestFlight builds; **Clean up** removes the environment. The store
records themselves have no delete API and stay yours (Leftovers card,
item 1).

## 7. Troubleshooting

- *"may not switch APIs on … serviceusage.services.enable"*: the
  service account lacks Service Usage Admin (step 2.3), or add Firebase
  to the project once by hand in the Firebase console.
- *"lacks Firebase rights"*: Firebase Admin missing (step 2.3); IAM
  changes take a minute to apply.
- The Firebase button says *not stored yet*: the Google Play tile of
  this platform has no service account JSON — every platform has its
  own.
- Android builds fine but Play shows nothing: the app record (step
  2.6) or the Play Console invite (2.5) is missing; the store pill on
  the Phones tab names which.
