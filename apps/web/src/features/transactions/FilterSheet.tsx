import { useEffect, useState } from 'react';
import { useSpaceAccounts } from '@/application/transactions';
import type { SpaceAccount } from '@/db/joined';
import type { TxType } from '@/db/types';
import { institutionLogoUrl } from '@/features/accounts/useInstitutionLogos';
import { typeDef } from '@/features/accounts/accountTypes';
import { catName, useCategories } from '@/features/categories/useCategories';
import { useLang } from '@/i18n';
import { parseCents } from '@/lib/money';
import { Button } from '@/ui/Button';
import { Icon } from '@/ui/Icon';
import { Picture } from '@/ui/Picture';
import { Chip } from '@/ui/primitives';
import { Sheet } from '@/ui/Sheet';

// the screen owns the filter state; sets add within a section, sections combine with AND
// `txTypes` is still applied by the screen but nothing writes it here (#320)
export interface SheetFilters {
  accountIds: ReadonlySet<string>;
  txTypes: ReadonlySet<TxType>;
  /** MAIN category ids — the screen expands them to include subs */
  mainCatIds: ReadonlySet<string>;
  from?: string;
  to?: string;
  /** inclusive bounds on the amount's size, in cents */
  minCents?: number;
  maxCents?: number;
}

export const EMPTY_FILTERS: SheetFilters = { accountIds: new Set(), txTypes: new Set(), mainCatIds: new Set() };

export const countActive = (f: SheetFilters): number =>
  f.accountIds.size +
  f.txTypes.size +
  f.mainCatIds.size +
  (f.from || f.to ? 1 : 0) +
  (f.minCents !== undefined || f.maxCents !== undefined ? 1 : 0);

function toggled<T>(set: ReadonlySet<T>, value: T): Set<T> {
  const next = new Set(set);
  if (next.has(value)) next.delete(value);
  else next.add(value);
  return next;
}

function AccountChipFace({ account }: Readonly<{ account: SpaceAccount }>) {
  const logo = account.logo ?? institutionLogoUrl(account);
  const icon = <Icon name={typeDef(account.type).icon} size={13} color={account.color ?? 'var(--m-ink-3)'} />;
  if (!logo) return icon;
  return (
    <>
      <Picture
        src={logo}
        className="h-4 w-4 rounded object-contain"
        loading="lazy"
        onError={(e) => {
          e.currentTarget.style.display = 'none';
          e.currentTarget.nextElementSibling?.classList.remove('hidden');
        }}
      />
      <span className="hidden">{icon}</span>
    </>
  );
}

function AccountChips({
  list,
  value,
  onChange,
}: Readonly<{
  list: SpaceAccount[];
  value: SheetFilters;
  onChange: (next: SheetFilters) => void;
}>) {
  return (
    <div className="flex flex-wrap gap-2">
      {list.map((a) => (
        <Chip
          key={a.id}
          testId={`filter-account-${a.id}`}
          selected={value.accountIds.has(a.id)}
          onClick={() => onChange({ ...value, accountIds: toggled(value.accountIds, a.id) })}
        >
          <AccountChipFace account={a} /> {a.name}
        </Chip>
      ))}
    </div>
  );
}

const centsText = (cents: number | undefined): string => (cents === undefined ? '' : (cents / 100).toFixed(2));

// applies to the amount's SIZE so a €50 purchase and a €50 refund both match;
// boxes keep half-typed text, a reset from outside empties them
function AmountRange({ value, onChange }: Readonly<{ value: SheetFilters; onChange: (next: SheetFilters) => void }>) {
  const { t } = useLang();
  const [minText, setMinText] = useState(() => centsText(value.minCents));
  const [maxText, setMaxText] = useState(() => centsText(value.maxCents));
  useEffect(() => {
    if (value.minCents === undefined && parseCents(minText) !== null) setMinText('');
    if (value.maxCents === undefined && parseCents(maxText) !== null) setMaxText('');
  }, [value.minCents, value.maxCents, minText, maxText]);
  const edit = (field: 'minCents' | 'maxCents', text: string) => {
    (field === 'minCents' ? setMinText : setMaxText)(text);
    const cents = parseCents(text);
    onChange({ ...value, [field]: cents === null ? undefined : Math.abs(cents) });
  };
  const box = 'h-10 min-w-0 flex-1 rounded-input border border-line bg-surface px-3 text-[13px] text-ink outline-none';
  return (
    <>
      <div className="m-cap px-1">{t('tx.amountRange')}</div>
      <div className="flex items-center gap-2">
        <input
          data-testid="filter-amount-min"
          type="text"
          inputMode="decimal"
          placeholder={t('tx.amountMin')}
          value={minText}
          onChange={(e) => edit('minCents', e.target.value)}
          className={box}
        />
        <span className="text-ink-4">–</span>
        <input
          data-testid="filter-amount-max"
          type="text"
          inputMode="decimal"
          placeholder={t('tx.amountMax')}
          value={maxText}
          onChange={(e) => edit('maxCents', e.target.value)}
          className={box}
        />
      </div>
    </>
  );
}

export function FilterSheet({
  open,
  onOpenChange,
  value,
  onChange,
}: Readonly<{
  open: boolean;
  onOpenChange: (open: boolean) => void;
  value: SheetFilters;
  onChange: (next: SheetFilters) => void;
}>) {
  const { t } = useLang();
  const cats = useCategories();
  const accounts = useSpaceAccounts();

  return (
    <Sheet open={open} onOpenChange={onOpenChange} title={t('tx.filters')} size="tall">
      <div className="flex flex-col gap-3 pb-2">
        <div className="m-cap px-1">{t('tx.filterAccountsCap')}</div>
        <AccountChips list={accounts ?? []} value={value} onChange={onChange} />

        <div className="m-cap px-1">{t('screen.categories')}</div>
        <div className="flex flex-wrap gap-2">
          {cats.parents.map((main) => (
            <Chip
              key={main.id}
              testId={`filter-cat-${main.id}`}
              selected={value.mainCatIds.has(main.id)}
              onClick={() => onChange({ ...value, mainCatIds: toggled(value.mainCatIds, main.id) })}
            >
              <Icon name={main.icon} size={13} /> {catName(main, t)}
            </Chip>
          ))}
        </div>

        <AmountRange value={value} onChange={onChange} />

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
