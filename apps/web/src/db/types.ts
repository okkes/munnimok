import type { SyncEnvelope } from '@/sync/merge';

/**
 * v1 data model. Every synced row carries the SyncEnvelope (fieldVersions +
 * derived deleted flag) and belongs to exactly one space — the unit of
 * sharing and sync.
 *
 * Money is stored as integer minor units (cents), never floats.
 */

export type SpaceKind = 'personal' | 'shared';

export type SpacePeriodType = 'month' | 'week' | 'biweekly' | 'custom';

export interface SpaceRow extends SyncEnvelope {
  id: string;
  name: string;
  kind: SpaceKind;
  currency: string; // ISO 4217, e.g. 'EUR'
  periodType: SpacePeriodType;
  periodDay: number; // day of month the budget period starts (month type)
  /** custom image (small data URL, client-downscaled) — wins over `icon` in lists */
  picture?: string;
  /** MDI icon shown in lists (default 'leaf') */
  icon?: string;
  color?: string;
  /** default start date (yyyy-mm-dd) for transaction history when accounts get attached */
  historyStartDate?: string;
  /** landing-zone layout: block order + visibility, per space (synced) */
  homeBlocks?: { id: string; hidden?: 0 | 1 }[];
}

export type AccountType = 'checking' | 'savings' | 'cash' | 'brokerage' | 'credit' | 'mortgage' | 'loan';
export type AccountSource = 'manual' | 'camt053' | 'gocardless';

export interface AccountRow extends SyncEnvelope {
  id: string;
  spaceId: string;
  name: string;
  type: AccountType;
  source: AccountSource;
  currency: string;
  balanceCents: number;
  /** date balanceCents was known true (yyyy-mm-dd): statement balances and
   *  manual edits both stamp it, and only a newer date may overwrite */
  balanceAsOf?: string;
  iban?: string;
  bankId?: string;
  color?: string;
  archived?: 0 | 1;
}

export type TxType = 'income' | 'expense' | 'saving' | 'transfer' | 'debtPayment' | 'investment' | 'adjustment';

export type CatDirection = 'debit' | 'credit' | 'both';

/**
 * Custom category row. Main (parent) categories carry the transaction
 * type + color; sub categories inherit both from their parent and carry
 * only a direction (which side of the ledger they may be used on).
 * Rows live in the space they were created in: a personal space makes
 * them user-scoped (visible across all the user's personal spaces), a
 * shared space makes them visible to that space's members only.
 */
export interface CategoryRow extends SyncEnvelope {
  id: string;
  spaceId: string;
  parentId?: string;
  /** translation key for built-in categories (e.g. 'cat.groceries') */
  nameKey?: string;
  /** user-entered name for custom categories */
  name?: string;
  icon: string; // MDI icon name
  color: string;
  /** authoritative on parents; derived from the parent for subs */
  txType: TxType;
  /** subs only; parents have no direction */
  direction?: CatDirection;
  /** custom main category (no parentId) */
  isParent?: 0 | 1;
  /** the auto-created "Other" sub of a custom main (direction locked to 'both') */
  isOther?: 0 | 1;
  sortOrder: number;
  builtin: 0 | 1;
}

export interface TxSplit {
  catId: string;
  amountCents: number;
}

/** money received back against an expense (owned by the expense side) */
export interface TxReimbursement {
  /** the credit transaction that pays (part of) this expense back */
  txId: string;
  amountCents: number;
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
  description?: string;
  catId?: string;
  splits?: TxSplit[];
  txType: TxType;
  needsReview: 0 | 1;
  notes?: string;
  counterIban?: string;
  /** deterministic id source for imported rows (bank tx id / CAMT entry ref) */
  importRef?: string;
  reimbursements?: TxReimbursement[];
  /** counter-account for transfers/savings/debt payments — locks txType */
  linkedAccountId?: string;
  /** the recurring cost this expense pays (rent, a subscription, …) */
  recurringId?: string;
}

/**
 * Per-space transformation overlay for one raw transaction (feature B:
 * raw bank data lives once in the account's feed space; every attached
 * space keeps its own opinions about it). Deterministic id
 * uuidv5("meta:" + spaceId + ":" + txId) — concurrent creation by two
 * members converges via LWW.
 */
