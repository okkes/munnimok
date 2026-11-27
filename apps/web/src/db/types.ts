import type { SyncEnvelope } from '@/sync/merge';

/** every synced row carries the SyncEnvelope and belongs to exactly one space; money is integer cents, never floats */

export type SpaceKind = 'personal' | 'shared';

export type SpacePeriodType = 'month' | 'week' | 'biweekly' | 'custom';
/** #370: the calendar's first weekday — a device preference every new space copies, each space may override */
export type WeekStart = 'monday' | 'sunday';
/** #541: the planner's money safe to spend may keep untouched besides the hard facts — four segments and the periods funded ahead */
export type SpendSetAside = 'goals' | 'events' | 'expenses' | 'budgets' | 'ahead';

export interface SpaceRow extends SyncEnvelope {
  id: string;
  name: string;
  kind: SpaceKind;
  currency: string; // ISO 4217, e.g. 'EUR'
  periodType: SpacePeriodType;
  periodDay: number; // day of month the budget period starts (month type)
  /** #370: set from the device preference at creation */
  weekStart?: WeekStart;
  /** creator's display name at creation: tells same-named shared spaces apart in lists */
  createdByName?: string;
  /** small client-downscaled data URL; wins over `icon` in lists */
  picture?: string;
  /** object-position percentages + scale; absent or null = the centre at 1x */
  pictureFocus?: { x: number; y: number; scale?: number } | null;
  icon?: string;
  color?: string;
  /** default start date (yyyy-mm-dd) for transaction history when accounts get attached */
  historyStartDate?: string;
  /** 1 = invites disabled until the owner unlocks; new spaces create locked, absent (older rows) reads unlocked */
  inviteLock?: 0 | 1;
  homeBlocks?: { id: string; hidden?: 0 | 1 }[];
  txDetailBlocks?: { id: string; hidden?: 0 | 1 }[];
  /** #577: phone bar features after Home, in order (navFeatures ids; an unknown one is skipped); absent/null = default bar */
  navTabs?: string[] | null;
  /** main categories switched off for this space (picker filtering only — data never blocks) */
  hiddenMains?: string[];
  // #390 r4: copy offers from other spaces this space declined: per main (`main:<name>` it lacks, `into:<id>` that would
  // gain subs) the sub names then on offer; an offer returns when it brings a name not among them
  copyDeclined?: Record<string, string[]>;
  /** what the big number is; absent = 'networth' (every account summed) */
  balanceBandMode?: 'networth' | 'cash' | 'spendable' | 'custom';
  balanceBandAccounts?: string[];
  /** #368: the savings accounts that feed the goals; absent = every savings account */
  goalPoolAccountIds?: string[];
  /** #128: the accounts whose balances make the planning pool; absent = every checking and cash account */
  planPoolAccountIds?: string[];
  /** #541: the accounts safe to spend sums; absent or null = every checking
   *  and cash account (null, not undefined, clears it — JSON drops an
   *  undefined field on the way to the server) */
  spendAccountIds?: string[] | null;
  /** #541: the plan's set-asides safe to spend takes off as well; absent = none */
  spendSetAsides?: SpendSetAside[];
  // custom trend graphs: a name + the (sub)categories charted (a main covers its subs); one LWW field on the space row;
  // #531: `accountIds` narrows a graph to those accounts, absent = every account (later ones too)
  trendGraphs?: { id: string; name: string; catIds: string[]; accountIds?: string[]; /** #455: what goals bought stays out */ skipGoalSpending?: boolean }[];
  /** #531: the Cash flow tab's graphs: a balance line over the named accounts; an LWW list like trendGraphs */
  cashflowGraphs?: { id: string; name: string; accountIds: string[] }[];
  /** #690: the Recurring tab's graphs: the year chart over the recurring costs a graph leaves in — an absent `kinds` reads
   *  fixed costs and subscriptions alike, an absent `luxury` both, an absent `catIds` every main category (later ones too;
   *  '' is a cost without one); an LWW list like trendGraphs */
  recurringGraphs?: { id: string; name: string; kinds?: RecurringKind[]; luxury?: 'only' | 'without'; catIds?: string[] }[];
}

export type AccountType = 'checking' | 'savings' | 'cash' | 'brokerage' | 'credit' | 'mortgage' | 'loan' | 'funding';
/** 'connector' = fetched through the connector platform (#367, #414), open banking included; `provider` names the party */
export type AccountSource = 'manual' | 'camt053' | 'connector';

