# Receipts v2 — receipts as a first-class feature (PLAN, awaiting approval)

Status: **proposal 2026-07-14** — follows the user's feedback that
"shopping connections and receipts are a bit too unorganized in one
screen"; builds on the shipped S1/S2 mechanics in
[receipts-design.md](receipts-design.md). Nothing here is implemented.

## What the user asked for (paraphrased)

- Receipts deserve their own full feature, not a corner of the
  connections screen.
- Receipts are raw **facts**, like bank transactions: bound to the USER
  (account-level), grouped by store, searchable, re-usable across
  spaces.
- Easy linking to transactions, with a smart suggestion order that
  starts at same-price matches and can widen on demand.
- Sensible auto-attach behavior: first-time connect (a big historical
  backlog) vs. ongoing syncs; old transactions vs. new/to-review ones.

## Proposed shape

### 1. Receipts become user-scoped raw data (like feeds)

Today receipt rows live in the space that captured them. Proposal:
mirror the bank architecture — one **user receipt store** (a personal
"receipt feed"), with per-space LINKS:

- `receipt` rows move to a user-level store: source, store id, date,
  total, items, image. Captured once, visible from every space.
- A `receiptLink` row per space ties a receipt to a transaction of that
  space (the same receipt may prove tx A in the personal space and the
  same joined tx in a shared space — links stay per space).
- Migration: existing space receipts copy into the user store,
  keeping ids; their current txId becomes the first link.

Open question ①: should a receipt ever be visible to OTHER members of
a shared space? Proposal: only its LINK is (the fact that tx X has a
receipt with n items and a total) — the image itself stays with the
owner unless they share the space where it was captured today. Simplest
rule: receipt data syncs only through the user's own devices
(user-scoped space, like offline data), links sync per space.

### 2. A real Receipts screen

`/receipts` grows from "browser" to the feature's home:

- **Grouped by store** (AH, Jumbo, photo receipts …), newest first,
  with a search field that matches store, item names AND amounts (same
  digit-substring rule the transaction search now uses).
- Status chips: linked / unlinked; an unlinked filter replaces the
  current unmatched list.
- A receipt's detail keeps today's sheet (items, OCR, link/unlink,
  delete).
- The connections management moves to a settings-like sub-door on this
  screen ("Connected stores"), leaving `/shopping` a thin config page —
  or is folded into `/receipts` entirely (open question ②).

### 3. Smarter matching ladder

When linking (manual or auto), candidates rank by:

1. exact amount + date within ±2 days + merchant key match
2. exact amount + date within ±2 days
3. exact amount, any date
4. "show more": latest expenses (today's fallback)

The picker UI starts at rung 1–2 and reveals lower rungs behind a
"show more" tap, per the user's "start with same price, show more if
declined".

### 4. Auto-attach policy

- **Ongoing sync** (connection already established): auto-attach when
  rung 1 matches exactly one transaction; otherwise the receipt lands
  unlinked (badge on the Receipts screen). Never auto-attach to a
  transaction the user already reviewed WITH a different manual link.
- **First connect / backlog import**: bulk auto-attach only rung-1
  singles; everything else goes to a one-time "review receipts" queue
  (mirrors the transaction-review deck: accept/skip per receipt).
- Attaching marks nothing reviewed — receipts are evidence, not
  categorization.

### 5. Slices

- V2a: user-scoped store + migration + links (no UI change).
- V2b: Receipts screen (groups, search incl. amounts, unlinked filter).
- V2c: matching ladder in the picker; auto-attach policy + backlog
  review queue.
- V2d: connections fold-in / settings door; tour + EN/NL/TR copy.

## Decisions needed from the user

1. Receipt visibility in shared spaces (link-only proposed).
2. Keep `/shopping` as a separate config screen, or fold connections
   into `/receipts`?
3. Is the one-time backlog review queue worth the surface, or is
   "rung-1 singles auto, rest unlinked" enough?
