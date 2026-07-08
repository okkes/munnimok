# Design & UX review — munni web

Looking at the product as a design lead against the brand brief
(*professional, minimalistic, yet modern*). Items marked **[needs your
agreement]** are opinions to discuss; unmarked ones are consistency
fixes I consider uncontroversial and can just do.

## What already works

The token system (paper background, deep-green brand, single accent,
generous radii) is consistent and calm; sheets behave natively; the
category/overview drill-downs read professionally; dark mode is not an
afterthought. The app *feels* like one product — that is rare at this
stage and worth protecting.

## Issues, ordered by impact

1. **Spaces settings sheet is overloaded.** [needs your agreement]
   Name, icon, color, currency, period, history-start, members, roles,
   leave, delete — eleven concerns in one scrolling sheet. Sheets are
   for one decision; this is a *screen*. Proposal: `/spaces/$id`
   settings screen (like Manage categories), with the sheet reserved
   for create-space.
2. **Home hierarchy competes with itself.** [needs your agreement]
   The balance band, four overview tiles, review banner and recent
   transactions all shout equally. Proposal: balance band slimmer (one
   line + accounts collapsed behind a tap), tiles become one compact
   2×2 block with smaller numerals, review banner moves above
   transactions as a quiet list row.
3. **Desktop is a stretched phone.** [needs your agreement] The
   sidebar exists, but content stays a single mobile column. Overview
   and Transactions deserve a two-column desktop grid (chart left,
   list right). Defer until mobile is feature-complete, but decide the
   intent now.
4. **Manage categories mixes system and user content without visual
   rank.** Built-ins and custom rows render identically except a badge.
   Custom items should read as *yours*: subtle tinted row background,
   and the per-parent "+" affordance made a visible button instead of a
   bare icon.
5. **Empty states are missing everywhere.** New space → blank
   transactions list with zero guidance. Every list needs a one-line
   empty state with the primary action (Add account / Import / Connect
   bank). Cheap, high perceived quality.
6. **Icon-only meanings.** The direction arrows on category subs and
   the sync cloud icon carry meaning with no text affordance anywhere.
   Minimum: `title` tooltips; better: a one-time legend line on the
   category screen.
7. **Sheet height constants are magic numbers** (300/440/520/560/600/
   640 scattered per call site). Consolidate to three named sizes
   (compact / form / tall) in the Sheet component.
8. **Login screen brand moment is flat.** Wordmark + two grey disabled
   buttons when Logto is unconfigured looks broken rather than staged.
   Hide unavailable providers entirely; lead with the working option.
9. **Profile avatars: preset-only is right for v1**, but the picker
   renders 12 equally-weighted circles with no "current" emphasis on
   the big preview — selected state should mirror up top instantly
   (it does) *and* show the display name under it for context.
10. **Language switch lives at the bottom of Settings** though it is a
    first-run need. It is also in onboarding? It is not — add the
    language chips to onboarding step 1. [needs your agreement]
11. **Lock screen** is functionally right but visually bare (logo +
    button on paper). Give it the brand band treatment so the gate
    feels intentional, not like an error page.
12. **Admin console** is now deliberately spartan — that is correct
    for an operator tool; keep it out of the design system on purpose.

## Feature-sense check

- Overview, Review, Spaces, Categories, Reimbursements, Splits: all
  pull their weight and map to the legacy domain cleanly.
- **Friends as a separate screen** under Settings is odd once spaces
  exist — friends only matter as "people I can invite". [needs your
  agreement] Proposal: fold friend management into the space members
  flow; keep a small "Your ID" row in Profile.
- **Transactions filter chips** (account + review) will not scale once
  feature B lands (many accounts). Plan a filter sheet with sections
  (accounts, categories, type, date range) — design now, build with B.

## Suggested order

(5) and (6) and (7) now (small, no approval needed) → (1) with your
sign-off → (2) → (8, 9, 11) polish batch → (3) desktop when mobile is
stable. I will not touch (1), (2), (3), (10), or the Friends question
without your explicit yes.