export interface AccountRow extends SyncEnvelope {
  id: string;
  spaceId: string;
  /** #536: what the party that feeds the account calls it (a savings account, a card, a loan), stamped by the server on
   *  every fetch — a space attaches the account as this type and no other; absent = the space decides */
  partyType?: AccountType;
  name: string;
  type: AccountType;
  source: AccountSource;
  currency: string;
  balanceCents: number;
  /** date balanceCents was known true (yyyy-mm-dd): statements and manual edits stamp it; only a newer date overwrites */
  balanceAsOf?: string;
  /** when this account last heard from its source (ISO; bank fetch or statement import) */
  lastSyncedAt?: string;
  // #367: the connector party behind a 'connector' source (catalogue provider id), stamped by server ingest on every
  // fetched row; none on manual/import rows
  provider?: string;
  // #445: the connection that fetched the row last (relay connection id / hub `storeConn` row id), stamped by ingest;
  // when it is gone nothing fetches the row any more and the app says so
  connectionId?: string;
  // #133/#221: the space's DEFAULT account for a counterparty family, minted at space creation (undeletable, system-managed)
  // so "Set aside" or an ATM withdrawal without naming an account lands somewhere valid
  defaultFor?: 'saving' | 'debtPayment' | 'investment' | 'transfer' | 'cash' | 'funding';
  /** newest transaction date an imported statement covered (yyyy-mm-dd): not the same as when it was imported */
  dataThroughDate?: string;
  // #240 r3: raw rows the last bank fetch returned / could not store (no reference/date);
  // 0 received = the bank returned nothing
  lastFetchReceived?: number;
  lastFetchDropped?: number;
  iban?: string;
  /** #367: the party's own masking of a card or wallet number, written for an account with no IBAN */
  maskedNumber?: string;
  bankId?: string;
  color?: string;
  /** user-chosen icon: '/brands/{slug}.svg' or a logo.dev URL; wins over the logo derived from bankId */
  logo?: string;
  archived?: 0 | 1;
  /** informational APR, e.g. 3.5 — empty means "remind me", 0 is an answer */
  interestPctYear?: number;
  /** starting size of the loan; powers the progress bar */
  originalCents?: number;
  note?: string;
  paymentCents?: number;
  /** payment cadence, recurring-shaped; absent = monthly, estimates from payments fill the gap */
  paymentEvery?: RecurringEvery;
  paymentEveryN?: number;
  /** #190: due day of month 1..31, says which period a payment belongs to; weekly cadences carry none */
  paymentDay?: number;
  merchantKey?: string;
  // debts-screen membership: absent = by type (loan/mortgage in, credit out unless it carries a debt story);
  // the explicit toggle wins
  trackAsDebt?: 0 | 1;
  /** #413: how much this debt weighs on the person (1 light … 5 heavy) — the payoff planner's tsunami order pays the heaviest first */
  debtStress?: 1 | 2 | 3 | 4 | 5;
}

export type TxType = 'income' | 'expense' | 'saving' | 'transfer' | 'debtPayment' | 'investment' | 'funding' | 'adjustment';

export type CatDirection = 'debit' | 'credit' | 'both';

// a custom category: mains carry the transaction type + color, subs inherit both and carry only a direction;
// rows live in the space they were created in
export interface CategoryRow extends SyncEnvelope {
  id: string;
  spaceId: string;
  parentId?: string;
  nameKey?: string;
  name?: string;
  icon: string; // MDI icon name
  color: string;
  /** authoritative on parents; derived from the parent for subs */
  txType: TxType;
  /** subs only; parents have no direction */
  direction?: CatDirection;
  isParent?: 0 | 1;
  /** the auto-created "Other" sub of a custom main (direction locked to 'both') */
  isOther?: 0 | 1;
  sortOrder: number;
  builtin: 0 | 1;
}

export interface TxSplit {
  catId: string;
  /** positive magnitude; the parent row's sign gives the direction */
  amountCents: number;
  /** percentage split (0–100): scales to any amount, so bulk apply
   *  works across different charges; amountCents stays materialized */
  pct?: number;
  // typed splits: every field below is optional; a bare slice behaves as the classic category slice
  id?: string;
  /** stored ONLY when the user edits it; the default
   *  "<title> – split N" is rendered, localized, at read time */
  label?: string;
  /** the part's own type; absent = inherits the row's type */
  txType?: TxType;
  linkedAccountId?: string;
  transferPeerId?: string;
  eventId?: string;
  recurringId?: string;
  // per-part category partition: magnitudes sum to the part's amountCents; catId stays the largest entry
  // as the compat shadow; absent = single cat
  cats?: TxSplitCat[];
  notes?: string;
}

