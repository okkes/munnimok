# Receipts v3 — store connections & receipts redesign

Status: **DESIGN — awaiting approval** (2026-07-20). Nothing here is implemented.

Decisions already made by the user (folded in):

- Connections shared into a space are **metadata-only**: members see the connection
  instance and its receipts, credentials never leave the owner's devices. Receipts
  refresh only while one of the owner's devices syncs.
- Receipts are **globally pulled and stored** (raw data, like bank transactions);
  the receipt↔transaction link is **per-space modification data**.
- Multiple instances of the same store service are allowed; detect likely duplicates.
- After a successful connect the user names the instance; name/icon editable later;
  icon mechanism = BrandIconPicker (same as recurring costs).

## Current state (what changes)

| Today | Problem |
|---|---|
| `storeConnections` Dexie table keyed by `store` (one row per store, device-local) | No multiple instances, no name/icon, invisible to other members |
| `sharedSpaceIds` on the connection + synced `StoreMarkerRow` | Ad-hoc; not the accountLink pattern used for bank accounts |
| Receipts = per-space rows `rcpt:{store}:{ext}@{space}`, fanned into every shared space, `txId` stored on the receipt row | Raw data duplicated per space; the tx link (a modification) is welded onto the raw row |
| Matching amount ±2¢ / date ±2d / merchant regex; auto-attach only rung-1 | No payment-method awareness; no re-evaluation when a connection joins a space |
| Receipt fetch on app open only (`useStoreKeepAlive`) | Not tied to transaction arrival |
| No settings section; attach flow on TxDetail is clunky | Discoverability + UX |
| Admin catalog = categories + keywords only | No store labels to help the matcher |

## R1 — Connection instance model (foundation)

Three layers, mirroring bank accounts (global entity + per-space opt-in):

1. **`StoreConnectionRow` (device-local + E2EE-synced via existing storeSync), rekeyed**
   - Key: `instanceId` (uuid) instead of `store`. Fields: `store`, `tokens`,
     `refreshedAt`, `status`, `lastReceiptId`, `providerAccountId` (see dedupe).
   - Migration: existing row `store` → new row with fresh `instanceId`.
   - storeSync cipher payload carries the instance list (bump payload version).
