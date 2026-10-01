import Dexie from 'dexie';
import type { Table } from 'dexie';
import type {
  AccountLinkRow,
  AccountRow,
  BudgetRow,
  CategoryRow,
  EntityName,
  EventRow,
  HoldingRow,
  InsightDismissRow,
  ActivityRow,
  ConnectorConnRow,
  LotRow,
  QuoteCacheRow,
  ReceiptLinkRow,
  ReceiptRow,
  StoreConnLinkRow,
  StoreConnRow,
  GoalContributionRow,
  GoalRow,
  MetaRow,
  OutboxRow,
  PlanRow,
  PlanSubjectRow,
  RecurringDismissRow,
  RecurringRow,
  SpaceRow,
  TransactionRow,
  TxMetaRow,
  TxSeenRow,
} from './types';

/**
 * One Dexie database per identity (demo / offline profile / logged-in user),
 * so demo resets and logouts are a whole-database delete, and identities can
 * never bleed into each other.
 */
export class MunniDB extends Dexie {
  spaces!: Table<SpaceRow, string>;
  accounts!: Table<AccountRow, string>;
  categories!: Table<CategoryRow, string>;
  transactions!: Table<TransactionRow, string>;
  txMeta!: Table<TxMetaRow, string>;
  accountLinks!: Table<AccountLinkRow, string>;
  recurrings!: Table<RecurringRow, string>;
  recurringDismissals!: Table<RecurringDismissRow, string>;
  txSeen!: Table<TxSeenRow, string>;
  budgets!: Table<BudgetRow, string>;
  events!: Table<EventRow, string>;
  goals!: Table<GoalRow, string>;
  goalContributions!: Table<GoalContributionRow, string>;
  receipts!: Table<ReceiptRow, string>;
  receiptLinks!: Table<ReceiptLinkRow, string>;
  /** device-only — a connection's credential bundle never syncs in
   *  plaintext (privacy law); keyed by connection id (#367) */
  connectorConns!: Table<ConnectorConnRow, string>;
  storeConns!: Table<StoreConnRow, string>;
  storeConnLinks!: Table<StoreConnLinkRow, string>;
  holdings!: Table<HoldingRow, string>;
  lots!: Table<LotRow, string>;
  insightDismissals!: Table<InsightDismissRow, string>;
  /** #128: plans and their subjects (synced) */
  plans!: Table<PlanRow, string>;
  planSubjects!: Table<PlanSubjectRow, string>;
  activities!: Table<ActivityRow, string>;
  /** device-only — delayed quotes are a cache, not data */
  quoteCache!: Table<QuoteCacheRow, string>;
  outbox!: Table<OutboxRow, string>;
  meta!: Table<MetaRow, string>;

  constructor(name: string) {
    super(name);
    // version 1 is the layout the product deployed from scratch on; a
    // store change adds a version with its delta (never a rewrite of an
    // earlier one — Dexie diffs the declarations to upgrade a device)
    this.version(1).stores({
      spaces: 'id',
      accounts: 'id, spaceId',
      categories: 'id, spaceId, parentId',
      transactions: 'id, spaceId, accountId, catId, [spaceId+date]',
      // feature B: per-space transformation overlay + account attachments
      txMeta: 'id, spaceId, txId, [spaceId+txId]',
      accountLinks: 'id, spaceId, feedSpaceId, accountId',
      // recurring costs + dismissed suggestions
      recurrings: 'id, spaceId',
      recurringDismissals: 'id, spaceId',
      // #148 r3: the synced first-seen rows (user identities)
      txSeen: 'id, spaceId, forSpaceId',
      budgets: 'id, spaceId',
      events: 'id, spaceId',
      goals: 'id, spaceId',
      goalContributions: 'id, spaceId, goalId',
      // allocation (zero-based budgeting) + its custom category groupings
      allocations: 'id, spaceId, [spaceId+periodStart]',
      topics: 'id, spaceId',
      // receipts v3: global rows in the owner's store feed, snapshot
      // links per space, instance-keyed device connections, synced
      // instance metadata + per-space inclusion links, reconnect markers
      receipts: 'id, spaceId',
      receiptLinks: 'id, spaceId, txId, receiptId',
      storeInstances: 'id, store',
      storeConns: 'id, spaceId',
      storeConnLinks: 'id, spaceId, instanceId',
      storeMarkers: 'id, spaceId',
      // portfolio (investments design) + device-only quote cache
      holdings: 'id, spaceId',
      lots: 'id, spaceId, holdingId',
      quoteCache: 'key',
      // insights: synced per-space dismissals
      insightDismissals: 'id, spaceId',
      // activity history: who did what, newest 200 per space
      activities: 'id, spaceId',
      outbox: 'opId, spaceId, hlc',
      meta: 'key',
    });
    // #367: store tokens gave way to connector bundles, and the marker
    // table never had a reader — both go; the bundle row arrives
    this.version(2).stores({
      storeInstances: null,
      storeMarkers: null,
      connectorConns: 'id, provider',
    });
    // #128: planning — a plan per period and kind, its subjects; the
    // allocation cells and topics it replaces leave with it
    this.version(3).stores({
      plans: 'id, spaceId, [spaceId+kind]',
      planSubjects: 'id, spaceId, planId',
      allocations: null,
      topics: null,
    });
  }

  tableFor<E extends EntityName>(entity: E) {
    switch (entity) {
      case 'space':
        return this.spaces;
      case 'account':
        return this.accounts;
      case 'category':
        return this.categories;
      case 'transaction':
        return this.transactions;
      case 'txMeta':
        return this.txMeta;
      case 'accountLink':
        return this.accountLinks;
      case 'recurring':
        return this.recurrings;
      case 'recurringDismiss':
        return this.recurringDismissals;
      case 'txSeen':
        return this.txSeen;
      case 'budget':
        return this.budgets;
      case 'event':
        return this.events;
      case 'goal':
        return this.goals;
      case 'goalContribution':
        return this.goalContributions;
      case 'receipt':
        return this.receipts;
      case 'receiptLink':
        return this.receiptLinks;
      case 'storeConn':
        return this.storeConns;
      case 'storeConnLink':
        return this.storeConnLinks;
      case 'holding':
        return this.holdings;
      case 'lot':
        return this.lots;
      case 'insightDismiss':
        return this.insightDismissals;
      case 'plan':
        return this.plans;
      case 'planSubject':
        return this.planSubjects;
      case 'activity':
        return this.activities;
      default:
        throw new Error(`unknown entity: ${entity}`);
    }
  }
}

export const identityDbName = (identity: string) => `munni_${identity}`;
