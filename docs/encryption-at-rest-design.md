# Encryption at rest (native-benefits §2) — APPROVED 2026-07-17

Decisions (your answers):
1. **Full SQLCipher** on the native shells — not field-level.
2. **Key loss = forced re-sync** from the server; **offline profiles
   are NOT supported** on the encrypted store (they keep plaintext
   IndexedDB + a warning in their settings, since they explicitly chose
   no-server and a lost key would mean lost data).
3. The PWA shows an honest **"encrypted at rest: only in the apps"**
   note in settings.

## What full SQLCipher means (scope honesty)

The webview cannot encrypt IndexedDB, so choosing SQLCipher means the
native shells move their entire local database from
IndexedDB/Dexie to **SQLite with SQLCipher** via
`@capacitor-community/sqlite` (ships SQLCipher on both platforms).
That is a storage-engine replacement — the biggest arc since the
rebuild started. The web/PWA keeps Dexie unchanged.

## Architecture

1. **Storage abstraction first**: today every read/write goes through
   `MunniDB` (Dexie) + `Repo`. Introduce a `StorageBackend` interface
   at exactly that seam (tables, indexes on spaceId/date, transactions
   as batch writes) with two implementations: `DexieBackend` (today's
   code, unchanged behavior) and `SqlCipherBackend` (native). The
   ~40 query call sites go through the seam, NOT through Dexie
   directly — `useLiveQuery` reactivity is the hard part; the SQL
   backend emits change events per table that a small `liveQuery`
   shim subscribes to.
2. **Key lifecycle**: 32-byte key minted on first native run, held in
   the **iOS Keychain / Android Keystore**
   (`kSecAttrAccessibleWhenUnlockedThisDeviceOnly` / hardware-backed,
   no backup flag — a restored backup on a new device gets a NEW key
   and re-syncs, per decision 2). The db opens after the app-lock gate
   (§1's biometric moment). Key rotation = re-encrypt via SQLCipher's
   `PRAGMA rekey` behind a settings action.
3. **Migration**: on first launch after the update, the native app
   OPENS the encrypted db empty and re-syncs from the server (decision
   2 makes this the universal recovery path, so it is also the
   migration path — no risky in-place IndexedDB→SQLite copy). The old
   IndexedDB is wiped after the first successful full sync. Users see
   the normal first-sync screen once.
4. **Offline profiles on native**: creation of NEW offline profiles in
   the shells gets a warning ("no encryption without an account — the
   apps encrypt account data only"); existing ones keep working on
   Dexie plaintext. (Decision 2.)
5. **PWA**: unchanged storage + the settings note (decision 3).

## Slices (each shippable, flag-gated)

- **E1** ✅ (2.2.0): `StorageBackend` seam extracted, `DexieBackend` passes the
  entire existing suite (pure refactor, no behavior change).
- **E2** ✅ (2.3.0): `SqlStorageBackend` over a `SqlExecutor` (db/sqlBackend.ts)
  with the backend-parity suite (sql.js in memory); native executor on
  @capacitor-community/sqlite with the plugin-managed Keychain/Keystore
  passphrase (db/capacitorSql.ts); backend chosen in db/openStore.ts —
  `localStorage.munni_encrypted_store = '1'` on a native build switches
  to SQLCipher (empty start + re-sync, the approved migration path).
  Outstanding: on-device verification (iOS/Android).
- **E3**: first-run migration (empty-open + re-sync + IndexedDB wipe),
  flag on for staging apps.
- **E4**: production enable + offline-profile warning + PWA note +
  security review checklist (key handling, backup exclusion, log
  hygiene) before the release.

## Review gate

E4 ships only after a dedicated security-review pass; E1 can start any
time — it is a pure refactor that also pays down storage-layer debt.