export interface TxSplitCat {
  catId: string;
  /** positive magnitude, same sign convention as the part */
  amountCents: number;
  // percentage entry (0-100), row-level spreads only (#211): kept so the #141 sibling offer can rescale;
  // amountCents stays materialized
  pct?: number;
  // #228: entries carry NO counterparty: a special category claims the whole (split) transaction,
  // so a spread holds only regular and reimbursement categories
  // view enrichment only: the join derives it from the entry's category + the owner's counterparty;
  // a stored value is never read
  txType?: TxType;
}

/** money received back against an expense (owned by the expense side) */
export interface TxReimbursement {
  txId: string;
  amountCents: number;
  /** which PART of a split expense it pays back (#126 r5) — absent =
   *  the whole transaction; container math is unchanged either way */
  partId?: string;
  /** #197: which PART of a split CREDIT funds it — absent = the whole
   *  credit; whole-credit math is unchanged either way */
  creditPartId?: string;
}

export interface TransactionRow extends SyncEnvelope {
  id: string;
  spaceId: string;
  accountId: string;
  date: string; // ISO yyyy-mm-dd (sortable)
  time?: string; // HH:mm
  amountCents: number; // negative = money out
  currency: string;
  merchant: string;
  /** user-chosen display title; the bank's merchant stays untouched */
  titleOverride?: string;
  description?: string;
  catId?: string;
  // #211: the ROW's own multi-category partition (still ONE transaction): magnitudes sum to |amountCents|, catId stays the
  // largest entry as the compat shadow; never mixed with `splits` (a container's parts carry no cats of their own)
  cats?: TxSplitCat[];
  splits?: TxSplit[];
  needsReview: 0 | 1;
  notes?: string;
  counterIban?: string;
  /** bank-reported reserved charge, not yet booked — replaced by its booked twin */
  pending?: 0 | 1;
  /** #565: munni filled parts of the row's own opinion when it landed (see TxMetaRow.autoFill) */
  autoFill?: string;
  /** deterministic id source for imported rows (bank tx id / CAMT entry ref) */
  importRef?: string;
  // which upload created this row: rollback removes a batch's rows and ONLY its rows (deduped rows keep their first batch)
  importBatchId?: string;
  /** uploader's display name, frozen at import */
  importedBy?: string;
  reimbursements?: TxReimbursement[];
  /** counter-account for transfers/savings/debt payments — locks txType */
  linkedAccountId?: string;
  // the other leg of a transfer pair, written on both legs by the matcher or a manual link;
  // the list collapses a visible pair into one row
  transferPeerId?: string;
  recurringId?: string;
  eventId?: string;
  /** #538: the split the payment was added to — a mark for everyone in the space, so the same payment is not
   *  added twice; the split's members never learn which space it came from */
  splitRef?: SplitRef | null;
  /** pre-anchor row deliberately counted into the linked manual loan's balance (one-shot marker) */
  loanCounted?: 1;
  /** #133 D: the manual correction marker (manual rows only); the view derives the adjustment type, none is stored */
  adjustment?: 0 | 1;
  /** #547: when this row was typed by hand on an account the bank or a
   *  statement fills (ISO) — what makes it "your entry"; absent on every other row */
  enteredAt?: string;
  /** #547: your entry counts on top of the bank's balance, in this space only (the form's tick) */
  inBalance?: 0 | 1;
  /** #547: the bank's own transaction this entry is linked to — the two read
   *  as one and the entry stays behind it; null once they are taken apart */
  bankTxId?: string | null;
  /** #547: what the bank's row held before the link — put back when the two are taken apart */
  bankBefore?: EntryBankBefore | null;
  /** #547: bank rows this entry was taken apart from: never linked to it again without asking */
  noBankTxIds?: string[];
}

/** #547: a bank row's opinions as they were before an entry was linked to it */
export type EntryBankBefore = Partial<
  Pick<TransactionRow, 'catId' | 'cats' | 'splits' | 'notes' | 'titleOverride' | 'eventId' | 'recurringId' | 'linkedAccountId' | 'reimbursements' | 'transferPeerId'>
> & { needsReview?: 0 | 1 };

// a transaction as the VIEW sees it: the stored row + the type derived at the join (db/joined.ts, domain/txDerive.ts);
// nothing stores a type
export type TxView = TransactionRow & { txType: TxType };

