# Interactive space walkthrough after signup — plan

Status: **DESIGN — awaiting approval** (2026-07-22). User idea: after
signup, walk the user through CREATING and DELETING a real space so the
space concept lands — a tour that interacts with the live environment,
unlike today's point-and-tell steps.

## My honest take (asked for)

The idea is good, the deletion half is not. Creating a throwaway space
teaches the concept viscerally — but making a fresh user DELETE
something in their first minutes teaches the wrong lesson ("things
here get destroyed") and trains them to click through danger confirms
(we just added a cooldown to make deletion feel weighty; the tutorial
would immediately undermine it). Deletion is also the one step that
can't be made safe against a user wandering off mid-tour.

**Counter-proposal:** a guided *"Make it yours"* walkthrough that
creates and keeps something useful:
1. "This is your Personal space — everything lives in a space." (point)
2. "Spaces separate bookkeeping: household, a trip, a hobby." (point)
3. **Do:** create a second space together (name prefilled "Household",
   user can edit) — the walkthrough drives the REAL form.
4. **Do:** switch between the two via the Home avatar switcher — the
   moment the concept clicks.
5. "Invite someone later from here; delete a space here — munni asks
   twice." (point at the danger zone, never press it)
6. Offer: keep the new space, or "remove it again" — ONE tap on offer
   removes the tutorial space (walkthrough-owned, so no danger-confirm
   is undermined; it was ours, not theirs).

Step 6 gives the create+delete round-trip the user wanted, with agency
and without rehearsing destruction on real data.

## Mechanics: an `acts` tour mode

Today's tours point (`anchor`) and can forward one tap (`advanceOn:
'tap'`). This adds a third capability, kept deliberately narrow:

- `TourStep.act?: 'await-testid' | 'await-value'` — the step completes
  when the environment REACHES a state (e.g. a space row with the
  tutorial marker exists), not when Next is pressed. The card shows a
  live checklist tick when the condition lands.
- The walkthrough never writes data itself except in step 6's offered
  removal (tagged: the space row carries `tutorial: 1` so the
  walkthrough only ever deletes what it created).
- Escape hatches everywhere: End tour keeps whatever exists; re-running
  the walkthrough detects a leftover tutorial space and resumes.
- Trigger: once, after onboarding completes (signed-in identities), as
  an offer card on Home — never auto-started mid-task. Offline
  profiles get it too (spaces are local there).

## Slices

- SW1 tour engine `act` steps (await-state completion + checklist UI)
- SW2 the five-step walkthrough + tutorial-tagged space + resume logic
- SW3 Home offer card + once-per-identity persistence + EN/NL/TR
- Tests: full walkthrough run (create → switch → keep), the remove
  offer, abandonment + resume, re-run idempotency.

Open question for the user: agree with replacing the delete step by the
"walkthrough-owned space + optional removal" shape, or do you want the
literal create-then-delete drill anyway?