2. **`storeConn` — NEW synced, secret-free entity (global scope, owner's user feed)**
   - `{ id: instanceId, store, displayName, icon?, providerAccountHash?, createdAt,
     ownerSub }` — makes instances visible on all of the owner's devices and
     resolvable by name/icon everywhere receipts render.
   - Registration checklist applies: client types/schema/sqlBackend/purge list AND
     server Validators whitelist + ValidationTests case; id length ≤128.
3. **`storeConnLink` — NEW synced per-space entity (the accountLink analogue)**
   - `{ id: v5('sclink:'+spaceId+':'+instanceId), spaceId, instanceId, store,
     displayName snapshot?, addedBy, archived? }`
   - Members of the space see included connections; owner/contributor can add
     their own instances to the space. `StoreMarkerRow` retires into this.

**Duplicate detection:** during connect, fetch the provider profile/member id where
available (AH: member id from the GraphQL viewer; Jumbo: account id). Store a hash
(`providerAccountHash`). If a new connect yields a hash matching an existing
instance of the same store → non-blocking warning sheet: "This looks like the same
Albert Heijn account as ‘X’ — keep both?"

## R2 — Connect & manage UX

- Connect flow gains a final step: **name this connection** (prefill "Albert Heijn"
  / "Albert Heijn 2"). Saving creates the instance + `storeConn` row.
- Instance card actions: rename, change icon (BrandIconPicker), spaces matrix
  (include/exclude per space = `storeConnLink` upsert/tombstone), remove instance
  (revokes local tokens, tombstones `storeConn` + all links; receipts remain —
  raw data outlives the connection, same as bank feeds after consent expiry).
- Browser back: every sheet/sub-screen honors popstate (house rule).

## R3 — Stuck-press bug (ships with the batch, independent of approval)

`pressFeedback.ts` global handler never clears on long-press context menu; the
login anchor keeps implicit pointer capture. Fix: clear pressed state on
`contextmenu` + `pointercancel` + visibility change, and release capture. Kept as
an `<a>` so copy-link still works.

## R4 — Auto-fetch around transaction sync

- Client triggers receipt sync for all owned instances **when new bank
  transactions land**: hook where the sync engine reports fresh tx rows (SSE
  refresh / pull completion), debounced per instance (≥15 min between runs).
- Keep the app-open keep-alive as fallback. Server-side fetch is impossible by
  design (credentials E2EE on device).

## R5 — Matching engine v2

- On every receipt fetch: run matcher for new receipts (auto-link rung-1).
- **When a connection is added to a space** (new `storeConnLink`): re-evaluate all
  transactions in that space against that instance's receipts; auto-link
  unambiguous matches, queue ambiguous ones as suggestions in the Receipts screen.
- **Payment-method awareness:** extend adapters to request payment fields
  (AH receipt detail exposes payment lines incl. masked PAN/IBAN tail; Jumbo TBD).
  New optional `payment { method, accountTail? }` on the receipt. When present and
  the space can resolve the paying account (IBAN tail match against attached
  accounts), matches are constrained to transactions of that account; a tail that
  matches **no** attached account only downranks (bank cards vs. IBAN tails vary).

## R6 — Storage model: global receipts + per-space link overlay

- **`receipt` rows move to a global scope** (owner's user feed, like `storeConn`):
  id `rcpt:{store}:{instanceId}:{ext}` — pulled once, stored once.
- **NEW `receiptLink` per-space entity** (the txMeta analogue):
  `{ id: v5('rlink:'+spaceId+':'+receiptId), spaceId, receiptId, txId,
    linkedBy, auto? }`. All linking (auto + manual) writes here; `ReceiptRow.txId`
  retires.
- Members of a space see receipts of instances linked into the space via
  `storeConnLink` (read-time join), not via row fan-out.
- Migration: existing `rcpt:…@{space}` rows collapse by `storeRef` into one global
  row; their `txId` values become `receiptLink` rows in the original space.
- Photo/manual receipts (no store) stay space-scoped but adopt `receiptLink` for
  consistency.

## R7 — Receipts screen under space Settings

- New row in the "This space" settings group → `/receipts` (existing route,
  rebuilt): filter bar (store, instance, free-text over merchant/items,
  linked/unlinked, date range), store/instance group headers, suggestion inbox
  from R5 ambiguous matches. Desktop = master-detail per existing pattern.

## R8 — TxDetail attach flow redesign

- ReceiptSection empty state becomes one clear sheet: **suggested candidates
  ladder first** (existing `candidateLadder`, now payment-aware), then search all
  receipts, then "take photo / upload" as the fallback rung. Linking writes
  `receiptLink`. Unlink = two-tap.

## R9 — Admin catalog: store labels

- Catalog doc gains `stores: [{ id, names{en,nl,tr}, merchantPatterns[],
  paymentHints[] }]` beside `categories`/`keywords`; admin Catalog screen gets a
  Stores tab (add/edit/retire patterns). Client matcher consumes
  `merchantPatterns` instead of the hardcoded `STORE_MERCHANT` regexes, so admins
  can improve auto-match without releases.

## Cross-cutting (every slice)

EN/NL/TR strings; browser back; desktop + mobile; tests per slice (unit-heavy,
core-flow e2e only); tours + user guide + what's-new; DEV annotations; Sonar
clean; coverage ≥85 %; docker stack rebuild at arc end.

## Suggested slice order

R3 (bug, ships now) → R1 → R2 → R6 → R5 → R4 → R7 → R8 → R9.
R1+R6 are the risky data-model slices and land behind the migration; R7–R9 are
independent once R6 exists.

## Open questions

1. R6 puts store receipts in the **owner's user feed** — acceptable that a member
   leaving a space loses access to those receipts (links purge with the space)?
2. Remove-instance keeps already-pulled receipts (bank-feed analogy). OK, or
   should removing an instance offer "also delete its receipts"?
3. Jumbo payment fields are unverified until someone with a Jumbo login tests —
   ship AH-only payment awareness first?
