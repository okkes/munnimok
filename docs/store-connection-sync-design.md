# Optional server-side store connections (E2EE) — design for review

Status: PROPOSAL 2026-07-17. User request: connecting Albert Heijn /
Jumbo on every device is awkward — offer OPT-IN syncing of store
logins so a new device just works, while "store logins stay on this
device" remains the default and the privacy law ("munni's servers never
see your credentials or tokens") keeps holding in the only form that
matters: the server must be unable to read them.

## Threat model

The tokens grant read access to shopping history (and for some stores,
more). The server, its database, its backups, and an attacker who
owns any of them must never obtain usable tokens. Sync therefore has
to be END-TO-END ENCRYPTED: encryption and decryption happen only on
devices, under a key the server never holds.

## Design: a device-held sync key wrapped per device (E2EE envelope)

1. **Connection Sync Key (CSK)**: a random 256-bit AES-GCM key, minted
   on the first device that turns the feature on. It encrypts every
   `StoreConnectionRow` (tokens only; store id and status stay plain
   for UI). Ciphertext rows sync through the normal Repo/outbox pipe
   as a new device-encrypted entity (`storeConnectionSecret`), so
   offline/merge semantics come for free.
2. **Key distribution — device enrollment**: the CSK never leaves a
   device unwrapped. Each device generates a P-256 keypair
   (WebCrypto, non-extractable private key; on native it lives behind
   the same Keychain/Keystore layer as the SQLCipher passphrase). The
   public key is published as a `deviceKey` row. An ALREADY-ENROLLED
   device wraps the CSK to a new device's public key (ECDH → HKDF →
   AES-KW) and publishes the wrapped blob. Result: the server stores
   only public keys and wrapped blobs it cannot open.
3. **Enrollment UX**: new device signs in → sees "Store logins are
   synced. Approve this device from a device that already has them."
   → any enrolled device shows an approval prompt (name + a 6-digit
   fingerprint of the new device's public key, displayed on both
   screens for comparison — this is the defence against the server
   substituting its own key). One tap approves; the new device
   decrypts and the AH/Jumbo connections just work.
4. **Defaults and consent**: OFF by default; a per-connection toggle
   ("Also use on my other devices") plus a global switch in Receipts
   settings. Turning it off deletes the ciphertext rows and the wraps
   server-side; local copies stay.
5. **Revocation**: removing a device deletes its wraps; the next
   token refresh rotates the store tokens, so a stolen-but-revoked
   device ages out of usefulness. Losing ALL devices = re-connect the
   stores once (same as today) — no server escrow, on purpose.
6. **Server surface**: dumb storage + a small approval handshake
   (list pending devices, publish wraps). No crypto server-side, no
   new secrets to protect beyond what exists.

## Why not simpler alternatives

- Plain server storage (even "encrypted at rest") makes the server a
  honeypot for retail credentials — breaks the stated privacy law.
- Deriving the CSK from the Logto password is impossible (OIDC — we
  never see a password) and passkeys can't derive stable secrets
  everywhere yet (PRF extension support is uneven in WKWebView).
- QR-based device pairing is a nice future upgrade of step 3's
  fingerprint comparison (scan instead of compare); the protocol
  underneath stays identical.

## Slices

- **SC1**: CSK + encrypt/decrypt of connection rows, device keypair,
  `deviceKey`/`storeConnectionSecret` entities + server endpoints.
- **SC2**: enrollment/approval UX (prompt, fingerprint compare,
  revoke list in settings) + the per-connection toggle.
- **SC3**: token-rotation-on-revoke + polish (QR pairing).

## Review questions

1. OK that losing all devices means reconnecting stores once (no
   recovery escrow)?
2. Approval UX: fingerprint comparison first, QR pairing later —
   fine as an order?
