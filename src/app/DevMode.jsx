import React from 'react';

// ---------------------------------------------------------------------------
// Activation: append ?dev=1 to the URL. Remove ?dev=1 (or set ?dev=0) to
// deactivate immediately. Internal pushState calls use 2-arg form so they
// never change the URL's query string — ?dev=1 stays present throughout
// an in-app session without needing sessionStorage.
// ---------------------------------------------------------------------------
const isDevActive = () =>
  new URLSearchParams(window.location.search).get('dev') === '1';

const DevCtx = React.createContext(false);
export const useDevMode = () => React.useContext(DevCtx);

export function DevModeProvider({ children }) {
  const active = React.useMemo(isDevActive, []);
  return <DevCtx.Provider value={active}>{children}</DevCtx.Provider>;
}

// ---------------------------------------------------------------------------
// Annotation data — one entry per screenKey (= login mode string)
// ---------------------------------------------------------------------------
const C = {
  state:   '#3b82f6',
  flow:    '#10b981',
  rule:    '#f59e0b',
  edge:    '#ef4444',
  storage: '#a78bfa',
};

const ANNOTATIONS = {
  'login': {
    screen: 'Login',
    sub: 'Main entry point — first screen after install or logout',
    states: [
      { tag: 'fresh install',    note: 'munni_opened_before not set → heading "Welcome to munni"' },
      { tag: 'returning user',   note: 'munni_opened_before = "true" → heading "Welcome back"' },
      { tag: 'SSO loading',      note: 'loadingMethod set → 1 400 ms simulated delay; button shows spinner' },
      { tag: 'email not found',  note: 'loginError set → red border on input; inline "Create account" CTA' },
    ],
    flows: [
      { from: 'Google',             to: 'Home',                    cond: 'google ∈ munni_signup_methods' },
      { from: 'Google',             to: 'Signup onboarding',       cond: 'google ∉ munni_signup_methods' },
      { from: 'Apple',              to: 'Home',                    cond: 'apple ∈ munni_signup_methods' },
      { from: 'Apple',              to: 'Signup onboarding',       cond: 'apple ∉ munni_signup_methods' },
      { from: 'Email → Continue',   to: 'Email verify → Home',     cond: 'email ∈ munni_signup_emails' },
      { from: 'Email → Continue',   to: 'Error + "Create account"',cond: 'email not registered' },
      { from: '"Create account"',   to: 'mode = signup' },
      { from: '"Use demo"',         to: 'Home (demo data)',        cond: 'always; resets demo profiles' },
    ],
    rules: [
      'Email input: no format check — only checks if address is registered',
      'Email override: entering the NEW address after an email-change resolves to the old canonical key',
      'Verify code (login): always 427183 — hardcoded for prototype',
      'SSO delay: always 1 400 ms regardless of network',
      'hasOpenedBefore: LS key "munni_opened_before" === "true" controls heading copy',
    ],
    edge: [
      'Changed email: old address → "not found"; new address silently resolves to old canonical email for storage key lookup',
      'Google/Apple already registered → login goes directly to Home, no onboarding',
      '"Not found" error: pressing "Create account" pre-fills the typed email in signup',
      'Email field pre-filled from sessionStorage if previous session used email login',
    ],
    storage: [
      'munni_signup_methods (LS) — string[] of registered method IDs',
      'munni_signup_emails (LS) — string[] of registered email addresses',
      'munni_opened_before (LS) — controls welcome heading copy',
      'munni_profile_email (SS) — pre-fills email input on return',
      'munni_email_override (LS) — {from, to} for changed-email resolution',
    ],
  },

  'signup': {
    screen: 'Signup — method picker',
    sub: 'User picks how to register. SSO buttons disabled if already used.',
    states: [
      { tag: 'SSO disabled',  note: 'opacity 0.45 + "Already used" note below button if method already registered' },
      { tag: 'signup error',  note: 'signupError shown in red box at top (e.g. "Google already registered")' },
    ],
    flows: [
      { from: 'Google',        to: 'Signup onboarding',  cond: 'google ∉ munni_signup_methods' },
      { from: 'Google',        to: 'Error: already used', cond: 'google ∈ munni_signup_methods' },
      { from: 'Apple',         to: 'Signup onboarding',  cond: 'apple ∉ munni_signup_methods' },
      { from: 'Apple',         to: 'Error: already used', cond: 'apple ∈ munni_signup_methods' },
      { from: 'Email option',  to: 'mode = signup-email' },
      { from: 'Back',          to: 'mode = login' },
    ],
    rules: [
      'Google/Apple: cursor not-allowed, pointer events blocked when disabled',
      'All three methods (google + apple + email) can coexist on one device',
      'SSO: simulated 1 400 ms delay before checking munni_signup_methods',
    ],
    edge: [
      '"Already used" note appears below the button — not a modal or toast',
      'Error box at top only appears when signupError state is set (SSO-level error)',
    ],
    storage: [
      'munni_signup_methods (LS) — checked to disable already-registered SSO buttons',
    ],
  },

  'signup-email': {
    screen: 'Signup — email entry',
    sub: 'User types an email address to register with. Three distinct error cases.',
    states: [
      { tag: 'invalid format',   note: 'EMAIL_RE fails → "Please enter a valid email address"' },
      { tag: 'reserved email',   note: 'google@/apple@/bank@munni.app → "This email is reserved"' },
      { tag: 'already exists',   note: '"Already registered" + inline "Sign in instead" CTA' },
    ],
    flows: [
      { from: 'Send code',         to: 'mode = signup-email-verify', cond: 'valid + not reserved + not registered' },
      { from: '"Sign in instead"', to: 'mode = email-input (email pre-filled)' },
      { from: 'Back',              to: 'mode = signup' },
    ],
    rules: [
      'Regex: /^[^\\s@]+@[^\\s@]+\\.[^\\s@]+$/ — requires TLD; rejects "bla@bla."',
      'Reserved: google@munni.app, apple@munni.app, bank@munni.app',
      'Input trimmed + lowercased before all checks',
      'Button disabled (opacity 0.5) when input is empty',
    ],
    edge: [
      '"Sign in instead" only appears with the "already registered" error, not the others',
      'Lowercasing means "User@Email.COM" and "user@email.com" are the same account',
    ],
    storage: [
      'munni_signup_emails (LS) — checked for duplicate detection',
    ],
  },

  'signup-email-verify': {
    screen: 'Signup — verify code',
    sub: 'Simulated OTP. Auto-fills after 300 ms, then transitions to onboarding.',
    states: [
      { tag: 'auto-filling', note: 'Digits fill one-by-one at 100 ms/digit; transitions after 800 ms pause' },
    ],
    flows: [
      { from: 'Auto-fill complete', to: 'mode = signup-onboarding' },
      { from: 'Back',               to: 'mode = signup-email' },
    ],
    rules: [
      'Correct prototype code: 739251',
      'Auto-fill: starts 300 ms after render, 100 ms per digit, 800 ms hold before transition',
    ],
    edge: [
      'Native: send OTP via email; verify server-side; do NOT auto-fill',
      'Native: add retry limit + cooldown (e.g. 3 attempts, then 60 s lock)',
    ],
    storage: [],
  },

  'signup-onboarding': {
    screen: 'Signup — onboarding',
    sub: 'Two-step onboarding after account creation: Step 1 = profile details (name, country, API URL, avatar); Step 2 = bank connection (PSD2 demo).',
    states: [
      { tag: 'step 1 — profile',     note: 'First/last name, email (read-only), country picker, API URL, avatar' },
      { tag: 'step 2 — bank',        note: 'Connect one or more banks; each opens bank-search → credentials → consent → done sub-screens' },
      { tag: 'bank search',          note: 'Full-screen search with DUTCH_BANKS list + highlight; back returns to step 2' },
      { tag: 'bank credentials',     note: 'Demo username/password/IBAN pre-filled; PSD2 consent flow follows' },
      { tag: 'PSD2 consent',         note: 'Shows read permissions (account info + tx history); Authorise → connecting → done' },
      { tag: 'country picker',       note: 'Sheet with search; names shown in current app language (EN/NL/TR); matching text highlighted' },
    ],
    flows: [
      { from: 'Continue (step 1)',   to: 'Step 2 — bank connect' },
      { from: 'Complete (step 2)',   to: 'Login + redirect to home', cond: 'at least 1 bank connected' },
      { from: 'Skip (step 2)',       to: 'Login + redirect to home', cond: 'no banks; email signup only' },
      { from: 'Back (step 1)',       to: 'Previous login mode (signup / SSO)' },
      { from: 'Back (step 2)',       to: 'Step 1', cond: 'no banks; otherwise stays on step 2' },
      { from: 'Country ⓘ button',   to: 'Country info sheet (why munni uses country)' },
      { from: 'API ⓘ button',       to: 'API info sheet' },
    ],
    rules: [
      'Email field is read-only (lock icon) — passed in from previous step',
      'Country persisted to munni_profile_country_{method}_{email} key in localStorage',
      'Country names rendered in current app language via countryName(c, lang)',
      'Bank IBAN pre-generated with seededIban() for demo realism',
      'SSO (Google / Apple): skip bank step (complete immediately after step 1)',
    ],
    edge: [
      'popstate chain: step2 → step1 → previous mode; bank sub-screens also push states',
      'After completion, initPerUserData() must run BEFORE doLogin() to avoid schema overwrite',
    ],
    storage: [
      'munni_profile_firstname / _lastname / _country (LS, per-user key via computeUserDataKey)',
      'munni_api_url (LS)',
      'munni_bank_accounts (LS, per-user key)',
      'munni_user_picture_{method|email} (LS)',
    ],
  },

  'email-input': {
    screen: 'Login — email entry',
    sub: 'Standalone email-input step for returning email users.',
    states: [
      { tag: 'not found',  note: 'loginError set → red border; inline "Create account" CTA' },
    ],
    flows: [
      { from: 'Continue',          to: 'mode = email-verify', cond: 'email found in munni_signup_emails' },
      { from: 'Continue',          to: 'Error inline',        cond: 'email not found' },
      { from: '"Create account"',  to: 'mode = signup-email (email pre-filled)' },
      { from: 'Back',              to: 'mode = login' },
    ],
    rules: [
      'Same logic as the email input on the login screen — no format check, only lookup',
      'Email override active: entering NEW address resolves to old canonical key',
    ],
    edge: [
      '"Create account" inline CTA copies current input into signupEmailInput before switching mode',
    ],
    storage: [
      'munni_signup_emails (LS)',
      'munni_email_override (LS) — {from, to} checked before lookup',
    ],
  },

  'email-verify': {
    screen: 'Login — verify code',
    sub: 'OTP step for returning email users. Same animation as signup verify.',
    states: [
      { tag: 'auto-filling', note: 'Same timing as signup verify; different code' },
    ],
    flows: [
      { from: 'Auto-fill complete', to: 'Home (logged in)' },
      { from: 'Back',               to: 'mode = login' },
    ],
    rules: [
      'Correct prototype code: 427183 (different from signup code 739251)',
      'Same timing: 300 ms start, 100 ms/digit, 800 ms hold',
    ],
    edge: [
      'Native: each login attempt triggers a new OTP; invalidate previous codes server-side',
      'Native: rate-limit — max 5 requests per 10 min per email',
    ],
    storage: [],
  },

  'language': {
    screen: 'Language picker',
    sub: 'Accessible from login screen and Settings. Selecting a supported language takes effect immediately.',
    states: [
      { tag: 'search active',   note: 'Typing in the search box filters the "Other languages" list by name or BIC code' },
      { tag: 'lang selected',   note: 'Current language shows green checkmark; tapping another supported lang switches immediately' },
    ],
    flows: [
      { from: 'Supported lang row', to: 'Language switches; screen closes', cond: 'EN / NL / TR only' },
      { from: 'Coming-soon row',    to: 'No action — row is non-interactive' },
      { from: 'Back',               to: 'Previous screen (login or Settings)' },
    ],
    rules: [
      'Available languages: EN, NL, TR — each renders with flag image (Twemoji SVG)',
      'Selection persisted in LS key "munni_lang" (JSON string)',
      'Flag images get CSS counter-invert in dark mode to undo the root invert filter',
      'Search matches language name AND native name (case-insensitive)',
    ],
    edge: [
      'Switching language from this screen re-renders entire app immediately via LangProvider context',
      '"Coming soon" rows must never be tappable — no handler attached',
    ],
    storage: [
      'munni_lang (LS) — persists selected language code ("en" | "nl" | "tr")',
    ],
  },

  'terms': {
    screen: 'Terms of Service',
    sub: 'Static legal content. Same component as Privacy Policy (showPrivacy=false).',
    states: [],
    flows: [
      { from: 'Back', to: 'Login screen' },
    ],
    rules: [
      'Content is translated: EN / NL / TR sections all present in CONTENT map',
      '7 sections: Acceptance, Service description, Read-only access, User responsibilities, Data accuracy, Limitation of liability, Changes to terms',
      'Shared component with Privacy Policy — switched via showPrivacy prop',
    ],
    edge: [
      'Native: replace static content with server-fetched legal markdown; version-stamp shown to user',
    ],
    storage: [],
  },

  'privacy': {
    screen: 'Privacy Policy',
    sub: 'Static legal content. Same component as Terms of Service (showPrivacy=true).',
    states: [],
    flows: [
      { from: 'Back', to: 'Login screen' },
    ],
    rules: [
      'Content is translated: EN / NL / TR',
      '6 sections: Data we collect, How we use your data, Data storage, Your rights, Cookies, Contact',
      'Shared component with Terms of Service — switched via showPrivacy prop',
    ],
    edge: [
      'Native: GDPR requires a versioned privacy policy with explicit user acceptance; current prototype does not track consent version',
    ],
    storage: [],
  },

  'no-account': {
    screen: 'No account found',
    sub: 'Shown when user taps Google/Apple on login screen but has no account with that method.',
    states: [],
    flows: [
      { from: '"Create account"', to: 'mode = signup' },
      { from: 'Back',             to: 'mode = login' },
    ],
    rules: [
      'noAccountMethod state holds "google" or "apple" — used to show which method failed',
    ],
    edge: [
      'User may have registered with email but not with Google/Apple — guide them back to email login',
    ],
    storage: [],
  },

  // ── Tab screens ──────────────────────────────────────────────────────────

  'home': {
    screen: 'Home',
    sub: 'Main dashboard — balance overview, quick-add, and configurable home cards.',
    states: [
      { tag: 'no data',  note: 'Empty states shown per card when no transactions or banks connected' },
      { tag: 'scrolled', note: 'Balance tile collapses on scroll (CSS sticky behaviour)' },
    ],
    flows: [
      { from: 'Balance tile',    to: 'Accounts screen (stack)' },
      { from: 'Quick-add (+)',   to: 'Add transaction sheet' },
      { from: 'Card tap',        to: 'Varies by card type (Tx, Budgets, Goals…)' },
      { from: 'Customise icon',  to: 'customizeHome screen' },
    ],
    rules: [
      'Home cards order stored in LS key "munni_home_cards_{userId}"',
      'Balance shown is sum of all accounts on the active profile',
    ],
    storage: [
      'munni_home_cards_{userId} (LS) — ordered list of enabled card IDs',
    ],
  },

  'tx': {
    screen: 'Transactions',
    sub: 'Full transaction list with search, filter, and add-transaction.',
    states: [
      { tag: 'empty',   note: 'No transactions — "Connect a bank to see your transactions" prompt' },
      { tag: 'filtered',note: 'Active filter pill shown below search bar' },
    ],
    flows: [
      { from: 'Tx row',        to: 'txDetail screen (stack)' },
      { from: 'Search',        to: 'Filtered list inline' },
      { from: 'Filter btn',    to: 'Filter sheet' },
      { from: 'Add btn (+)',   to: 'Add transaction sheet' },
    ],
    storage: [
      'munni_tx_{userId} (LS) — array of transaction objects',
    ],
  },

  'recurring': {
    screen: 'Recurring',
    sub: 'Subscriptions and recurring expenses overview.',
    flows: [
      { from: 'Row tap',        to: 'recurringDetail screen (stack)' },
      { from: 'Add (+)',        to: 'recurringCreate screen (stack)' },
      { from: 'Deals tab',      to: 'recurringDeals screen (stack)' },
    ],
    storage: [
      'munni_recurring_{userId} (LS) — array of recurring items',
    ],
  },

  'events': {
    screen: 'Events',
    sub: 'Shared expense events — trips, dinners, group costs.',
    flows: [
      { from: 'Event row',  to: 'eventDetail screen (stack)' },
      { from: 'Add (+)',    to: 'eventCreate screen (stack)' },
    ],
    storage: [
      'munni_events_{userId} (LS) — array of event objects',
    ],
  },

  'insights': {
    screen: 'Insights',
    sub: 'Spending charts and financial analysis.',
    flows: [
      { from: 'Category bar',     to: 'categoryDrill screen (stack)' },
      { from: 'Custom graph btn', to: 'customGraphCreate screen (stack)' },
      { from: 'Period selector',  to: 'periods screen (stack)' },
    ],
  },

  'profile': {
    screen: 'Profile',
    sub: 'Profile switcher, accounts summary, and settings entry point.',
    flows: [
      { from: 'Identity card',  to: 'userInfo screen (stack)' },
      { from: 'Settings row',   to: 'settings screen (stack)' },
      { from: 'Members row',    to: 'Members sheet' },
      { from: 'Profile row',    to: 'profileDetail screen (stack)' },
      { from: 'Add profile',    to: 'profiles screen (stack)' },
      { from: 'Logout',         to: 'Login screen (app reset)' },
    ],
    storage: [
      'munni_profiles_{userId} (LS) — array of profile objects with active flag',
    ],
  },

  // ── Registry screens ─────────────────────────────────────────────────────

  'txDetail': {
    screen: 'Transaction detail',
    sub: 'Full detail sheet for a single transaction. Editable category, note, tags.',
    flows: [
      { from: 'Back',         to: 'Previous screen' },
      { from: 'Reimburse',    to: 'linkReimburse screen (stack)' },
      { from: 'Category row', to: 'Category picker sheet' },
    ],
    storage: [ 'munni_tx_{userId} (LS)' ],
  },

  'expenses': {
    screen: 'Expenses breakdown',
    sub: 'Spending by category for the selected period.',
    flows: [
      { from: 'Category row', to: 'categoryDrill screen (stack)' },
    ],
  },

  'categoryDrill': {
    screen: 'Category drill-down',
    sub: 'All transactions within a single category.',
    flows: [ { from: 'Tx row', to: 'txDetail screen (stack)' } ],
  },

  'linkReimburse': {
    screen: 'Link reimbursement',
    sub: 'Attach an incoming transaction as the reimbursement for an expense.',
    flows: [ { from: 'Tx row', to: 'Links and closes sheet' } ],
  },

  'search':  { screen: 'Search',  sub: 'Stub — full-text transaction search (not yet implemented).' },
  'sync':    { screen: 'Sync',    sub: 'Stub — manual sync trigger and last-sync status.' },

  'notifications': {
    screen: 'Notifications',
    sub: 'In-app notification centre — budget alerts, sync errors, tips.',
    storage: [ 'munni_notifications_{userId} (LS)' ],
  },

  'periods': {
    screen: 'Period selector',
    sub: 'Pick a custom date range or preset period for charts and summaries.',
    flows: [ { from: 'Period row', to: 'Closes and updates period context' } ],
  },

  'tutorial': {
    screen: 'Tutorial',
    sub: 'Onboarding walkthrough shown after first login or from Settings.',
  },

  'manageCategories': {
    screen: 'Manage categories',
    sub: 'Reorder, rename, or hide transaction categories.',
    storage: [ 'munni_categories_{userId} (LS)' ],
  },

  'budgets': {
    screen: 'Budgets',
    sub: 'Monthly budget list — progress bars, over/under indicators.',
    flows: [
      { from: 'Budget row',   to: 'budgetDetail screen (stack)' },
      { from: 'Add (+)',      to: 'budgetCreate screen (stack)' },
    ],
    storage: [ 'munni_budgets_{userId} (LS)' ],
  },

  'budgetDetail': {
    screen: 'Budget detail',
    sub: 'Single budget — spending history, edit/delete actions.',
    flows: [ { from: 'Back', to: 'budgets screen' } ],
    storage: [ 'munni_budgets_{userId} (LS)' ],
  },

  'budgetCreate': {
    screen: 'Budget create / edit',
    sub: 'Form to create or edit a budget: category, limit, period.',
    flows: [ { from: 'Save', to: 'budgets screen' } ],
    storage: [ 'munni_budgets_{userId} (LS)' ],
  },

  'goals': {
    screen: 'Goals',
    sub: 'Savings goals list — progress toward target amounts.',
    flows: [
      { from: 'Goal row',  to: 'goalDetail screen (stack)' },
      { from: 'Add (+)',   to: 'goalDetail screen in create mode' },
    ],
    storage: [ 'munni_goals_{userId} (LS)' ],
  },

  'goalDetail': {
    screen: 'Goal detail',
    sub: 'Single goal — contributions, timeline, edit/delete.',
    storage: [ 'munni_goals_{userId} (LS)' ],
  },

  'reviewSwipe': {
    screen: 'Review (swipe)',
    sub: 'Tinder-style transaction review — swipe to categorise uncategorised transactions.',
    flows: [
      { from: 'Swipe right', to: 'Accepts suggested category' },
      { from: 'Swipe left',  to: 'Opens category picker' },
    ],
    storage: [ 'munni_tx_{userId} (LS)' ],
  },

  'recurringDetail': {
    screen: 'Recurring detail',
    sub: 'Single recurring item — history, edit, cancel subscription.',
    storage: [ 'munni_recurring_{userId} (LS)' ],
  },

  'recurringCreate': {
    screen: 'Recurring create / edit',
    sub: 'Form to create or edit a recurring item.',
    storage: [ 'munni_recurring_{userId} (LS)' ],
  },

  'recurringDeals': {
    screen: 'Recurring deals',
    sub: 'Comparison of subscription prices with potential savings.',
  },

  'customizeHome': {
    screen: 'Customise home',
    sub: 'Drag-and-drop reorder and toggle visibility of home cards.',
    storage: [ 'munni_home_cards_{userId} (LS)' ],
  },

  'allocate': {
    screen: 'Allocate',
    sub: 'Assign income to topics/buckets. Zero-based budgeting.',
    flows: [
      { from: 'Topic row',  to: 'allocateTopic screen (stack)' },
      { from: 'Add topic',  to: 'allocateAddTopic screen (stack)' },
    ],
    storage: [ 'munni_allocate_{userId} (LS)' ],
  },

  'allocateTopic': {
    screen: 'Allocate topic',
    sub: 'Edit allocation amount for a single topic/bucket.',
    storage: [ 'munni_allocate_{userId} (LS)' ],
  },

  'allocateAddTopic': {
    screen: 'Add allocation topic',
    sub: 'Create a new allocation bucket.',
    storage: [ 'munni_allocate_{userId} (LS)' ],
  },

  'investment': {
    screen: 'Investments',
    sub: 'Portfolio overview — holdings, performance, allocation.',
    flows: [ { from: 'Connect btn', to: 'investmentConnect screen (stack)' } ],
    storage: [ 'munni_investments_{userId} (LS)' ],
  },

  'investmentConnect': {
    screen: 'Connect investment account',
    sub: 'Link a broker or investment platform via API key.',
  },

  'eventDetail': {
    screen: 'Event detail',
    sub: 'Single event — participants, expenses, settlement status.',
    flows: [
      { from: 'Add expense', to: 'Add expense sheet' },
      { from: 'Settle',      to: 'Settlement flow' },
    ],
    storage: [ 'munni_events_{userId} (LS)' ],
  },

  'eventCreate': {
    screen: 'Event create / edit',
    sub: 'Form to create or edit a shared expense event.',
    storage: [ 'munni_events_{userId} (LS)' ],
  },

  'accounts': {
    screen: 'Accounts',
    sub: 'Connected bank accounts — balances, add/remove.',
    flows: [
      { from: 'Account row',  to: 'Account detail sheet' },
      { from: 'Add bank',     to: 'Bank search → credentials flow' },
      { from: 'See all',      to: 'accountsAll screen (stack)' },
    ],
    storage: [
      'munni_bank_accounts_{userId} (LS) — array of connected bank account objects',
    ],
  },

  'accountsAll': {
    screen: 'All accounts',
    sub: 'Full list of all connected accounts across banks.',
    storage: [ 'munni_bank_accounts_{userId} (LS)' ],
  },

  'profiles': {
    screen: 'Profile manager',
    sub: 'Create and switch between multiple spending profiles (e.g. personal + business).',
    flows: [
      { from: 'Profile row',  to: 'profileDetail screen (stack)' },
      { from: 'Add profile',  to: 'Create profile sheet' },
    ],
    storage: [ 'munni_profiles_{userId} (LS)' ],
  },

  'profileDetail': {
    screen: 'Profile detail',
    sub: 'Edit profile name, colour, and member access.',
    storage: [ 'munni_profiles_{userId} (LS)' ],
  },

  'integrations': {
    screen: 'Integrations',
    sub: 'Third-party app connections — receipts, accounting exports.',
    flows: [
      { from: 'Integration row',  to: 'integrationLogin screen (stack)' },
      { from: 'Receipts row',     to: 'integrationReceipts screen (stack)' },
    ],
  },

  'integrationLogin': {
    screen: 'Integration login',
    sub: 'Authenticate with a third-party integration.',
  },

  'integrationReceipts': {
    screen: 'Integration receipts',
    sub: 'Browse and attach scanned receipts from an integration.',
  },

  'savings': {
    screen: 'Savings',
    sub: 'Savings overview — pots, targets, interest tracking.',
    flows: [
      { from: 'Saving row',     to: 'savingsDetail screen (stack)' },
      { from: 'Accounts btn',   to: 'savingAccounts screen (stack)' },
    ],
    storage: [ 'munni_savings_{userId} (LS)' ],
  },

  'savingsDetail': {
    screen: 'Savings detail',
    sub: 'Single savings pot — contributions, target, history.',
    storage: [ 'munni_savings_{userId} (LS)' ],
  },

  'savingAccounts': {
    screen: 'Saving accounts',
    sub: 'Savings-type accounts list (separate from checking accounts).',
    storage: [ 'munni_bank_accounts_{userId} (LS)' ],
  },

  'settings': {
    screen: 'Settings',
    sub: 'App-wide preferences — dark mode, language, notifications, app info.',
    flows: [
      { from: 'Language row',      to: 'language screen (stack)' },
      { from: 'Notifications row', to: 'notifications screen (stack)' },
      { from: 'Periods row',       to: 'periods screen (stack)' },
      { from: 'Tutorial row',      to: 'tutorial screen (stack)' },
      { from: 'Categories row',    to: 'manageCategories screen (stack)' },
    ],
    storage: [
      'munni_dark (LS) — "true" | "false" — dark mode toggle',
      'munni_lang (LS) — "en" | "nl" | "tr" — selected language',
    ],
  },

  'income': {
    screen: 'Income',
    sub: 'Income summary — salary, freelance, passive income categorisation.',
  },

  'invested': {
    screen: 'Invested',
    sub: 'Net invested amount — cost basis vs. current value.',
  },

  'debts': {
    screen: 'Debts',
    sub: 'Debt tracker — loans, credit cards, payoff timelines.',
    storage: [ 'munni_debts_{userId} (LS)' ],
  },

  'customGraphCreate': {
    screen: 'Custom graph creator',
    sub: 'Build a custom spending chart with user-selected metrics and date range.',
  },

  'friends': {
    screen: 'Friends',
    sub: 'Friend list — invite, search, manage connections for shared events.',
    storage: [
      'munni_global_friendships (LS) — shared friendship registry',
      'munni_global_invitations (LS) — pending invite objects',
    ],
  },

  'userInfo': {
    screen: 'My profile',
    sub: 'Edit personal info — name, photo, country, email, user ID.',
    states: [
      { tag: 'demo',    note: 'All edit fields disabled; no save button; shows "Demo account" label' },
      { tag: 'google',  note: 'Email locked (Google SSO); change-email option hidden' },
      { tag: 'apple',   note: 'Email locked (Apple SSO); change-email option hidden' },
      { tag: 'email',   note: 'Email is tappable → opens change-email sheet' },
    ],
    flows: [
      { from: 'Save',              to: 'Saves name + country; pops screen' },
      { from: 'Email row',         to: 'Change email sheet', cond: 'email login only' },
      { from: 'Photo btn',         to: 'Picture picker sheet' },
      { from: 'Delete account',    to: 'Delete feedback → confirm → logout' },
    ],
    rules: [
      'Country stored under munni_profile_country_{method}_{email} (LS)',
      'Name stored under munni_profile_firstname/lastname_{method}_{email} (LS)',
      'Photo stored under munni_user_picture_{method|email} (LS)',
    ],
    storage: [
      'munni_profile_firstname_{userId} (LS)',
      'munni_profile_lastname_{userId} (LS)',
      'munni_profile_country_{userId} (LS)',
      'munni_user_picture_{userId} (LS)',
    ],
  },

  'exportData': {
    screen: 'Export data',
    sub: 'Download transactions as CSV or JSON for a selected period.',
    flows: [
      { from: 'Export CSV',   to: 'Downloads transactions.csv' },
      { from: 'Export JSON',  to: 'Downloads transactions.json' },
    ],
    rules: [
      'Export includes all transactions for the active profile',
      'Date range picker affects export scope',
    ],
  },
};

