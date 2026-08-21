# munni — functionality checklist

The high-level manual test inventory (#194): the CORE things to walk to
know each feature works — not a changelog. Feature changes update the
affected line (or add one only for a genuinely new core flow); details,
fixes and internals never become items. The rule lives in the
assistant's memory alongside the guide/tour maintenance rules.

## Identity & onboarding
- [ ] Sign in (web + native return), demo mode, offline profile
- [ ] Fresh signup walks onboarding (name, avatar, country) and an interrupted one resumes
- [ ] Session survives restarts; an expired session recovers or says so honestly
- [ ] App lock: set up, unlock with PIN and passkey, disable

## Spaces & sharing
- [ ] Create a space (period, currency, start date); edit its identity; switch spaces
- [ ] Invite-lock toggle gates all sharing; invite an existing friend with a role; invite a new person from the members screen (accept joins the space)
- [ ] Members: view, change role, remove; the removed member is told and lands in another space
- [ ] Leave a space; history start date moves with honest consequences

## Home
- [ ] Balance band modes and per-account picks; blocks render, reorder, hide
- [ ] Quick-add FAB reaches all six doors
- [ ] Review nudge, new transactions, upcoming costs and notifications reflect reality

## Transactions
- [ ] List: search (title + amount, highlighted), quick filters, filter sheet; filters survive a detail detour
- [ ] Transfer pairs collapse to one row; per-account view keeps both legs
- [ ] Add/edit a manual transaction end to end (amount math, account, category, counterparty, date guard)
- [ ] Detail: recategorize, rename, counterparty set/remove, recurring/event links, notes, receipt, customize sections, delete
- [ ] Split a transaction into parts; edit parts; un-split; split categories (€ and %) on rows and parts
- [ ] Reimbursements: link both directions (with clamping errors), parts included; unlink restores

## Review
- [ ] Walk the queue: category, counterparty, counter-transaction, recurring, event, split — confirm and skip
- [ ] Memory pre-fills return; bulk "apply to similar" applies what it promised

## Categories
- [ ] Browse and search the picker (parent names match, ◆ filter); manage: create/edit/delete customs with impact warnings; locked families refuse subs
- [ ] Account-typed rows only offer categories that fit

## Recurring & debts
- [ ] Detection inbox → accept walks the occurrence review; linked charges take the category
- [ ] Ranges (period/next/year) tell the truth; the year chart plots estimate vs paid
- [ ] A loan account shows debt, plan, payments and payoff; lender detection lands on Debts

## Accounts & banks
- [ ] Global overview: sections, defaults fold, echoes jump to the real row
- [ ] Connect a bank (choice, consent, callback, nightly fetch, reconnect); imports (bank chooser, preview, progress, result → explicit attach)
- [ ] Attach/detach per space with type; rename locally vs globally; type change re-reviews that space only
- [ ] Edit an account (balance → adjustment where it applies); delete manual and bank-fed accounts cleanly

## Plans (budgets, goals, allocation, events)
- [ ] Budget lifecycle: create with categories, thresholds warn, carry-over works
- [ ] Goals fund and progress; allocation envelopes fill per period
- [ ] Events: create, attach transactions (select-all screen), per-day costs and drill

## Portfolio, insights & receipts
- [ ] Holdings buy/sell and valuation; overview/trends/insights drill correctly
- [ ] Receipt capture (camera/webcam/upload) links to transactions; shopping connections pull receipts

## Splits (bill splitting) & friends
- [ ] Split session with a friend end to end (invite, expenses, settle)
- [ ] Friends: add by ID, accept, profile sheet (copy ID, remove)

## Settings & platform
- [ ] Space settings rows all lead somewhere sane; global settings: profile, devices, language (EN/NL/TR), appearance cycle, export, push, tips
- [ ] PWA installs and updates; native shells build, deep-link back and capture photos
- [ ] Offline end to end: everything works, syncs on return, conflicts converge
