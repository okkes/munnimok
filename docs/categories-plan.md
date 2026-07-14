# Built-in category catalog — improvement plan (PLAN, awaiting approval)

Status: **proposal 2026-07-14**. Already shipped separately (user's
explicit asks): Alcohol/Tobacco split, "Expected reimbursement" made
pickable under Extras. Everything below awaits approval.

## Principles

- Ids are forever (transactions reference them); improvements are
  renames, moves, additions and hiding — never id changes.
- A sub belongs where the money is spent, not where it is managed.
- Every main keeps an "Other" sub as the catch-all.

## Proposed additions

| New sub | Under | Why |
|---|---|---|
| `insurance` (Liability/legal insurance) | extra | NL staple (AVP, rechtsbijstand) — today lands in Extras/Other |
| `phoneInternet` (Phone & internet) | housing | subscriptions is entertainment-flavored; utilities is energy/water |
| `software` (Apps & software) | education or entertainment | recurring app/cloud spend is neither video-game nor TV |
| `parking` (Parking & tolls) | transport | frequent, distinct from fuel |
| `bikes` (Bike & maintenance) | transport | NL reality; car-flavored subs don't fit |
| `lunchWork` (Work lunches) | consumption | the breakfast/lunch sub currently absorbs both moods |
| `kidsActivities` (Kids & clubs) | extra (or its own main with childCare) | childCare under Shopping is about goods; activities are ongoing |
| `garden`? | — no: houseGarden already covers it | — |

## Proposed moves / renames

1. `subs` (Streaming & subscriptions, under entertainment): rename to
   "Streaming" and stop being the dumping ground — software/phone get
   their own homes (above).
2. `childCare` (under shopping): move to `extra` next to familyCare —
   it is rarely a "shopping" decision. (Move = new id `childCare2`? No:
   parentId is data, not id — a parentId change on the BUILTIN catalog
   is safe because ids stay.)
3. `newspaper` (under education): rename copy to "News & magazines".
4. `intimateUtility` (under shopping): copy is cryptic in all three
   languages; propose "Adult & intimate".
5. `gambling` keep, but consider a gentle icon change (dice) — the slot
   machine reads judgmental.

## Hidden-by-default candidates

Rarely used mains clutter the picker for new users. Proposal: a
per-space "enabled mains" set (default: all on) managed from the
categories screen, so e.g. `pet` or `investment` can be switched off
per space. This is UI filtering only — data never blocks.

## Keyword follow-up

Each addition ships NL keyword rules (client + server predictor) in the
same slice, e.g. parking: `q-park`, `parkeren`, `anwb parkeren`,
`parkmobile`; phoneInternet: `kpn`, `odido`, `ziggo`, `vodafone`,
`youfone`, `simyo`.

## Slices

- C1: additions + translations + keyword rules.
- C2: moves/renames.
- C3: per-space enabled-mains filter.

## Decisions needed from the user

1. Approve/strike each addition and move above (table + list).
2. `software`: under education ("tools") or entertainment ("apps")?
3. Is the per-space enabled-mains filter (C3) wanted at all?