// ---------------------------------------------------------------------------
// Panel UI
// ---------------------------------------------------------------------------
const Tag = ({ color, children }) => (
  <span style={{
    display: 'inline-block', padding: '1px 5px', borderRadius: 3,
    background: color + '28', color, fontSize: 9.5, fontWeight: 700,
    letterSpacing: 0.4, textTransform: 'uppercase', fontFamily: 'monospace',
  }}>{children}</span>
);

const SectionHead = ({ label, color }) => (
  <div style={{ display: 'flex', alignItems: 'center', gap: 5, margin: '10px 0 5px' }}>
    <div style={{ width: 3, height: 11, borderRadius: 2, background: color, flexShrink: 0 }}/>
    <span style={{ fontSize: 9, fontWeight: 800, letterSpacing: 0.9, color, textTransform: 'uppercase', fontFamily: 'monospace' }}>{label}</span>
  </div>
);

const Row = ({ children }) => (
  <div style={{
    fontSize: 10.5, color: '#cbd5e1', lineHeight: 1.55,
    padding: '3px 0', borderBottom: '1px solid rgba(255,255,255,0.05)',
  }}>{children}</div>
);

export function DevPanel({ screenKey }) {
  const active = useDevMode();
  const [open, setOpen] = React.useState(false);

  if (!active) return null;

  const ann = ANNOTATIONS[screenKey];

  return (
    <div style={{ position: 'absolute', bottom: 16, right: 8, zIndex: 9000, pointerEvents: 'none' }}>

      {/* Expanded panel */}
      {open && (
        <div style={{
          pointerEvents: 'auto',
          position: 'absolute', bottom: 30, right: 0,
          width: 272, maxHeight: 480,
          background: '#0c111d', borderRadius: 10,
          border: '1px solid rgba(255,255,255,0.12)',
          boxShadow: '0 8px 24px rgba(0,0,0,0.7)',
          display: 'flex', flexDirection: 'column',
          overflow: 'hidden',
        }}>
          {/* Header */}
          <div style={{ padding: '9px 11px 7px', borderBottom: '1px solid rgba(255,255,255,0.1)', flexShrink: 0 }}>
            <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between' }}>
              <span style={{ fontSize: 12, fontWeight: 700, color: '#f1f5f9', fontFamily: 'monospace' }}>
                {ann ? ann.screen : screenKey}
              </span>
              <Tag color="#64748b">{screenKey}</Tag>
            </div>
            {ann?.sub && (
              <div style={{ fontSize: 9.5, color: '#475569', lineHeight: 1.4, marginTop: 3 }}>{ann.sub}</div>
            )}
          </div>

          {/* Scrollable body */}
          <div style={{ overflowY: 'auto', padding: '2px 11px 12px' }}>
            {!ann ? (
              <div style={{ fontSize: 11, color: '#475569', padding: '12px 0' }}>
                No annotation for <code style={{ color: '#94a3b8' }}>{screenKey}</code>
              </div>
            ) : (
              <>
                {ann.states?.length > 0 && (
                  <>
                    <SectionHead label="States" color={C.state}/>
                    {ann.states.map((s, i) => (
                      <Row key={i}>
                        <Tag color={C.state}>{s.tag}</Tag>
                        <span style={{ color: '#94a3b8', marginLeft: 5 }}>{s.note}</span>
                      </Row>
                    ))}
                  </>
                )}

                {ann.flows?.length > 0 && (
                  <>
                    <SectionHead label="Flows" color={C.flow}/>
                    {ann.flows.map((f, i) => (
                      <Row key={i}>
                        <span style={{ color: '#f1f5f9' }}>{f.from}</span>
                        <span style={{ color: '#334155', margin: '0 3px' }}>→</span>
                        <span style={{ color: '#6ee7b7' }}>{f.to}</span>
                        {f.cond && <div style={{ fontSize: 9.5, color: '#334155', marginTop: 1 }}>if {f.cond}</div>}
                      </Row>
                    ))}
                  </>
                )}

                {ann.rules?.length > 0 && (
                  <>
                    <SectionHead label="Rules" color={C.rule}/>
                    {ann.rules.map((r, i) => (
                      <Row key={i}>
                        <span style={{ color: '#fbbf24', marginRight: 4 }}>•</span>
                        <span style={{ color: '#cbd5e1' }}>{r}</span>
                      </Row>
                    ))}
                  </>
                )}

                {ann.edge?.length > 0 && (
                  <>
                    <SectionHead label="Edge cases" color={C.edge}/>
                    {ann.edge.map((e, i) => (
                      <Row key={i}>
                        <span style={{ color: '#f87171', marginRight: 4 }}>!</span>
                        <span style={{ color: '#cbd5e1' }}>{e}</span>
                      </Row>
                    ))}
                  </>
                )}

                {ann.storage?.length > 0 && (
                  <>
                    <SectionHead label="Storage" color={C.storage}/>
                    {ann.storage.map((s, i) => (
                      <Row key={i}>
                        <span style={{ color: '#c4b5fd', fontFamily: 'monospace', fontSize: 10 }}>{s}</span>
                      </Row>
                    ))}
                  </>
                )}
              </>
            )}
          </div>
        </div>
      )}

      {/* Toggle pill — always visible when dev mode is on */}
      <button
        onClick={() => setOpen(o => !o)}
        style={{
          pointerEvents: 'auto',
          background: open ? '#1e293b' : '#2563eb',
          color: '#fff', border: `1px solid ${open ? 'rgba(255,255,255,0.15)' : 'transparent'}`,
          borderRadius: 20, padding: '4px 9px',
          fontSize: 9.5, fontWeight: 800, cursor: 'pointer',
          letterSpacing: 0.6, fontFamily: 'monospace',
          boxShadow: '0 2px 6px rgba(0,0,0,0.5)',
          display: 'flex', alignItems: 'center', gap: 4,
        }}
      >
        <span style={{
          width: 5, height: 5, borderRadius: '50%',
          background: open ? '#64748b' : '#4ade80',
          display: 'inline-block',
          boxShadow: open ? 'none' : '0 0 4px #4ade80',
        }}/>
        DEV
      </button>
    </div>
  );
}
