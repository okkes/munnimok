import { useSpaceAccounts } from '@/application/transactions';
import { ALL_TX_TYPES } from '@/domain/txType';
import type { TxType } from '@/db/types';
import { catName, useCategories } from '@/features/categories/useCategories';
import { useLang } from '@/i18n';
import { Button } from '@/ui/Button';
import { Icon } from '@/ui/Icon';
import { Sheet } from '@/ui/Sheet';

/**
 * Filter state owned by the transactions screen; the sheet only edits
 * it. Sets are additive within a section and sections combine with AND
 * (pick two accounts + 'expense' = expenses on either account).
 */
export interface SheetFilters {
  accountIds: ReadonlySet<string>;
  txTypes: ReadonlySet<TxType>;
  /** MAIN category ids — the screen expands them to include subs */
  mainCatIds: ReadonlySet<string>;
  from?: string;
  to?: string;
}

export const EMPTY_FILTERS: SheetFilters = { accountIds: new Set(), txTypes: new Set(), mainCatIds: new Set() };

export const countActive = (f: SheetFilters): number =>
  f.accountIds.size + f.txTypes.size + f.mainCatIds.size + (f.from || f.to ? 1 : 0);

function toggled<T>(set: ReadonlySet<T>, value: T): Set<T> {
  const next = new Set(set);
  if (next.has(value)) next.delete(value);
  else next.add(value);
  return next;
}

export function FilterSheet({
  open,
  onOpenChange,
  value,
  onChange,
}: {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  value: SheetFilters;
  onChange: (next: SheetFilters) => void;
}) {
  const { t } = useLang();
  const cats = useCategories();
  const accounts = useSpaceAccounts();

  const chip = (active: boolean) =>
    `m-tap shrink-0 rounded-full border px-3 py-1.5 text-[12px] ${
      active ? 'border-accent bg-accent-soft font-medium text-accent-deep' : 'border-line bg-surface text-ink-2'
    }`;

  return (
    <Sheet open={open} onOpenChange={onOpenChange} title={t('tx.filters')} size="tall">
      <div className="flex flex-col gap-3 pb-2">
        <div className="m-cap px-1">{t('acct.financialAccounts')}</div>
        <div className="flex flex-wrap gap-2">
          {(accounts ?? []).map((a) => (
            <button
              key={a.id}
              data-testid={`filter-account-${a.id}`}
              onClick={() => onChange({ ...value, accountIds: toggled(value.accountIds, a.id) })}
              className={chip(value.accountIds.has(a.id))}
            >
              {a.name}
            </button>
          ))}
        </div>

        <div className="m-cap px-1">{t('tx.type')}</div>
        <div className="flex flex-wrap gap-2">
          {ALL_TX_TYPES.map((type) => (
            <button
              key={type}
              data-testid={`filter-type-${type}`}
              onClick={() => onChange({ ...value, txTypes: toggled(value.txTypes, type) })}
              className={chip(value.txTypes.has(type))}
            >
              {t(`tx.type.${type}`)}
            </button>
          ))}
        </div>

        <div className="m-cap px-1">{t('screen.categories')}</div>
        <div className="flex flex-wrap gap-2">
          {cats.parents.map((main) => (
            <button
              key={main.id}
              data-testid={`filter-cat-${main.id}`}
              onClick={() => onChange({ ...value, mainCatIds: toggled(value.mainCatIds, main.id) })}
              className={chip(value.mainCatIds.has(main.id))}
            >
              <Icon name={main.icon} size={13} /> {catName(main, t)}
            </button>
          ))}
        </div>

        <div className="m-cap px-1">{t('tx.dateRange')}</div>
        <div className="flex items-center gap-2">
          <input
            data-testid="filter-from"
            type="date"
            value={value.from ?? ''}
            onChange={(e) => onChange({ ...value, from: e.target.value || undefined })}
            className="h-10 min-w-0 flex-1 rounded-input border border-line bg-surface px-3 text-[13px] text-ink outline-none"
          />
          <span className="text-ink-4">–</span>
          <input
            data-testid="filter-to"
            type="date"
            value={value.to ?? ''}
            onChange={(e) => onChange({ ...value, to: e.target.value || undefined })}
            className="h-10 min-w-0 flex-1 rounded-input border border-line bg-surface px-3 text-[13px] text-ink outline-none"
          />
        </div>

        <div className="mt-2 flex gap-2">
          <Button
            variant="outline"
            className="flex-1"
            data-testid="filter-reset"
            onClick={() => onChange(EMPTY_FILTERS)}
          >
            {t('tx.filtersReset')}
          </Button>
          <Button className="flex-1" data-testid="filter-done" onClick={() => onOpenChange(false)}>
            {t('action.done')}
          </Button>
        </div>
      </div>
    </Sheet>
  );
}