export interface TxMetaRow extends SyncEnvelope {
  id: string;
  /** the viewing space that owns these opinions */
  spaceId: string;
  /** raw transaction id inside the feed space */
  txId: string;
  catId?: string;
  txType: TxType;
  needsReview: 0 | 1;
  notes?: string;
  splits?: TxSplit[];
  reimbursements?: TxReimbursement[];
  linkedAccountId?: string;
  recurringId?: string;
}

export type RecurringKind = 'fixed' | 'subscription';
export type RecurringEvery = 'month' | 'year';

/**
 * One recurring cost of a space (rent, Netflix, insurance …). The
 * amount is the user's estimate until linked transactions rectify it;
 * merchantKey lets imports auto-link. Scoped per space — shared spaces
 * share their recurring configuration.
 */
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
  /** due day of month 1..31 (clamped to shorter months) */
  dueDay: number;
  /** yearly costs: due month 1..12 */
  dueMonth?: number;
  since?: string;
  until?: string;
  active: 0 | 1;
  /** remind n days before due; absent/0 = no reminder */
  notifyDaysBefore?: number;
  /** normalized merchant (domain/merchantKey) for auto-linking */
  merchantKey?: string;
}

/**
 * A rejected recurring suggestion — the same merchant pattern is never
 * suggested again (synced: a partner's dismissal counts for the space).
 */
export interface RecurringDismissRow extends SyncEnvelope {
  id: string;
  spaceId: string;
  merchantKey: string;
}

export type BudgetEvery = 'week' | '2weeks' | 'month';
export type BudgetCarryMode = 'periods' | 'cap';

/**
 * A space-scoped spending limit over one or more categories, resetting
 * on its own cadence (anchored at a date, independent of the space
 * period). Spending and carry-over are computed client-side from the
 * space's transactions — carry-over is replayed, never stored, so
 * devices always converge (budgets design doc).
 */
export interface BudgetRow extends SyncEnvelope {
  id: string;
  spaceId: string;
  name: string;
  /** MDI icon */
  icon?: string;
  /** the limit per period, positive minor units */
  amountCents: number;
  every: BudgetEvery;
  /** yyyy-mm-dd the cycle counts from */
  anchor: string;
  /** main and/or sub category ids; exclusive across a space's budgets */
  catIds: string[];
  carryOver?: 0 | 1;
  carryMode?: BudgetCarryMode;
  /** carry unused money at most N periods forward (carryMode 'periods') */
  carryPeriods?: number;
  /** or accumulate up to this cap (carryMode 'cap') */
  carryCapCents?: number;
  /** warn when spending crosses this percentage; absent = quiet */
  notifyAtPct?: number;
  active: 0 | 1;
}

/**
 * Attachment of a financial account (its feed space) to a viewing
 * space. Lives in the viewing space so members render it offline; the
 * server keeps the authoritative copy for feed access control.
 */
export interface AccountLinkRow extends SyncEnvelope {
  id: string;
  /** the space the account is attached to */
  spaceId: string;
  /** feed space carrying the raw account + transactions */
  feedSpaceId: string;
  /** account entity id inside the feed */
  accountId: string;
  /** user who attached it (their display name frozen for offline rendering) */
  attachedBy?: string;
  attachedByName?: string;
  /** transactions before this date stay hidden in this space */
  historyFrom?: string;
  /** owner left the space: history stays, no new data flows */
  archived?: 0 | 1;
}

/** Local-only queue of ops not yet accepted by the server. */
export interface OutboxRow {
  opId: string;
  spaceId: string;
  entity: EntityName;
  entityId: string;
  fields: Record<string, unknown>;
  hlc: string;
  deleted?: boolean;
}

/** Local-only key-value store (schema flags, sync cursors, seed markers). */
export interface MetaRow {
  key: string;
  value: unknown;
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
  | 'budget';

export interface EntityRowMap {
  space: SpaceRow;
  account: AccountRow;
  category: CategoryRow;
  transaction: TransactionRow;
  txMeta: TxMetaRow;
  accountLink: AccountLinkRow;
  recurring: RecurringRow;
  recurringDismiss: RecurringDismissRow;
  budget: BudgetRow;
}
