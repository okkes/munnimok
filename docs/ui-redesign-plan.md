# UI/UX redesign plan — the consistency pass

Status: **draft for approval** — nothing here is built yet.
Lens: a domain-aware, pixel-picky pass over every screen after five
feature waves landed in quick succession. The verdict up front: the
foundation is genuinely good — the drift is in the details, and it is
fixable systematically rather than screen by screen. This plan also
prepares the codebase for the upcoming desktop view: most of the work
that fixes mobile consistency is exactly the work that makes a
two-pane desktop cheap.

## 1. What holds up (don't touch)

- **The token system.** Semantic color pairs (`accent/-soft`,
  `negative/-soft`, `warning/-soft`, `info`, `special`) with full dark
  parity. The serif display headers against the warm paper background
  are the brand.
- **The card language.** White surface, 1px `line` border,
  `rounded-card`, generous outer gutter (px-5) — consistent everywhere.
- **The empty-state pattern.** Icon 34 / title 14 / body 12, centered,
  pt-16 — every new screen adopted it correctly.
- **Sheets.** All flows use the shared vaul Sheet with the title-prop
  drag zone; no rogue overlays crept in.
- **Home as a block registry.** Eleven atomic blocks behind one
  customizer — this architecture is what will make desktop layout
  nearly free.

## 2. The deviations (audit findings)

Each item names the offender so the fix is mechanical, not archaeology.

**A. Color discipline broke — raw hex in feature code.**
`styles.css` line 8 says "never raw hex values", yet:
`HomeScreen` TILE_META (`#A8782B`, `#673AB7`), the portfolio home
block (`#673AB7`), `PortfolioScreen` CLASS_COLORS (`#3498DB`,
`#F39C12`, `#95A5A6`, `#9B59B6`). These also have no dark-mode
variants, so they sit identically on dark paper where every token
shifts. Fix: map saving→`warning` (ochre), investment/portfolio→
`special` (violet), etf→`info` (slate), crypto→`warning`,
cash→`ink-4`, other→`special`. Zero new colors needed — the five
families cover the app's whole vocabulary:
*accent = healthy/positive · warning = attention/idle money ·
negative = leak/over · info = neutral data · special = investing.*

**B. List-row anatomy drifted into five variants.**
Settings rows: `py-3.5`, 15px text, bare 20px icon. Home block rows:
`py-2.5`, 13px, colored icon. Shopping stores: `py-3.5`, 15px.
Receipts browser: `py-3`, 13px. Help index: `py-3.5`, 15px. The rule
that wants stating: **navigation rows** (go somewhere: settings, help
index, stores) are 15px/`py-3.5`; **data rows** (show a record:
receipts, lots, contributions, upcoming) are 13px title + 11px meta /
`py-2.5–3`. Codify as two `<Row>` presets and migrate.

**C. Icon-tile drift.** Hero tiles h-12/rounded-2xl (events, goals,
debts, tx category…), card tiles h-10/rounded-xl (home review,
budgets teaser), compact h-9 (home debts/portfolio/insight blocks),
and plain untiled icons in settings rows. Codify: `Tile` at exactly
two sizes — 48 for heroes, 36 for rows/blocks — always
`soft-of-color` background, and settings rows stay untiled by design.

**D. Six hand-rolled hero cards.** Budget detail, event detail, goal
detail, debt detail, holding detail and the receipt view all build the
same anatomy (tile + big number + sub + right-badge + progress + meta
row) with diverging number sizes (24 vs 28), badge placement and meta
separators. One `<HeroCard>` with slots ends the drift and gives
desktop one component to restyle.

**E. The progress bar exists eight times.** h-1 (home budgets), h-1.5
(budgets/events/goals/debts), h-2 (portfolio allocation), each with
inline color logic. One `<ProgressBar size color value>`.

**F. Chips and pills are ad hoc.** Four chip builds (allocation
suggestion chips, asset-class chips, lot-kind chips, tx filter chips)
and five badge builds (Unmatched, Coming soon, Viewed, NL language
badge, review count). Two primitives: `<Chip selected>` (interactive,
full-round, accent-soft when on) and `<Pill tone>` (static label,
tone = neutral/warning/accent).

**G. Form fields wobble.** Input heights h-12/h-11/h-10 mixed inside
the same sheets; labels appear as `m-cap`, as 12px ink-3 text, or not
at all (placeholder-only). Rule: primary field h-12, paired/inline
fields h-11, label always 12px ink-3 above (m-cap reserved for section
captions, not field labels). A `<Field>` wrapper enforces it.

**H. Home app bar is over capacity.** Five trailing icons (offline,
bell, help, customize, space switcher) truncate the greeting on narrow
phones. Rule: max three trailing icons per bar. Proposal: keep bell +
switcher; fold Help and Customize into the switcher sheet's footer or
a single ⋯ menu.

**I. Settings "This space" card is nine flat rows** — it reads as a
junk drawer now. Group with the existing caption style:
*Plan* (Budgets, Allocation) · *Track* (Events, Goals, Debts,
Portfolio) · *Learn* (Insights) · *Setup* (Space settings,
Categories). Same door, findable in a glance. The home customizer
(11 blocks) gets the same captions.

