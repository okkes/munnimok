# Backend data security — current state and hardening plan

Status: **DESIGN — awaiting approval** (2026-07-22). User question:
"the backend stores a copy of the online user's data — is it
encrypted? what stops a hacker who reaches the database from stealing
it?"

## What the server stores, honestly

Yes: for syncing accounts the API's Postgres holds a full copy —
the per-space oplog (every field of every synced entity: transactions,
notes, budgets, spaces, members) plus server-side bank data
(GoCardless/EnableBanking ingested transactions, consent references)
and Logto's identity database and GlitchTip's error events beside it.

## What is already in place

- **Transport**: HTTPS everywhere (DSM-terminated), Bearer JWT auth
  (Logto), per-space membership checks on every sync route, rate
  limiting, CORS pinned to the app origins.
- **Network**: Postgres has NO host port — only containers on the
  compose network reach it; pgadmin and logto-admin are LAN-only via
  the DSM firewall. PSD2 access is read-only by design (munni can
  never move money).
- **Secrets**: never in git; GitHub Environment secrets → rendered
  .env on the NAS (and the IaC manifest now tracks owner/rotation).
- **E2EE precedent**: store-connection credentials already sync
  END-TO-END encrypted (ECIES per device) — the server stores only
  ciphertext for the most sensitive secret we handle.
- **Supply chain**: CodeQL, Renovate, Sonar; API error paths carry no
  data payloads into GlitchTip.

## What is NOT in place (the honest gaps)

1. **No encryption at rest.** The Postgres volume is plain ext4 on
   the NAS; a stolen disk or filesystem-level intruder reads
   everything.
2. **Backups are plaintext.** `db-backup` writes nightly
   `pg_dumpall` SQL into /volume1/backups — the most portable copy
   of all user data is the least protected.
3. **One database credential.** The `munni` role owns munni, logto
   AND glitchtip databases; any single service compromise reads all
   three.
4. **Bank data is server-readable.** Necessarily — the SERVER talks
   to GoCardless, so it must see what it ingests. Full E2EE is
   impossible for bank feeds without moving ingestion client-side.

## Threat model → measures

| Threat | Measure |
|---|---|
| Stolen NAS disk / offline copy | Volume encryption + encrypted backups (SEC1/2) |
| DB credential leak / SQLi pivot | Per-service roles, scram-sha-256, least privilege (SEC3) |
| Full DB dump exfiltration | Application-layer encryption of sensitive columns (SEC4), client-side E2EE for client-originated data (SEC5) |
| API auth bypass | already: JWT + membership checks + rate limits; add authz tests per route as a standing checklist |
| Backup location compromise | age-encrypted dumps, key NOT on the NAS (SEC1) |

## Slices

- **SEC1 Encrypted backups (quick win, do first).** db-backup pipes
  `pg_dumpall` through `age -r <public key>`; the private key lives
  ONLY in the operator's password manager + GitHub secret (restore =
  CI or laptop, never the NAS). Old plaintext dumps shredded after
  verification. Weekly restore-test workflow proves the backups are
  real.
- **SEC2 Volume encryption.** DSM shared-folder encryption (or LUKS
  on the Pi) for the postgres + backups volumes; key in DSM's key
  vault, NOT auto-mount-on-boot for the backup share. Documented
  reboot procedure.
- **SEC3 Database least privilege.** initdb creates `logto_svc` and
  `glitchtip_svc` roles owning only their databases; `munni` role
  loses superuser; `password_encryption=scram-sha-256`; pgadmin gets
  a read-only role. Rolled out via the IaC pair first.
- **SEC4 Column-level encryption for bank data.** pgcrypto (or
  app-side AES-GCM with a key from the environment, rotated via the
  IaC manifest) for IBANs, counterparty names and consent references
  — a DB dump without the app env then leaks structure, not
  identities. Server can still serve/query by id.
- **SEC5 E2EE for client-originated data (the local-first endgame).**
  Notes, budgets, goals, titles, categories-assignments originate on
  devices — they can sync as ciphertext exactly like store
  connections do today (per-space key, wrapped for each member's
  device keys, fingerprint verification UI reused). The server keeps
  serving opaque ops; admin diagnosis loses content visibility for
  those fields (by design). Bank-fed raw rows stay SEC4-protected
  instead. This is a large arc — design doc of its own before build.
- **SEC6 Standing hygiene.** Quarterly restore drill + secret
  rotation via `bootstrap --rotate`; dependency and image scanning
  stays on; a `SECURITY.md` with the disclosure contact.

Suggested order: SEC1 (an evening) → SEC3 (IaC pair) → SEC2 →
SEC4 → SEC6 → SEC5 (own design round).

## CodeQL triage — 2026-10-09

Every one of the 41 open code-scanning alerts on `dev` was read at its
location (with the SARIF code flow, not the summary line) and either
fixed in code or dismissed through the API with the reason below. A
dismissal is a judgement, so it names why; a fix names what changed.
The shared rule for log lines: a value somebody else chose (a route or
query value, an agent's detail, a party's reason key, a request path)
goes through `LogSafe.Line` — `Connector.Kit.Logging.LogSafe` in the
connector platform, its twin `Munni.Api.LogSafe` in the API — which
turns line breaks and control characters into a space and caps the
length at 200; CodeQL recognises the `String.Replace` inside it as the
log-forging sanitiser.