// per-space transformation overlay for one raw transaction (raw bank data lives once in the feed space);
// id uuidv5("meta:" + spaceId + ":" + txId), so concurrent creation by two members converges via LWW
export interface TxMetaRow extends SyncEnvelope {
  id: string;
  /** the viewing space that owns these opinions */
  spaceId: string;
  /** raw transaction id inside the feed space */
  txId: string;
  catId?: string;
  needsReview: 0 | 1;
  notes?: string;
  titleOverride?: string;
  cats?: TxSplitCat[];
  splits?: TxSplit[];
  reimbursements?: TxReimbursement[];
  linkedAccountId?: string;
  transferPeerId?: string;
  recurringId?: string;
  eventId?: string;
  splitRef?: SplitRef | null;
  /** this row predates the loan's known-true balance date but the user chose to count it in (one-shot) */
  loanCounted?: 1;
  /** #565: munni filled parts of this opinion when the row landed — which parts, and a fingerprint of the opinion right
   *  after (domain/autoFill). It only means something while the fingerprint still fits */
  autoFill?: string;
}

export type RecurringKind = 'fixed' | 'subscription';
export type RecurringEvery = 'week' | 'month' | 'year';

// one recurring cost of a space; the amount is the user's estimate until linked transactions rectify it;
// merchantKey lets imports auto-link
export interface RecurringRow extends SyncEnvelope {
  id: string;
  spaceId: string;
  name: string;
  kind: RecurringKind;
  /** could be cancelled anytime without real impact (insight label) */
  luxury?: 0 | 1;
  /** estimated cost per occurrence, positive minor units */
  amountCents: number;
  catId?: string;
  icon?: string;
  /** brand logo: '/brands/{slug}.svg' (vendored, offline) or a logo.dev URL — wins over `icon` */
  logo?: string;
  every: RecurringEvery;
  /** cadence multiplier: every N weeks/months/years (default 1); N>1 and
   *  weekly cadences anchor on `since` */
  everyN?: number;
  /** due day of month 1..31 (clamped to shorter months) */
  dueDay: number;
  /** yearly costs: due month 1..12 */
  dueMonth?: number;
  since?: string;
  until?: string;
  active: 0 | 1;
  /** remind n days before due; absent/0 = no reminder */
  notifyDaysBefore?: number;
  merchantKey?: string;
  /** #274: counterparty account for special categories; linked transactions inherit it */
  linkedAccountId?: string;
}

/** a rejected recurring suggestion: never suggested again; synced, so a partner's dismissal counts for the space */
export interface RecurringDismissRow extends SyncEnvelope {
  id: string;
  spaceId: string;
  merchantKey: string;
}

// #148 r3: a transaction a signed-in user FIRST saw, synced through their private state space so the 24h "new" clock
// agrees across devices; `spaceId` is the state space, `forSpaceId` where the tx lives; rows older than the per-space
// baseline row (id from `txSeenBaseId`) are known without a row
export interface TxSeenRow extends SyncEnvelope {
  id: string;
  spaceId: string;
  forSpaceId: string;
  txId?: string;
  /** ms — when the badge clock started (0 on the baseline row) */
  labeledAt: number;
  baseline?: 0 | 1;
}

/** #369: 'period' resets together with the space's own budget period */
export type BudgetEvery = 'week' | '2weeks' | 'month' | 'period';
export type BudgetCarryMode = 'periods' | 'cap';

// a space-scoped spending limit on its own anchored cadence; carry-over is replayed from transactions, never stored,
// so devices converge
export interface BudgetRow extends SyncEnvelope {
  id: string;
  spaceId: string;
  name: string;
  // MDI icon; #534: a budget wears an icon only, the own pictures of #373 are no longer read or written
  // (rows that carry one keep it)
  icon?: string;
  /** the limit per period, positive minor units */
  amountCents: number;
  every: BudgetEvery;
  /** yyyy-mm-dd the budget starts on: its first period opens here (and may be partial) */
  anchor: string;
  /** #371: monthly budgets reset on this day of the month (1-28); absent or null = the start date's day */
  resetDay?: number | null;
  /** main and/or sub category ids; exclusive across a space's budgets */
  catIds: string[];
  carryOver?: 0 | 1;
  carryMode?: BudgetCarryMode | null;
  /** carry unused money at most N periods forward (carryMode 'periods') */
  carryPeriods?: number | null;
  /** or pile up to this much ON TOP of the amount (carryMode 'cap') — the form shows amount + this, the most a period may hold (#534) */
  carryCapCents?: number | null;
  /** warn when spending crosses this percentage; absent or null = quiet */
  notifyAtPct?: number | null;
  active: 0 | 1;
}

