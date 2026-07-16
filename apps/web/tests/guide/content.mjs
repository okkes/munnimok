/**
 * User-guide content (curated, EN-first): each section pairs committed
 * gallery screenshots with instructions and tips. MAINTENANCE RULE:
 * whenever a screen or flow changes, update the matching section here
 * and re-run `npm run guide` — the guide ships inside the app at /guide/.
 *
 * `shots` reference basenames in tests/screenshots (without the
 * `--en-light-mobile` suffix); the generator picks the best variant.
 */
export const GUIDE = [
  {
    id: 'start',
    title: 'Getting started',
    body: `munni is local-first: everything lives on your device and works offline; signing in adds sync between your devices. Try the demo from the login screen — it resets itself on sign-out — or create an offline profile that never touches the network.`,
    tips: ['Install munni as an app (Help → Install as app): you get a clean full screen and your data is protected from browser cleanups.'],
    shots: ['06-demo-login', '37-onboarding', '01-shell-home'],
  },
  {
    id: 'home',
    title: 'Home is yours',
    body: `Home is a landing zone of blocks: review queue, this period, new transactions, budgets, upcoming costs and more. Reorder or hide blocks with Customize Home at the bottom. The avatar on the top right switches spaces.`,
    tips: ['The balance band folds out to show every account.', 'Portfolio has its own tab at the bottom.'],
    shots: ['01-shell-home', '59-overview-home'],
  },
  {
    id: 'banks',
    title: 'Connecting your bank',
    body: `Settings → Global settings → Financial Accounts. Connect a bank (read-only PSD2 access — munni can never move money), import a CAMT.053 statement for accounts your bank won't share, or add cash/savings accounts manually. Bank data lands once per account and every space you attach it to sees the same facts.`,
    tips: ['New transactions arrive automatically several times a day.', 'Reserved (not yet booked) card payments show with a badge and disappear when the real booking lands.'],
    shots: ['16-accounts-list', '19-import-preview', '20-import-run'],
  },
  {
    id: 'review',
    title: 'Reviewing transactions',
    body: `The review deck shows one transaction at a time with a suggested category and the reason behind it. Everything you change — category, type, splits — stays a draft until you hit Confirm. "Also apply to similar" catches the rest of the same merchant in one go.`,
    tips: ['Tap the description to read the full bank text.', 'Skip is honest: it leaves no trace and the card returns later.'],
    shots: ['13-review-banner', '14-review-flow', '15-review-done'],
  },
  {
    id: 'transactions',
    title: 'Transaction details',
    body: `Open any transaction to recategorize, split across categories, link the counter-account (which suggests the type — you can still override it), attach receipts, link recurring costs or events, and record reimbursements that show the net cost.`,
    tips: ['Search matches amounts too: typing 10 finds 10.99 and 210.15.', 'If the counterparty is one of your own accounts, its row becomes tappable.'],
    shots: ['09-tx-detail', '36-tx-split', '34-tx-reimburse', '35-tx-type-link'],
  },
  {
    id: 'spaces',
    title: 'Spaces & sharing',
    body: `Spaces are separate bookkeeping areas — personal, household, a trip. Invite friends into a shared space: everyone sees the same transactions but each space keeps its own categories and budgets. Attach a bank account to any number of spaces, each with its own history start.`,
    tips: ['Roles: owners manage members, contributors edit, readers only look.', 'Leaving a space archives your attached accounts for the others instead of deleting history.'],
    shots: ['22-spaces-list', '33-space-share', '61-feed-share'],
  },
  {
    id: 'splits',
    title: 'Splits — settle up with any group',
    body: `Settings → Splits creates a shared tab for a trip or a night out. Add who paid what — typed in, or picked straight from your own transactions — and the ledger works out who owes whom with the fewest possible transfers. Adjust shares when a split isn't fifty-fifty; shares are locked in when an expense is added, so people joining later never rewrite history. Splits need a connection and a signed-in account.`,
    tips: ['Invite anyone with one share link — no friendship needed; joiners pick which of their own spaces the split attaches to.', 'Link a split to one of your events: searched-in expenses join the event automatically, and the event page shows who owes whom.', 'Members of a split see only the split — never your spaces, accounts or transactions.'],
    shots: ['68-splits-list', '67-split-detail', '69-split-join'],
  },
  {
    id: 'categories',
    title: 'Categories & budgets',
    body: `The built-in catalog covers most spending; create your own main or sub categories when it doesn't. Budgets track a limit per category per period, and the overview drills from totals into categories into transactions.`,
    tips: ['munni learns from you: confirm a merchant twice and it skips review next time — across all your spaces.', 'Can’t find a category while reviewing? The picker offers "create your own" right there.'],
    shots: ['29-cats-manage', '30-cats-create', '60-overview-expense'],
  },
  {
    id: 'trends',
    title: 'Trends, forecast & export',
    body: `Settings → Trends charts your spending per category over the months, income against expenses, and your net worth over time. Home's "Safe to spend" block tells you what is really free until payday — tap it for the full breakdown. And under Global settings → Export data your transactions leave as CSV or a JSON backup, straight from the device.`,
    tips: ['Subscriptions show their yearly cost, and a sustained price change badges itself with the yearly damage.', 'The net-worth Home block is opt-in via Customize Home.'],
    shots: ['63-trends-categories', '65-trends-networth'],
  },
  {
    id: 'devices',
    title: 'Devices & offline',
    body: `Signed in, every device converges on the same data — edits made offline sync when you're back. Two people can edit the same transaction at once; the newer edit per field wins everywhere, identically.`,
    tips: ['Push notifications tell you when new bank transactions arrive.', 'The sync card at the top of Settings shows the last successful sync.'],
    shots: ['25-sync-devices', '58-sync-live', '38-offline'],
  },
];
