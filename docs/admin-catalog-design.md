# Admin-editable builtin categories + AI prediction keywords — design for review

Status: PROPOSAL 2026-07-17 (user request: manage the premade category
catalog and the keyword→category prediction rules from the admin panel,
including a story for offline users).

## What exists today

- **Builtin categories** are a hardcoded array in
  `apps/web/src/domain/categories.ts` (ids, icons, colors, txTypes,
  localized via `cat.*` i18n keys). Every client — user, demo, offline —
  carries them in the bundle. User-created categories are ordinary
  synced rows on top.
- **Prediction keywords** (`predictTx`'s `keyword` source) are likewise
  a hardcoded keyword→category map in `domain/predictCategory.ts`.

Both are *content*, not code — they change more often than logic and an
operator (you) should be able to edit them without a redeploy. But they
are also *referenced by data*: every transaction stores a `catId`, so a
deleted builtin strands transactions, and i18n names live in the app
bundle, so a brand-new category added server-side has no NL/TR name
until the bundle knows it.

## Design: a versioned catalog document, bundled as the fallback

One mechanism for both datasets ("catalog" = builtin categories +
keyword rules):

1. **Storage**: a `catalog` table on the API (one JSON document per
   version: `{ version, categories: [...], keywords: [...] }`). The
   admin panel edits a draft and **publishes** it, bumping `version`.
2. **Serving**: `GET /catalog` (public, cacheable, ETag = version).
   Clients fetch it opportunistically at sync time, cache the document
   in the local db (`meta.catalog`), and **fall back to the bundled
   copy** when they have never fetched one. `buildCatalog()` reads
   bundled + fetched and the higher version wins.
3. **Names/i18n**: server categories carry their own `{ en, nl, tr }`
   names (the admin form requires all three — same rule as the app).
   Bundled builtins keep their `cat.*` keys; fetched ones use their
   embedded names. That removes the bundle coupling for NEW categories.
4. **Deletion** (the dangerous one): the admin panel warns with the
   affected-transaction story spelled out and requires a typed word,
   like account deletion. A deletion is published as a **tombstone**
   (`{ id, deleted: true }`) — clients that see the tombstone detach
   local transactions to `uncategorized` the same way user-category
   deletion already does (the detach logic exists in categoryOps).
   Tombstones never remove the id from history exports.
5. **Offline users** (your question): auto-committing to source from
   the admin panel is possible (a workflow_dispatch that writes the
   JSON + opens a PR) but it ties production content to git pushes and
   still doesn't update *installed* apps until they update. Cleaner:
   offline profiles simply **keep the bundled catalog of the version
   they installed** — they never talk to a server by definition, and
   their categories keep working forever (tombstones can't strand them
   because they never see them). The bundled copy gets refreshed from
   the database **at build time** (a small script pulls `GET /catalog`
   during CI, or reads a committed `catalog.json` that the admin
   "Export to repo" button downloads for you to commit). Recommendation:
   the CI fetch — zero manual steps, and every release bakes the then-
   current catalog in as the new offline baseline.
6. **Keywords**: same document, same flow, no client migration at all —
   `predictTx` just reads the merged keyword list. Admin UI: a simple
   table (keyword, category, add/remove) with a test box ("type a
   merchant, see what it predicts").

## Slices

- **AC1**: API `catalog` table + GET/PUT endpoints (admin-gated PUT) +
  client merge in `buildCatalog` + keyword merge in `predictTx`.
- **AC2**: admin panel editor (categories tab + keywords tab, publish
  with version bump, typed-word delete warning + tombstones).
- **AC3**: client tombstone handling (detach to uncategorized) + CI
  bake-in for the offline baseline.

## Review questions

1. OK that offline profiles freeze on their install-time catalog
   (no auto-commit-to-git), refreshed only via app updates?
2. Should catalog edits apply to ALL users immediately on next sync
   (proposed), or per-space opt-in?
3. Deleting a builtin also deletes its subcategories (cascade, like
   user categories) — confirm.