/** groups transactions around a real-world happening to answer what it truly cost; archiving is manual */
export interface EventRow extends SyncEnvelope {
  id: string;
  spaceId: string;
  name: string;
  icon?: string;
  /** bundled asset path ('/events/beach.jpg') or a downscaled data URL */
  picture?: string;
  /** #446: where a cover-fitted frame crops an UPLOADED picture - CSS
   *  object-position percentages (0..100 each); absent or null = the centre */
  pictureFocus?: { x: number; y: number } | null;
  note?: string;
  color?: string;
  from?: string;
  to?: string;
  budgetCents?: number;
  archived?: 0 | 1;
  /** #538: the split this event belongs to — the event's own fact, so whoever shares the space shares the bond;
   *  several events may name one split */
  splitId?: string | null;
  /** #538: payments the person said to ignore when munni compares the event with its split */
  splitSkips?: string[];
}

// a goal partitions the space's savings balance into named envelopes: no money moves, no transactions link;
// over-allocation is flagged, never auto-fixed
export interface GoalRow extends SyncEnvelope {
  id: string;
  spaceId: string;
  name: string;
  icon?: string;
  color?: string;
  /** cover image like events: bundled path or uploaded data url; null once taken off */
  picture?: string | null;
  targetCents: number;
  /** null once the deadline is taken off */
  targetDate?: string | null;
  /** running total, maintained by contributions */
  allocatedCents: number;
  archived?: 0 | 1;
  /** #455: the goal was spent — set together with archived = 1, null again
   *  on an undo; absent (every goal from before) = never cashed out */
  cashOut?: GoalCashOut | null;
}

// #455: what spent a goal: the transactions stay ordinary rows; the overview keeps them (and their pair's other leg)
// out of the period's saving and shows them as cashed out
export interface GoalCashOut {
  date: string;
  /** the rows that took the goal's money out of savings */
  txIds: string[];
  /** what that money bought: real spending, which the plan files under the goal and a graph can leave out; absent = not named */
  purchaseTxIds?: string[];
}

/** audit trail of goal funding — separate rows converge without LWW fights */
export interface GoalContributionRow extends SyncEnvelope {
  id: string;
  spaceId: string;
  goalId: string;
  /** + fund / − withdraw (back to unallocated) */
  amountCents: number;
  date: string;
  note?: string;
}


export interface ReceiptItem {
  name: string;
  qty?: number;
  unitCents?: number;
  totalCents: number;
  /** a line that is not a product (the connector says which) — absent = product */
  kind?: 'fee' | 'deposit' | 'discount' | 'adjustment' | 'unattributed';
  /** #567: the category the reader suggests for the line — a suggestion, the transaction's own split is the truth */
  catId?: string;
  /** #567: what came off this very line (negative), as the shop states it — `totalCents` is the line before it */
  discountCents?: number;
  discountLabel?: string;
}

/** #538: the split a payment was added to, by the name it had then */
export interface SplitRef {
  splitId: string;
  name: string;
}

export interface ReceiptPick {
  line: number;
  catId: string;
  /** what of the transaction the line stands for: its printed value, what was paid after the discount, or a typed amount */
  amountCents: number;
}

/** a document the party issued for the purchase (mostly an invoice, `include=invoice`); what it holds is a receiptFile */
export interface ReceiptDocument {
  kind: 'invoice';
  mime: string;
  name?: string;
  filename?: string;
  sizeBytes?: number;
  fileId: string;
}

// #630: an invoice or a photo, kept apart from the receipt (or link) it belongs to — receipts are read by the hundred
// on every pass, what they hold only when one is opened; synced like any row, so it is there offline on every device
export interface ReceiptFileRow extends SyncEnvelope {
  id: string;
  spaceId: string;
  /** the receipt or the receiptLink this belongs to */
  ownerId: string;
  dataUrl: string;
}

export interface ReceiptPayment {
  /** provider wording, e.g. 'PIN', 'ideal' */
  method?: string;
  /** last digits of the paying IBAN/PAN — constrains tx matching */
  accountTail?: string;
}

// #648: a receipt lives ONCE — a fetched one in its connection's feed, a scan in its owner's scans feed, a photo taken
// on a payment in that payment's space. A space that includes a feed reads it; what the space decides about a receipt
// (which payment, which lines) is its `receiptLink`. Only the receipt's owner writes it
export interface ReceiptRow extends SyncEnvelope {
  id: string;
  /** the feed it lives in, or the space that made it */
  spaceId: string;
  /** 'photo' for the camera, else the connector provider id that fetched
   *  it (`ah`, `jumbo`, `amazon-nl`, `mock-store-simple` …) — the
   *  catalogue is the only list; the client never enumerates parties */
  source: string;
  date: string;
  totalCents: number;
  /** the party's currency (ISO); absent on photo receipts = the space's */
  currency?: string;
  merchant?: string;
  items?: ReceiptItem[];
  /** the photo (photo path): a receiptFile holding the downscaled picture */
  imageId?: string;
  /** `{provider}:{externalId}` — cross-source dedupe key */
  storeRef?: string;
  /** the connection that pulled it — every connector receipt is keyed by it */
  instanceId?: string;
  payment?: ReceiptPayment;
  documents?: ReceiptDocument[];
  /** false when the party says the line items do not add up to the total */
  reconciled?: boolean;
  /** #648: the category a reader suggested per line NAME of a fetched receipt ('' = asked, none fits), kept apart
   *  from `items` because the shop's next fetch rewrites those; its owner's to write like the rest of the receipt */
  itemCats?: Record<string, string>;
}