**J. Number typography is m-num but freehand sizes.** 28 (home
balance, allocate header, portfolio total), 24 (detail heroes), then
15/14/13/12/11 scattered. Fix the scale: `display` 28 / `title` 24 /
`row` 14 / `meta` 12 / `cap` 11 — and map every money figure onto it.
Also: percent signs are formatted three different ways (`+` hand-glued,
`fmtCents sign`, `toFixed(1)%`) → one `fmtSignedPct` helper.

**K. Intro cards interrupt active work.** The review intro card
renders above a live review queue (see 14-review-flow screenshot) —
teaching a user who is already mid-task. Rule: intro cards only render
when the screen is idle (empty queue / no data yet); the `?` remains
the always-available door.

**L. Small paper cuts.** Allocate screen has no empty/onboarding state
(instant wall of envelopes); the profile card shows "Profiel /
Profiel" (title = subtitle); receipts rows and unmatched rows are
near-duplicates (unify via `<Row>`); the AH connect sheet's paste
input deserves a monospace ellipsis preview of the pasted code.

## 3. The constitution (rules the primitives will enforce)

| Rule | Value |
|---|---|
| Screen gutter | px-5; cards inner px-4 |
| Row heights | nav 52–56 / data 44–48 |
| Radii | card `rounded-card`, inputs `rounded-input`, chips full |
| Icon sizes | 22 bar · 19–20 row-lead · 17 data-row · 14–15 inline |
| Tiles | 48 hero / 36 row, always tone-soft bg |
| Type | display 28 · title 24 · h3 (bars) · body 14–15 · row 13 · meta 12 · cap 10–11 upper |
| Color | tokens only; tone semantics as §2A; soft bg + deep fg pairs |
| Trailing bar icons | ≤ 3 |
| Money | m-num everywhere; sign via helpers, never hand-glued |

## 4. Desktop plan (what the extra space buys)

The sidebar already exists at `md:`. The single mobile column is then
centered and lonely. Plan, in order of value:

1. **Content ceiling**: max-w-[1080px] with the same px gutters.
2. **Master–detail panes** for list+detail features at `lg:`
   — transactions ⇄ tx detail, receipts ⇄ receipt view, budgets ⇄
   budget detail, recurring ⇄ detail, portfolio ⇄ holding. The routes
   already exist; the pane is a layout wrapper that renders the detail
   route beside the list instead of on top of it.
3. **Sheets become side panels** at `lg:` (vaul `direction="right"`),
   so forms stop covering the context they edit.
4. **Home goes two-column**: the block registry renders into a
   2-col grid (order preserved column-first); the customizer already
   owns order/visibility, so this is pure CSS.
5. **Keyboard**: `/` focuses search, `Esc` closes panes/sheets,
   arrow-navigation in the review queue.

The primitives in §2 are prerequisites: HeroCard/Row/ProgressBar are
the units that reflow; hand-rolled markup would mean re-auditing every
screen twice.

## 5. Implementation phases — pick what runs

1. **U1 — Color & number discipline** (small): kill raw hex, tone
   mapping per §2A, `fmtSignedPct`, constitution committed to docs.
   Zero layout change; dark mode instantly correct for portfolio/tiles.
2. **U2 — Primitives** (medium): `Row`, `Tile`, `Pill`, `Chip`,
   `ProgressBar`, `Field`, `HeroCard` in `src/ui`; migrate the ~30
   call sites. Intended visual delta: only the codified paddings.
3. **U3 — Screen sweep** (medium): settings groups (I), home app-bar
   decrowding (H), intro-card idle rule (K), allocate empty state,
   paper cuts (L).
4. **U4 — Desktop shell** (large): §4 items 1–4.
5. **U5 — Polish** (small): dark-mode re-audit, keyboard map (§4.5),
   focus-visible states, reduced-motion for spotlight/progress
   animations.

Recommended order: U1 → U2 → U3 → U4 → U5, shipped as separate arcs
with the usual verify chain; U1+U2 can land in one day and make every
later feature cheaper.

### Status (2026-07-10)

- **U1 — partially shipped**: raw hex killed in HomeScreen tiles /
  portfolio class colors / drill accents (tokens per §2A); settings
  grouped Plan/Track/Learn/Setup (§2I). Still open from U1:
  `fmtSignedPct` + the full §2J number-typography sweep.
- **U2, U3 (remainder: app-bar decrowding, intro-card idle rule,
  allocate empty state, §2L paper cuts), U4, U5 — pending**, to run as
  their own arcs.

## 6. Open questions — answered (user rulings, 2026-07-09)

1. Settings grouping names: **keep my pick** — *Plan / Track / Learn /
   Setup* stays (shipped).
2. Desktop forms: **right-side panels** — keeps context visible.
3. Desktop density: **comfortable** — keep the mobile row heights.
4. Home on desktop: **strict 2-column split** of the block order (no
   masonry).
