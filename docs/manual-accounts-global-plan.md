# Manual accounts go global — plan

Status: **DESIGN — awaiting approval + answers** (2026-07-22). User
ruling: manual accounts should work like linked bank accounts — global
at the identity level, visible per space only through attachment, raw
transaction data global, per-space modifications local to the space.

## Today vs target

Today a manual account is a plain `account` row INSIDE one space; its
transactions belong to that space alone; another space can never see
it. Bank/CAMT accounts already have the right shape: the account and
its raw transactions live in a **feed space**, spaces opt in via
`accountLink`, and per-space edits (category, notes, splits) stay in
the attaching space.

Target: manual accounts adopt the exact same feed machinery — one
model for every account, and the new per-space attach/detach screen
(shipped 2026-07-22) works for manual accounts unchanged.

## Design

- **Creation** (Global settings → Financial accounts → add): a manual
  account gets its own feed space — `personalFeedSpaceId(accountId,
  sub)` for syncing identities, a local feed-shaped id offline. The
  account row + all its transactions live there. Server-side the feed
  registers like a CAMT feed (`POST /feeds`).
- **Attachment**: identical to bank accounts — `accountLink` +
  server link; the space's Financial accounts screen is the only
  attach/detach surface. History start date applies (manual tx before
  the date stay invisible in that space).
- **Raw vs transformation** (existing law): amount, date, description,
  balance = raw, global, editable by any feed member wherever they see
  it (edits propagate everywhere, like a bank correction would).
  Category, notes, splits, reimbursements = per-space.
- **Multiple owners**: feeds already allow several members (family
  GoCardless model). Any feed member can enter/edit raw transactions;
  all members see the same raw history.
- **Ownership transfer**: when the last owner leaves a space the
  account is attached to — or deletes their munni account — feed
  ownership transfers to the OWNERS of the spaces it is attached to
  (they become feed members) instead of the data dying. Detach-
  everywhere plus sole ownership = the feed is deleted with the
  account (today's cascade).
- **Migration**: a one-time client+server migration moves every
  existing per-space manual account into its own feed space +
  auto-attaches it to its original space with full history — no
  visible change for the user, but afterwards it can be attached
  elsewhere. Offline identities migrate purely locally.

## Open questions (please answer before build)

1. **Cross-space raw edits.** Space B's member (not the creator) has
   the account attached and fixes a typo in a transaction amount —
   that edit is raw, so it changes what space A sees too. Intended?
   (The bank-account analogy says yes; saying no means amounts become
   per-space and balances diverge.)
2. **Who may add transactions?** Any member of any attached space, or
   only feed members (creator + transferred owners)? I lean: any
   member of an attached space may ADD (a household logs cash spends
   together), raw EDITS restricted to feed members.
3. **Balance.** Manual balance is currently a stored number nudged by
   manual tx deltas. Global model: one global balance on the feed
   account (space-independent). OK?
4. **Ownership transfer timing.** Transfer when the last owner
   LEAVES a space / deletes their account — automatic to all owners
   of all attached spaces, or should the leaver get a "hand over to
   whom?" choice when multiple candidates exist?
5. **Migration consent.** Silent auto-migration on app update, or a
   one-time "your manual accounts are now global" notice?

## Slices (after answers)

- MA1 server: manual feeds (register/membership/transfer rules) +
  validators + tests
- MA2 client: creation into feed space + migration (online + offline)
- MA3 attach/detach parity + raw-vs-transform enforcement for manual
  tx + balance unification
- MA4 ownership-transfer flows (leave space, delete account) + tests

## Related follow-up (noted, separate)

Consent expiry push: the space accounts screen now flags stale
GoCardless syncs client-side ("Reconnect?"); a server-driven push
notification when a 90/180-day consent actually expires belongs in
the notifications backlog.