export type ConnectorSessionState =
  | 'queued'
  | 'running'
  | 'awaiting_input'
  | 'active'
  | 'needs_reauth'
  | 'blocked'
  | 'disabled'
  | 'failed'
  | 'expired';

export interface ConnectorLastError {
  code: string;
  messageKey: string;
  userAction: string;
  retryAfterSeconds?: number;
  /** ISO: when the relay said so — with retryAfterSeconds, the moment a pause is over */
  at?: string;
  /** #441 L1: the failed job whose last picture waits on the person's word; cleared by their answer */
  artifactsJobId?: string;
}

/**
 * A fetch the relay accepted and this device has not collected yet
 * (prod 2026-10-06: a phone that kept reopening the app started a fresh
 * half-hour Amazon fetch each time and never collected the first). The
 * next sync follows and collects THIS job before asking for anything new.
 */
export interface ConnectorPendingJob {
  jobId: string;
  /** the window the job was asked for; the collect repeats it */
  since?: string;
  /** #460: set when the job is a pass over older history */
  until?: string;
  startedAt: string;
}

/** #460: older history a partial pass left behind — the next pass asks from `since` (absent: the party's own floor) up to `until` */
export interface ConnectorBackfill {
  since?: string;
  until: string;
}

// DEVICE-ONLY connection state (#367): never synced in plaintext, never exported, never on our server; the E2EE
// connection sync ferries it as ciphertext between the owner's devices. On the web the bundle lives in sessionStorage
// (custody 'ephemeral'), so the row carries none
export interface ConnectorConnRow {
  id: string;
  provider: string;
  /** `sb_v1.…` — native custody only */
  bundle?: string;
  /** a provider-kept credential store (Jumbo), replayed on re-login */
  credentialBundle?: string;
  sessionId?: string;
  state: ConnectorSessionState;
  /** when the bundle last changed hands (login or rotation) — the E2EE
   *  sync adopts the fresher copy */
  refreshedAt: string;
  lastSyncAt?: string;
  lastError?: ConnectorLastError;
  pendingJob?: ConnectorPendingJob;
  /** #460: older history still to fetch; absent when there is none (every row from before) */
  backfill?: ConnectorBackfill;
  /** #441 L1: always report this connection's failures to the people who run munni, without asking */
  reportFailures?: boolean;
}

// SYNCED, secret-free connection metadata in the owner's store feed:
// every device renders the connection before the E2EE bundle arrives
export interface StoreConnRow extends SyncEnvelope {
  id: string;
  spaceId: string; // the owner's store feed
  store: string;
  /** the party's kind, frozen at connect time so the hub sections render
   *  offline; absent on rows written before banks joined (= a shop) */
  kind?: 'store' | 'bank' | 'registry';
  displayName: string;
  icon?: string;
  providerAccountHash?: string;
  connectedAt: string;
  /** 'expired' = a sign-in is needed (mirrored from the device row) */
  status?: 'ok' | 'expired';
}

// per-space inclusion of a receipt feed (accountLink analogue): a connection's, or a person's own scans. The server
// lets the space's members read the feed; this row is what they render it by (they cannot read the owner's connections)
export interface StoreConnLinkRow extends SyncEnvelope {
  id: string; // `sclink:{spaceId}:{instanceId}`
  spaceId: string;
  /** the connection's id; for a person's scans the scans feed's own id */
  instanceId: string;
  /** the party, or 'photo' for a person's scans */
  store: string;
  displayName: string;
  icon?: string;
  addedByName?: string;
  /** #648: the feed the space reads; absent on a row written before feeds were shared (the start-up pass fills it) */
  feedSpaceId?: string;
}

