# Desktop experience — evaluation & redesign plan (PLAN, awaiting approval)

Status: **proposal 2026-07-14**, written after reviewing live desktop
screenshots (login, home, transactions, portfolio, review). The login
backdrop shipped separately; everything below awaits approval.

## Verdict

The desktop app is consistent, fast and never broken — but it is a
**phone app given elbow room**, not a desktop app. The sidebar, the
1080px content ceiling, the right-panel sheets and the two-column Home
are genuinely good bones. Three things undercut it:

1. **Information density.** A transaction row is a ~1040px-wide card
   carrying two data points (merchant, amount). A desktop reader
   expects date, account, category and amount at a glance — the width
   is there, the data is hidden one click away.
2. **Navigation where a pane would do.** Clicking a transaction leaves
   the list for a full detail screen; back, click, back, click. On a
   1440px screen both fit comfortably side by side.
3. **The review screen floats in a void.** The deck card is small and
   center-locked, the Confirm bar is glued to the bottom of a mostly
   empty viewport a long way from the card, and the staged pickers
   (type/category/split) open detached at the right edge. The eye
   travels constantly.

Home is the strongest screen (the landing-zone grid uses the width);
Portfolio's empty state is fine; Settings reads well as stacked lists.

## What already works — keep

- Sidebar nav + 1080px ceiling (redesign §4.1)
- Sheets as right-hand panels on md+
- Home's two-column block grid
- The new full-bleed login

## Plan (slices, in priority order)

### D1 — Transactions master–detail (biggest win)
On `lg+`: list keeps the left ~55%, clicking a row opens the detail in
a right pane instead of navigating (the route still changes — deep
links and browser back keep working; on mobile the same route stays a
full screen). Row click swaps the pane content in place; Esc / ✕
closes back to the plain list route.

### D2 — Denser rows on md+
Transaction rows gain inline columns where width allows: account name
and date right-aligned before the amount; category chip stays under
the merchant. Row padding tightens (56px → 48px). Date group headers
become sticky while their group scrolls.

### D3 — Review focus layout
The deck card gets a fixed 520px column, vertically centered; Skip /
Confirm attach directly under the card (not a full-width bottom bar).
The staged pickers (type, category, splits) open as an inline right
rail beside the card — card and editor visible together, no overlay.

### D4 — Home header compaction
The full-width dark balance band becomes a card in the left column on
md+ (it currently spans 1040px to say one number). Nudge banners
(what's-new, install, tour) move to the top of the right column.

### D5 — Desktop affordances
- `/` focuses search on Transactions; Esc already closes sheets
- Review: ←/→ = Skip / open-next, Enter = Confirm
- Hover states on rows (already partial) + pointer cursor audit

Non-goals: no separate desktop app shell, no data-grid/table rewrite
of the list (cards stay, they just say more), no drag-window layouts.

## Effort

D1 ~1 arc; D2–D4 each well under one; D5 trivial. All safe behind
`lg:` classes — mobile untouched, so gallery baselines only change for
desktop variants (evaluated manually per test-variants rule).
