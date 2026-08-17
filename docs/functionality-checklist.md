# munni — functionality checklist

A grouped inventory of everything the app does, for manual test passes
(#194). Tick what you verified; every feature change updates this file
in the same commit — the rule lives in the assistant's memory alongside
the user-guide and tour maintenance rules.

## Identity & onboarding
- [ ] Sign in with Logto (web redirect; native deep-link return)
- [ ] Demo mode (sample data, zero network, zero telemetry)
- [ ] Offline identity; go-offline from a signed-in profile
- [ ] Interrupted SSO signup resumes onboarding, never "no account"
- [ ] Onboarding: display name, avatar (upload / native camera / desktop webcam), country search
- [ ] Session expiry: dead refresh grant → silent re-entry near app open, else "sign in again" banner
- [ ] App lock: PIN pad (auto-verify from 4 digits), passkey prompt once per lock cycle, PIN entry dismisses the passkey sheet

## Spaces
- [ ] Create space: name, icon, color, budget period (with explanation), ledger currency, history start, private-mode checkbox
- [ ] Space appearance: picture upload (camera/webcam on capable devices) disables symbol+color while set
- [ ] Space settings icon = palette (identity only: rename, look, leave/delete)
- [ ] Private mode toggle (invite lock) in space settings; sharing & invites when unlocked
- [ ] Members: roles, permissions, kick-out; activity history logs every mutation
- [ ] Space switcher; per-space landing (Home) layout

## Home
- [ ] Balance band modes: net worth / total cash / safe-to-spend (premade, read-only) + Picked accounts (checkboxes)
- [ ] Display-currency lens (band toggle + profile setting, bare currency symbols, ≈ conversions)
- [ ] Blocks: review nudge, new transactions, budgets, events, goals, debts, insights, Explore; customize order/visibility
- [ ] Desktop: two columns only when ≥4 blocks, else one centered column
- [ ] Notifications bell; install hint; update card

## Transactions
- [ ] List: date groups, hairline dividers between transactions (not between split parts), search with clear ×
- [ ] Quick filters: filter sheet (accounts/kinds/categories/dates), uncategorized, unsettled reimbursements, counter transactions (pairs uncollapsed)
- [ ] Pair collapse: one row per transfer with "A → B" note; per-account view keeps both legs
- [ ] Desktop master-detail: full-width selected-row highlight, `/` focuses search
- [ ] Manual add/edit: amount arithmetic, account picker, category, counterparty, adjustment toggle, date guard with full history-move door
- [ ] Detail: consistent affordances (pencil = edits here, chevron = navigates); rename/edit, categories editor, split door last, recurring/event pickers with logos + quick-create, notes inline, receipt, facts, customize blocks, delete
- [ ] Split transaction: values editor (amount/pct with mode explainer), per-part deck (categories, counterparty, counter transaction, recurring/event with quick-create), part pages
- [ ] Split categories: one transaction, several categories; special categories span the whole; percentage spreads
- [ ] Counterparty: one per (split) transaction; counter-first fills the category; counter transaction row (pick existing / create / await feed); unpair dialogs
- [ ] Reimbursements: expected/received, settle order (expecting → uncategorized → largest), net display, links both directions

## Review
- [ ] Card queue: category rows, counterparty row, counter-transaction row, recurring, event, split door (last)
- [ ] Memory: recency-weighted category recall (space-own first), spreads, events, titles; amount match
- [ ] Bulk confirm: similar transactions, percentages refit each amount
- [ ] Skip leaves no trace; desktop top-anchored card with buttons beneath

## Categories
- [ ] Catalog: built-in + custom parents/subs; income ◆ special parent; new mains are expense
- [ ] Manage: create/edit/delete with impact guard, icons search, colors, drag subs between mains, hold-menu
- [ ] Picker: search (hide-on-scroll-down, back on scroll-up), ◆ special filter chip, create-custom door, no stale error flash

## Recurring costs
- [ ] Five tabs (period, next, this year, next year, all); occurrence-filtered; pre-start occurrences excluded
- [ ] Detection inbox: evidence, accept (prefilled form), dismiss; lender patterns live on Debts instead
- [ ] Price-change badges, yearly totals, due days, payment history, logos everywhere pickers list costs

## Debts & loans
- [ ] Loan = account (loan/mortgage/credit); track-as-debt toggle; APR nag; payment plan with due day
- [ ] "Left to pay", payoff projection, payment history, unassigned payments bucket
- [ ] Detection: DUO-style lender patterns as cards on the Debts screen — track in place (prefilled chooser) or "Not a loan"

## Events
- [ ] Create/edit with cover picture; date range; per-day cost; category breakdown with drill
- [ ] Attach transactions: full screen, checkboxes left, select/deselect all, split parts attach individually

## Goals, budgets & allocation
- [ ] Goals with cover pictures and progress
- [ ] Budgets: categories with exclusivity, carry-over modes, warning threshold; period math follows the space rhythm
- [ ] Allocation (envelopes): to-allocate, per-period cells

## Accounts & banks
- [ ] Global overview: one plain "Connected & imported" section (no types at global level), shared-with-me, per-space sections with types
- [ ] Unattached accounts wear a badge (no auto-attach offer); explicit attach picks space, TYPE and history start
- [ ] Space level: type leads each row's subtitle; info sheet shows global name, per-space rename, type change (re-reviews that space only), history-from, provenance, "view in all accounts" door, detach
- [ ] Bank connect (GoCardless/Enable Banking): provider choice, consent, callback screens, never auto-attaches, nightly fetch, reconnect hints, sync-empty/dropped warnings
- [ ] Account deletion with purge; co-owned same-IBAN feeds; feed janitor
- [ ] Import (CAMT/ING CSV/PayPal): preview with pre-start warning, busy note on click-away, no false "archived" badge mid-import, result step with explicit attach door, batches with rollback, reconcile suggestions
- [ ] Account editor: name, icon/logo picker (sheet stacks correctly), balance (adjustment row for defaults), loan fields, type row

## Portfolio
- [ ] Holdings search (stocks/coins), buys/sells, valuation

## Insights, trends & overview
- [ ] Overview per period, category drill; trends charts; insights; net-worth series

## Receipts & shopping
- [ ] Receipt capture (camera on native, webcam on desktop, upload), OCR link suggestions, receipts list search

## Splits (bill splitting)
- [ ] Split sessions with friends, invites, event attachment, settle flows

## Friends
- [ ] Friend requests, list, invitations into spaces

## Settings
- [ ] Space settings: groups (plan/track/learn/setup), sync status row, budget period, currency (with explainer), history start with impact counts
- [ ] Global settings: profile, spaces, all accounts, friends, connections, devices (browser names, numbered duplicates, rename/disconnect), language, shopping, export, help, push, app lock, appearance (tap row to cycle light→dark→auto), tips
- [ ] What's-new entries per release; user guide (10 sections) regenerated on change

## PWA & native
- [ ] Installable, offline precache, web push, favicon/leaf icons per channel, update toast
- [ ] Native shells: universal-link auth return, camera capture, biometric lock, store update polling

## Offline & sync
- [ ] Local-first everywhere; outbox; HLC/LWW convergence; per-field merges
- [ ] Start date governs on every device (link gates heal every boot)
- [ ] Offline banner truthfulness: no-network / unreachable / session-expired / version mismatch
- [ ] GlitchTip: unexpected 5xx/409 reported from the API choke; import failures reported; demo/offline identities send nothing
