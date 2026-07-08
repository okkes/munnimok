import Dexie from 'dexie';
import type { Table } from 'dexie';
import type {
  AccountLinkRow,
  AccountRow,
  CategoryRow,
  EntityName,
  MetaRow,
  OutboxRow,
  RecurringDismissRow,
  RecurringRow,
  SpaceRow,
  TransactionRow,
  TxMetaRow,
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
  outbox!: Table<OutboxRow, string>;
  meta!: Table<MetaRow, string>;

  constructor(name: string) {
    super(name);
    this.version(1).stores({
      spaces: 'id',
      accounts: 'id, spaceId',
      categories: 'id, spaceId, parentId',
      transactions: 'id, spaceId, accountId, catId, [spaceId+date]',
      outbox: 'opId, spaceId, hlc',
      meta: 'key',
    });
    // feature B: per-space transformation overlay + account attachments
    this.version(2).stores({
      txMeta: 'id, spaceId, txId, [spaceId+txId]',
      accountLinks: 'id, spaceId, feedSpaceId, accountId',
    });
    // recurring costs + dismissed suggestions
    this.version(3).stores({
      recurrings: 'id, spaceId',
      recurringDismissals: 'id, spaceId',
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
      default:
        throw new Error(`unknown entity: ${entity}`);
    }
  }
}

export const identityDbName = (identity: string) => `munni_${identity}`;
