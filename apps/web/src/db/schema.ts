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

// one Dexie database per identity: demo reset and logout are a whole-database delete,
// identities never bleed into each other
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
  /** device-only: a connection's credential bundle never syncs in plaintext (#367) */
  connectorConns!: Table<ConnectorConnRow, string>;
  storeConns!: Table<StoreConnRow, string>;
  storeConnLinks!: Table<StoreConnLinkRow, string>;
  holdings!: Table<HoldingRow, string>;
  lots!: Table<LotRow, string>;
  insightDismissals!: Table<InsightDismissRow, string>;
  plans!: Table<PlanRow, string>;
  planSubjects!: Table<PlanSubjectRow, string>;
  activities!: Table<ActivityRow, string>;
  /** device-only — delayed quotes are a cache, not data */
  quoteCache!: Table<QuoteCacheRow, string>;
  outbox!: Table<OutboxRow, string>;
  meta!: Table<MetaRow, string>;

  constructor(name: string) {
    super(name);
    // a store change adds a version with its delta, never a rewrite of an earlier one:
    // Dexie diffs the declarations to upgrade a device
    this.version(1).stores({
      spaces: 'id',
      accounts: 'id, spaceId',
      categories: 'id, spaceId, parentId',
      transactions: 'id, spaceId, accountId, catId, [spaceId+date]',
      txMeta: 'id, spaceId, txId, [spaceId+txId]',
      accountLinks: 'id, spaceId, feedSpaceId, accountId',
      recurrings: 'id, spaceId',
      recurringDismissals: 'id, spaceId',
      txSeen: 'id, spaceId, forSpaceId',
      budgets: 'id, spaceId',
      events: 'id, spaceId',
      goals: 'id, spaceId',
      goalContributions: 'id, spaceId, goalId',
      allocations: 'id, spaceId, [spaceId+periodStart]',
      topics: 'id, spaceId',
      receipts: 'id, spaceId',
      receiptLinks: 'id, spaceId, txId, receiptId',
      storeInstances: 'id, store',
      storeConns: 'id, spaceId',
      storeConnLinks: 'id, spaceId, instanceId',
      storeMarkers: 'id, spaceId',
      holdings: 'id, spaceId',
      lots: 'id, spaceId, holdingId',
      quoteCache: 'key',
      insightDismissals: 'id, spaceId',
      activities: 'id, spaceId',
      outbox: 'opId, spaceId, hlc',
      meta: 'key',
    });
    this.version(2).stores({
      storeInstances: null,
      storeMarkers: null,
      connectorConns: 'id, provider',
    });
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
