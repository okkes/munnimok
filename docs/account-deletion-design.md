# Account deletion — design (DELIVERED 2026-07-16)

Approved decisions: shared spaces leave-and-archive (①), immediate (②),
Logto M2M ok (③). Implemented: `AccountDeletion.DeleteUserAsync`
pipeline, `DELETE /me` + `DELETE /admin/users/{sub}`, the Settings
danger flow with typed confirmation (EN/NL/TR), Logto M2M via
`Logto:M2mAppId/Secret` (compose + .env.nas template `NAS_LOGTO_M2M_*`;
unconfigured = server data still erased, identity logged for manual
cleanup). Differences from the sketch below: synchronous 200 instead of
202+poll (the pipeline runs in seconds), typed-word confirm instead of
hold-to-confirm, no feedback questionnaire (kept minimal).

Why now: beyond basic hygiene, **Apple requires in-app account deletion**
(App Store guideline 5.1.1(v)) for any app with in-app account creation —
munni needs this before an App Store release. Google Play's User Data
policy expects a discoverable deletion path too.

## User experience

Settings → Account → **Delete account** (danger-styled, bottom of the
account section):

1. An explanation screen: what gets deleted (everything, everywhere),
   what happens to shared spaces, that bank connections are revoked,
   and that it cannot be undone.
2. Confirmation: type the word DELETE (localized) + a final button with
   a 5-second hold-to-confirm. No email round-trip — the user is
   already authenticated via Logto.
3. Progress screen → "Your account is gone" → app resets to the login
   screen (local data wiped).

Offline/demo identities never see this screen — their "deletion" is the
existing local wipe at logout/identity switch.

## What must be cleaned, in order

**1. Bank consents (external, first — they hold the most sensitive
access):**
- GoCardless: DELETE each requisition of the user's accounts (their API
  supports it); this revokes bank access at the provider.
- Enable Banking: sessions expire naturally (≤90 days), but we delete
  our stored session/account references immediately.

**2. Server data (one transaction where possible):**
- Push subscriptions (webpush + FCM rows) — stops all notifications.
- Feeds + raw bank rows for accounts the user owns (global per account:
  deleting the owner deletes the feed).
- Spaces: for each space where the user is the ONLY member → delete the
  space, its oplog and all synced rows. For shared spaces → the user
  simply LEAVES (existing leaveSpace semantics: members keep their
  copy of the space; the leaver's bank feeds get archived for the
  others, same as a manual leave today). ⚠ decision point below.
- Membership rows, invites sent/received, friend links.
- The user row itself last.

**3. Identity (Logto):**
- Delete the Logto user via the Logto Management API (machine-to-machine
  app credential, server-side). This kills the login itself and any
  other sessions.
- Social-login users (Google/Apple): deleting the Logto user severs the
  link; nothing to do at Google/Apple (they only ever received an OAuth
  consent, which the user can revoke themselves).

**4. Client:**
- `destroyIdentityData` (already exists — demo wipe uses it) + sign-out,
  clearing tokens, IndexedDB, caches and the lock configuration.

**5. What we deliberately KEEP:**
- Nothing user-identifiable. GlitchTip crash events already carry no
  account identity; NAS backups age out on the existing backup rotation
  (documented as "residual copies disappear within the backup window").

## API shape

`DELETE /me` — authenticated, no body. Idempotent. Server performs
1–3 in a background-safe sequence (bank revocation failures are logged
and retried by a small janitor, they never block the account deletion
itself). Returns 202; the client polls `/me` until 404, then wipes
locally. Admin endpoint `DELETE /admin/users/{sub}` reuses the same
pipeline for operator-initiated removals.

## Decision points for you

1. **Shared spaces**: leave-and-archive (proposed, matches existing
   leave semantics) or hard-delete the user's transactions out of
   shared spaces too? Leave-and-archive keeps other members' books
   consistent; hard-delete is "more erasure" but rewrites shared
   history.
2. **Grace period**: immediate + irreversible (proposed — personal app,
   strong confirm) or a 14/30-day soft-delete with login-to-restore?
   Soft-delete needs a "deactivated" state through the whole API.
3. **Logto M2M credential**: deleting the Logto user needs a Management
   API application (a new secret on the NAS env). OK to add
   `LOGTO_M2M_APP_ID/SECRET`?

Implementation estimate: one arc (API pipeline + tests, settings flow
with i18n ×3 + tour touch, e2e for the confirm flow).