// #648: what a space decided about a receipt (txMeta analogue) — which payment it proves, which lines were picked. It
// names the receipt and holds nothing of it: the receipt is read where it lives, and is gone from the space with it
export interface ReceiptLinkRow extends SyncEnvelope {
  id: string; // receiptLinkId(spaceId, receiptId)
  spaceId: string;
  receiptId: string;
  /** where the receipt lives: a feed the space reads, or the space itself */
  feedSpaceId: string;
  /** absent = the receipt is in the space but on no payment (it only remembers who turned it down) */
  txId?: string;
  /** the other transactions this receipt proves (user 2026-10-08: several payments, one receipt); `txId` stays
   *  the first attachment so every existing reader keeps working; absent = attached to txId alone */
  alsoTxIds?: string[];
  picks?: Record<string, ReceiptPick[]>;
  /** 1 = the matcher linked it, 0/absent = a human did */
  auto?: 0 | 1;
  /** #367: the matcher's best candidate was already reviewed, so it asks
   *  instead of attaching — "Matches to check" lists these until a human
   *  accepts (txId) or rejects (rejectedTxIds) */
  proposedTxId?: string;
  /** transactions a human said this receipt is NOT for — never proposed again */
  rejectedTxIds?: string[];
}

/** a link read together with the receipt it names: what every screen draws */
export interface LinkedReceipt
  extends ReceiptLinkRow,
    Pick<ReceiptRow, 'source' | 'instanceId' | 'date' | 'totalCents' | 'merchant' | 'items' | 'reconciled' | 'currency' | 'imageId' | 'payment' | 'documents'> {
  receipt: ReceiptRow;
}

export type AssetClass = 'stock' | 'etf' | 'crypto' | 'cash' | 'other';
export type PriceSource = 'yahoo' | 'coingecko' | 'manual';

export interface HoldingRow extends SyncEnvelope {
  id: string;
  spaceId: string;
  accountId?: string;
  name: string;
  symbol?: string;
  isin?: string;
  assetClass: AssetClass;
  currency: string;
  priceSource?: PriceSource;
  /** yahoo ticker or coingecko coin id, depending on priceSource */
  priceKey?: string;
  manualPriceCents?: number;
  archived?: 0 | 1;
}

export interface LotRow extends SyncEnvelope {
  id: string;
  spaceId: string;
  holdingId: string;
  kind: 'buy' | 'sell' | 'dividend' | 'fee';
  date: string;
  quantity?: number;
  priceCents?: number;
  /** signed total in cents: buys negative cash, sells/dividends positive */
  totalCents: number;
}

// SYNCED insight dismissal: dismissed once, dismissed for every member;
// the insight id encodes its subject, so a changed situation resurfaces
export interface InsightDismissRow extends SyncEnvelope {
  id: string;
  spaceId: string;
  insightId: string;
}

export type PlanSegmentKind = 'recurring' | 'debts' | 'expenses' | 'budgets' | 'events' | 'goals';

/**
 * #494: money given to an Unplanned row for this period only — it never
 * becomes a subject, so no copy (the next period, a blueprint, the periods
 * ahead) ever carries it. `key` names the row: `category:<mainId>`,
 * `recurring:<id>`, `debt:<id>`, `goal:<id>` or `event:<id>`.
 */
export interface PlanOneOff {
  key: string;
  fundedCents: number;
}

export type PlanKind = 'actual' | 'sandbox' | 'blueprint';

export interface PlanSegmentConfig {
  kind: PlanSegmentKind;
  hidden?: 0 | 1;
}

// a plan (#128): the actual plan of one period, its sandbox (same period, own subjects and funding) or a blueprint
// (no period, no funding); actual and sandbox ids are deterministic (`plan:{space}:{kind}:{periodStart}`):
// two devices starting a period converge
export interface PlanRow extends SyncEnvelope {
  id: string;
  spaceId: string;
  kind: PlanKind;
  periodStart?: string;
  name?: string;
  /** segment order and visibility; absent = the default order, every segment shown */
  segments?: PlanSegmentConfig[];
  savedAt?: string;
  /** #494: the Unplanned rows this period funds without planning them (actual and sandbox plans only) */
  oneOffs?: PlanOneOff[];
  /** #692: started by hand on its own period (the first plan, or after Start over): nothing set aside in earlier
   *  periods rolls into it — only a plan a new period carried over by itself keeps that money */
  fresh?: 0 | 1;
}

