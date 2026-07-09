# Tutorials & in-app help — design

Status: **draft for approval** — nothing here is built yet.

## The idea

Teaching lives in three layers, from cheapest to deepest — the user
picks how much they want, per feature, whenever they want:

1. **Feature intro card** (passive): the first time a screen with a
   registered tutorial opens, a dismissible one-liner card at the top —
   "New here? 60-second tour →". Never nags again once dismissed.
2. **Slide tour** (quick screening): 3–6 illustrated slides per feature
   in a sheet — swipeable, skippable, done in a minute. Pure content,
   no app interaction. This is the default when tapping a help button.
3. **Interactive walkthrough** (full tutorial): a spotlight overlay
   that dims the screen, highlights the real element (by testid — we
   already have stable ids on everything), explains it, and advances
   when the user taps the highlighted control. "Try it yourself" mode.

Every feature screen gets a **help affordance in its app bar** (the
`?` icon) opening layer 2 with a "Show me interactively" button into
layer 3. A **Help & tutorials** index in Settings (Everywhere) lists
all tours for re-running.

## Content model — declarative, i18n-first

```ts
// src/features/help/tours.ts
interface TourStep {
  titleKey: TranslationKey;
  bodyKey: TranslationKey;
  illustration?: string;        // small inline SVG/emoji-scale art
  anchor?: string;              // data-testid to spotlight (layer 3 only)
  advanceOn?: 'tap' | 'next';   // tap the real element vs Next button
}
interface Tour { id: 'home' | 'transactions' | 'review' | 'budgets' | …; steps: TourStep[] }
```

Tours are data; the two renderers (slides sheet, spotlight overlay)
are generic. Adding a feature = adding a tour entry + i18n strings —
no bespoke tutorial code per screen. All copy EN/NL/TR from day one.

## Spotlight mechanics (layer 3)

- Overlay portal: dimmed backdrop with a cutout around
  `getBoundingClientRect()` of the anchor testid, tooltip positioned
  above/below, scrolls the anchor into view first.
- `advanceOn: 'tap'` forwards the tap to the real element (the app
  actually navigates/opens sheets) — the tour definition follows the
  real flow. A step whose anchor is missing (empty state) is skipped.
- Escape hatch always visible ("End tour"), progress dots, resumable.

## State

Device-level meta (not synced — tutorials are per person, per device):
`tutorialSeen_{tourId}` and `introDismissed_{tourId}` in the meta
table. The demo identity is the perfect tour sandbox — the Settings
index offers "Open in demo" when signed in? (question 3).

## Rollout

- **T1** — tour registry + slides sheet + `?` app-bar button on Home,
  Transactions, Review + Settings index. Content for those three.
- **T2** — spotlight walkthrough engine + interactive tours for Home
  and Review (the flows with real steps).
- **T3** — intro cards + tours for budgets, recurring, spaces/sharing,
  accounts/import.
- Tests: registry completeness (every tour key exists in i18n ×3),
  slides navigation, spotlight anchor skip logic.

## Open questions

1. Which three features get content FIRST? My pick: Home (orientation),
   Review (the habit), Budgets (the newest concept).
2. First-launch behavior: auto-open the Home slide tour once after
   onboarding, or intro-card only (my pick: intro card — less modal)?
3. Tours run against the user's real data (safe — tours never write).
   Or should interactive tours prefer the demo space? (my pick: real
   data, steps skip empty states.)
