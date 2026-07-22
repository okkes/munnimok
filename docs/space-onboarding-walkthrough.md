# Guided onboarding — spaces, accounts, first transaction

Status: **DESIGN v2 — user-scaled scope** (2026-07-22). The original
idea (create/delete a space mid-tour) grew into a full guided
onboarding: the tutorial now IS how a fresh identity gets its first
space, first financial account and first transaction. This version
merges the user's flow with my recommendations.

## The flow (signed-in and offline identities alike)

Runs right after onboarding completes, driving the REAL screens with
real writes — no sandbox, nothing to throw away afterwards.

1. **Name your space.** "Everything in munni lives in a space." The
   walkthrough opens the real create form with "Personal" prefilled;
   the user can rename. This creates the DEFAULT space — there is no
   pre-made one anymore, the tutorial owns first-space creation.
2. **Create a financial account.** Walk to Global settings →
   Financial accounts, create a manual account (cash or checking,
   their pick, starting balance optional). Teaches: accounts are
   GLOBAL, not inside a space.
3. **Attach it.** Back on the space's Financial accounts screen, use
   the new "+ attach" flow (pick the account, keep the default start
   date). Teaches: a space sees only what you attach to it.
4. **First transaction.** Add a groceries expense on that account
   (amount prefilled €12.34, editable). The review/home blocks light
   up with real data — the payoff moment.
5. **A second space.** Create "Family" together, switch to it via the
   Home avatar switcher, and see it EMPTY: the account isn't attached
   here. The scoping lesson lands by observation, not explanation.
   Offer (one tap, optional): attach the same account to Family too —
   or leave it empty and just switch back.
6. **Wrap.** Point at (never press) the danger zone: "Spaces and
   accounts can be removed here — munni always asks twice." Card
   summarizes what now exists: 2 spaces, 1 account, 1 transaction.

## Skipping (encouraged to stay, free to go)

- Every step shows "Skip tour" (small, secondary). The FIRST skip tap
  gets one encouragement line ("2 minutes — it sets up your space and
  first account"); a second tap skips for real. Never nag twice.
- Skip before step 1 completes → munni silently creates a default
  "Personal" space (no account, no transaction) so the app is never
  space-less. Skip later → whatever real data exists stays; nothing
  is rolled back (it's THEIR data — created through real forms).
- Re-entry: Settings → Help → "Restart the welcome tour". Resume
  detection: completed steps (space exists, account exists, …) show
  as pre-ticked and the tour fast-forwards to the first unmet step.

## Offline / demo parity

Offline profiles run the identical flow (all steps are local-first
writes; the attach step uses the local link mirror — no server).
Demo identities skip it: demo data already demonstrates everything.

## Mechanics: the `acts` tour mode

Extends today's point-and-tell tours with state-driven steps:

- `TourStep.act: 'await-testid' | 'await-value'` — the step completes
  when the environment reaches the state (space row exists, account
  row exists, tx row exists), not when Next is pressed. Card shows a
  live checklist tick per condition.
- The walkthrough itself writes NOTHING except the silent default
  space on early skip; everything else goes through the real forms
  the user submits.
- Escape hatches: End tour keeps whatever exists; navigation away
  pauses the tour (resume card on Home); all copy EN/NL/TR.

## Slices

- SW1 tour engine `act` steps (await-state completion + checklist UI
  + resume/fast-forward detection)
- SW2 steps 1–4 (space, account, attach, transaction) + skip paths +
  silent default-space fallback
- SW3 steps 5–6 (second space, switcher, scoping offer, wrap) + Home
  resume card + once-per-identity persistence + EN/NL/TR
- SW4 offline parity + tests: full run, early skip (default space
  appears), mid skip (data kept), abandonment + resume, re-run
  idempotency.

Open items (small, my call unless you object): the encouragement copy
tone, the prefilled amounts/names, and whether step 5's "attach to
Family too" offer defaults to yes or no (I lean NO — the empty space
is the lesson).