// one subject of a plan (#128): an expense subject is the person's own (a main claims its subs, later ones too,
// minus the excluded); other segments mirror one source row (`sourceId`) and die with it
export interface PlanSubjectRow extends SyncEnvelope {
  id: string;
  spaceId: string;
  planId: string;
  segment: PlanSegmentKind;
  order: number;
  name: string;
  icon?: string;
  color?: string;
  catIds?: string[];
  excludeCatIds?: string[];
  /** expenses: what the person wants to set aside this period (0 = unknown yet);
   *  events (#504): the person's own total for the event — absent = its estimate */
  targetCents?: number;
  sourceId?: string;
  fundedCents: number;
  /** recurring, debts, goals: not due this period — green without funding */
  snoozed?: 0 | 1;
  /** #692: how money that leaves in a later period is set aside meanwhile — absent = spread what is left; the plan's
   *  own choice, copied with the subject into the next period, a blueprint or the sandbox */
  pace?: 'catchUp';
}

export interface QuoteCacheRow {
  key: string;
  price: number;
  currency: string;
  dayChangePct?: number;
  at: string;
}

// attachment of an account's feed space to a viewing space; lives in the viewing space so members render it offline;
// the server keeps the authoritative copy for feed access control
export interface AccountLinkRow extends SyncEnvelope {
  id: string;
  spaceId: string;
  feedSpaceId: string;
  accountId: string;
  attachedBy?: string;
  attachedByName?: string;
  /** transactions before this date stay hidden in this space */
  historyFrom?: string;
  /** #152: the SPACE-LEVEL account type — the attachment's opinion; a
   *  global account has no type of its own anymore, each space decides
   *  at attach time (absent on old links = the account row's value) */
  type?: AccountType;
  /** #239: the SPACE-LEVEL display name — this space's own name for the
   *  account; absent = the global account name shows */
  displayName?: string;
  /** owner left the space: history stays, no new data flows */
  archived?: 0 | 1;
}

export interface OutboxRow {
  opId: string;
  spaceId: string;
  entity: EntityName;
  entityId: string;
  fields: Record<string, unknown>;
  hlc: string;
  deleted?: boolean;
}

export interface MetaRow {
  key: string;
  value: unknown;
}

/** one line of "who did what" — capped at the newest 200 per space */
export interface ActivityRow extends SyncEnvelope {
  id: string;
  spaceId: string;
  /** what happened (translated client-side): review | note | txAdd | attach | detach | budgetAdd | accountAdd */
  kind: string;
  /** display name frozen at write time so offline devices can render it */
  actorName?: string;
  /** OIDC sub of the actor (user identities) — lets devices render "You" */
  actorSub?: string;
  detail?: string;
  /** #618: a second name — where moved money came from */
  detail2?: string;
  /** #618: the figures a line names, in the space's minor units: the reader's device formats them in its own language */
  amountCents?: number;
  fromCents?: number;
  at: string;
}

export type EntityName =
  | 'space'
  | 'account'
  | 'category'
  | 'transaction'
  | 'txMeta'
  | 'accountLink'
  | 'recurring'
  | 'recurringDismiss'
  | 'txSeen'
  | 'budget'
  | 'event'
  | 'goal'
  | 'goalContribution'
  | 'receipt'
  | 'receiptLink'
  | 'receiptFile'
  | 'storeConn'
  | 'storeConnLink'
  | 'holding'
  | 'lot'
  | 'insightDismiss'
  | 'plan'
  | 'planSubject'
  | 'activity';

// every entity this build knows: the sync engine skips ops of any other
// (an older device may push retired ones, a server log replays them)
export const ENTITY_NAMES: readonly EntityName[] = [
  'space',
  'account',
  'category',
  'transaction',
  'txMeta',
  'accountLink',
  'recurring',
  'recurringDismiss',
  'txSeen',
  'budget',
  'event',
  'goal',
  'goalContribution',
  'receipt',
  'receiptLink',
  'receiptFile',
  'storeConn',
  'storeConnLink',
  'holding',
  'lot',
  'insightDismiss',
  'plan',
  'planSubject',
  'activity',
];

export interface EntityRowMap {
  space: SpaceRow;
  account: AccountRow;
  category: CategoryRow;
  transaction: TransactionRow;
  txMeta: TxMetaRow;
  accountLink: AccountLinkRow;
  recurring: RecurringRow;
  recurringDismiss: RecurringDismissRow;
  txSeen: TxSeenRow;
  budget: BudgetRow;
  event: EventRow;
  goal: GoalRow;
  goalContribution: GoalContributionRow;
  receipt: ReceiptRow;
  receiptLink: ReceiptLinkRow;
  receiptFile: ReceiptFileRow;
  storeConn: StoreConnRow;
  storeConnLink: StoreConnLinkRow;
  holding: HoldingRow;
  lot: LotRow;
  insightDismiss: InsightDismissRow;
  plan: PlanRow;
  planSubject: PlanSubjectRow;
  activity: ActivityRow;
}
