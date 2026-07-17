# Encryption at rest (native-benefits §2) — design for review

Status: PROPOSAL 2026-07-16 — the one remaining native-benefits item.
Deliberately the last arc, and deliberately not implemented without
your review: key management mistakes are silent until they lock real
people out of real financial data.

## What we're protecting, from whom

The WebView's IndexedDB lives as plaintext SQLite/LevelDB files inside
the app sandbox. On a non-rooted, screen-locked device the OS already
encrypts the disk and the sandbox blocks other apps — the residual
threats are: device backups landing somewhere readable, forensic access
to an unlocked/rooted device, and "handed my unlocked phone to someone"
(already mitigated by the app lock). So this is defense-in-depth, not a
gap-closer, and it must NEVER risk data loss to add it.

## Approach: keystore-wrapped field encryption, not full-DB

Full-database encryption in a WebView means either moving off IndexedDB
(SQLCipher via a native plugin — a full storage rewrite, months) or
encrypting every row through a wrapper. The proportionate version:

1. **A per-identity data key (32 bytes)**, generated on first native
   run, stored in the **iOS Keychain / Android Keystore** via the
   already-installed biometric plugin's credential storage (or
   @capacitor/preferences + Keystore-backed encryption). Web/PWA: no
   change — the browser cannot hold hardware-backed keys; the PWA keeps
   today's model (documented trade-off, same as banking PWAs).
2. **Encrypt the sensitive columns only** at the Repo seam (the single
   write/read chokepoint): transaction merchant/description/notes,
   account names/IBANs, receipt blobs. Amounts and dates stay plain so
   indexes, sorting and range queries keep working (they identify
   nothing by themselves without the descriptions).
3. **AES-GCM via WebCrypto** with the keystore-held key imported per
   session after the biometric/app-lock gate — the same unlock moment
   §1 built. Key never touches localStorage/IndexedDB.
4. **Migration**: lazy, per-row on write + a background sweep, with a
   `cryptoVersion` marker per row. Decryption failures fall back to
   plaintext read (pre-migration rows) — the sweep converges, nothing
   breaks mid-way, and a restore from an OS backup on a new device
   (new keystore = key gone) still has the SERVER as source of truth:
   a full re-sync rebuilds the local db, so key loss costs a re-sync,
   never data.

## Slices

- **E1**: key lifecycle (mint/hold/drop on logout) behind the platform
  seam + Repo encrypt/decrypt hooks, feature-flagged off.
- **E2**: sensitive-column migration sweep + flag on for native.
- **E3**: receipts (blobs) + the security review checklist pass.

## Review questions for you

1. Field-level (proposed) vs full-DB SQLCipher rewrite — agree with
   field-level?
2. Is "key loss = forced re-sync from server" acceptable? (Offline
   profiles have no server; proposal: offline identities keep plaintext
   + a warning in their settings, since they explicitly chose
   no-server.)
3. Should the PWA show an honest "encrypted at rest: only in the apps"
   note in settings?