| Alert | Rule | Where | Action |
|---|---|---|---|
| 233, 234 | cs/log-forging | Munni.Api/Admin/AdminInvitationEndpoints.cs:116 | fixed — the request's method and path through `LogSafe.Line` |
| 220, 221 | cs/log-forging | Munni.Api/Connectors/ConnectorRelayEndpoints.cs:659 | fixed — same |
| 229, 230, 231 | cs/log-forging | Munni.Api/Connectors/ConnectorLabEndpoints.cs:325 | fixed — the scaffold's `name`, `provider`, `product` (already regex-validated) through `LogSafe.Line` |
| 228 | cs/log-forging | Connector.Kit.Hosting/Jobs/JobTraceService.cs:38 | fixed — the agent's job id |
| 227 | cs/log-forging | Connector.Kit.Hosting/Jobs/JobArtifactService.cs:92 | fixed — the agent's DOM digest |
| 225, 226, 213 | cs/log-forging | Connector.Kit.Hosting/Jobs/JobOutcomeService.cs:206, 211, 149 | fixed — the agent's failure detail and `via` |
| 218 | cs/log-forging | Connector.Kit.Hosting/Providers/ProviderStatusService.cs:78 | fixed — the operator's reason key |
| 216, 217 | cs/log-forging | Connector.Kit.Hosting/Providers/CanaryService.cs:135, 157 | fixed — the resource id and provider id from the request |
| 211, 212 | cs/log-forging | Connector.Kit.Hosting/Endpoints/LoginEndpoints.cs:608, 617 | fixed — the session id from the route |
| 232, 205 | js/clear-text-logging | infra/bootstrap.mjs:119, 392 | fixed — the vault module's errors (infra/modules/vault.mjs) no longer carry the operator's e-mail nor a stored value's prefix; what the bootstrap logs is fixed text plus an HTTP status |
| 204 | js/remote-property-injection | infra/modules/localstore.mjs:69 | fixed — the store key is the platform list's own id (`PLATFORM_IDS.find`), never the caller's string; value names must be UPPER_SNAKE_CASE (test in localstore.test.mjs) |
| 148 | js/stack-trace-exposure | infra/setup/serve.mjs:147 | fixed — the catch-all answers the error's message alone, never the error object (line 2165) |
| 197 | js/identity-replacement | infra/modules/secrets.mjs:130 | fixed — the no-op `replace(/-shared$/, '-shared')` removed |
| 207 | js/regex/missing-regexp-anchor | infra/tests/validate.test.mjs:131 | fixed — anchored to `^https://api.appstoreconnect.apple.com/v1/apps` |
| 201 | js/regex/missing-regexp-anchor | infra/tests/serve.test.mjs:712 | fixed — anchored to `^https://ghcr.io/token` |
| 198, 199, 200 | js/incomplete-hostname-regexp, js/regex/missing-regexp-anchor | infra/tests/render.test.mjs:78, 237 | fixed — no regular expression is built from the LAN address any more (`proxyOf` and the push-subject check are line searches) |
| 143 | js/bad-tag-filter | infra/tests/sealedbox.test.mjs:15 | fixed — the `<script>` extraction is case-insensitive |
| 224 | cs/cleartext-storage-of-sensitive-information | Munni.Api/Connectors/ConnectorIngest.cs:402 | dismissed, false positive — `batch.OrphanAccount` is the party's own account identifier of a fetched transaction (a key, never a credential); the heuristic matched the name `accountId` |
| 210, 209 | cs/cleartext-storage-of-sensitive-information | Connector.Kit.Hosting/Jobs/InlineJobContext.cs:60, Connector.Kit.Agent/Execution/AgentJobContext.cs:280 | dismissed, false positive — an adapter's note is a diagnostic sentence; the agent scrubs every secret value out of it first (`SecretScrubber.Detail`), the inline runner never leaves the process; the flagged taint is an account's external id |
| 190, 191, 192 | js/clear-text-logging | .github/scripts/asc-cert-check.js:38, 45, 52 | dismissed, false positive — `CERT_SERIAL` is the signing certificate's serial number (openssl reads it from the public certificate in the p12), a public attribute; the heuristic matched the name `cert` |
| 164 | js/disabling-certificate-validation | infra/modules/insecure-fetch.mjs:29 | dismissed, won't fix — deliberate for the setup's own locally-signed origins; `isLocalTlsUrl` now admits localhost and private/loopback/link-local sslip names only, and `insecureFetch` hands every other url to the strict fetch (infra/tests/insecure-fetch.test.mjs) |
| 165, 171 | js/file-access-to-http | infra/modules/insecure-fetch.mjs:22, 17 | dismissed, won't fix — the url is the operator's own local service address from the wizard store, reachable unverified only through the fence above |
| 203 | js/file-access-to-http | infra/setup/serve.mjs:704 | dismissed, won't fix — the stored GoCardless credentials go to GoCardless's own token endpoint so a local stack's cleanup can revoke the consents it created |
| 157 | js/insufficient-password-hash | infra/modules/vault.mjs:52 | dismissed, false positive — line 52 is the HMAC-SHA256 integrity check of a Bitwarden EncString, not a password hash; the master password is PBKDF2-SHA256 at 600 000 iterations, and the 1-iteration PBKDF2 of the derived key is the protocol's login hash Vaultwarden expects verbatim |
| 206, 208 | js/http-to-file-access | .github/scripts/asc-app-record.js:22, asc-devices.js:23 | dismissed, won't fix — `GITHUB_OUTPUT` is how a probe hands its verdict to the workflow (the app record's name, the device counts from Apple's own API); `out()` now strips line breaks so a value cannot write a second output |
