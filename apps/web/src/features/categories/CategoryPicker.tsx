import { ScrollRow } from '@/ui/ScrollRow';
import { useEffect, useMemo, useRef, useState } from 'react';
import { useNavigate } from '@tanstack/react-router';
import { directionAllows } from '@/domain/categoryRules';
import { REIMBURSED_ID, isSpecialCategory, mainCatOf, specialCatType } from '@/domain/categories';
import { allowedSpecialCats, counterTypesFor } from '@/domain/txType';
import { kindOf } from '@/domain/txKind';
import { useLang } from '@/i18n';
import { Highlight } from '@/ui/Highlight';
import { Icon } from '@/ui/Icon';
import { useUserInk } from '@/ui/userInk';
import { Chip, toneColor } from '@/ui/primitives';
import { Sheet } from '@/ui/Sheet';
import { SearchField } from '@/ui/SearchField';
import { catName, useCategories } from './useCategories';
import { useCategoryAvailability } from '@/application/planning';
import { useDisplayMoney } from '@/features/currency/useDisplayMoney';
import { STATUS_TONE } from '@/features/planning/planningUi';
import { SpecialCatMark } from './SpecialCatMark';

import type { AccountType, TxType } from '@/db/types';

interface CategoryPickerProps {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  selectedId?: string;
  onPick: (catId: string) => void;
  direction?: 'debit' | 'credit';
  txType?: TxType;
  // #133 r5: with `direction` it runs the movement matrix: a regular account's outgoing row sees only "Set aside" of the
  // saving family (Interest/Fees live on the pot's ledger); omitted = no narrowing
  sourceAccountType?: AccountType;
  /** categories other rows of a split already own are hidden: never offer the same category twice */
  excludeIds?: readonly string[];
  /** ALLOWLIST: a recurring-linked transaction picks only between the recurring's category and expected reimbursement */
  onlyIds?: readonly string[];
  /** #228: no ◆ specials for a spread's rows (one special per split transaction, spanning the whole); reimbursement stays */
  noSpecials?: boolean;
  /** #275: fired before the create-custom door navigates away; hosts stash their return state */
  onCreateCustomNav?: () => void;
  /** #322: hosts that narrow by a counterparty pass this to render the detach door inside the picker; it clears the counter */
  onClearCounter?: () => void;
  /** #339: chips narrowing the catalog to categories that can point at that account (inverse of #322) */
  counterAccounts?: readonly { id: string; name: string; type: AccountType }[];
  /** with a chip active, the pick reports the account too so the host links it right away */
  onPickWithCounter?: (catId: string, accountId: string) => void;
  /** #339 r3: a counterparty stands: the ◆ lens, counter chips and create door step aside until it is removed */
  counterLinked?: boolean;
}

/** the nearest scrolling ancestor (the sheet's own scroller) back to its top */
function rewindScroller(el: HTMLElement | null): void {
  for (let node = el?.parentElement; node; node = node.parentElement) {
    const overflow = globalThis.getComputedStyle(node).overflowY;
    if (overflow === 'auto' || overflow === 'scroll') {
      node.scrollTop = 0;
      return;
    }
  }
}

export function CategoryPicker({ open, onOpenChange, selectedId, onPick, direction, txType, sourceAccountType, excludeIds, onlyIds, noSpecials, onCreateCustomNav, onClearCounter, counterAccounts, onPickWithCounter, counterLinked }: Readonly<CategoryPickerProps>) {
  const { t } = useLang();
  const ink = useUserInk();
  const cats = useCategories();
  const navigate = useNavigate();
  const availability = useCategoryAvailability(open);
  const { fmt } = useDisplayMoney();
  const [query, setQuery] = useState('');
  const [specialOnly, setSpecialOnly] = useState(false);
  const [counterAcct, setCounterAcct] = useState<string | null>(null);
  const counterAcctType = counterAccounts?.find((a) => a.id === counterAcct)?.type;

  const groups = useMemo(() => {
    const q = query.trim().toLowerCase();
    // #133 r5: with row context, movement-family subs narrow to the
    // matrix cell (source account type × money side); null = no context
    const allowedMovement = sourceAccountType && direction ? allowedSpecialCats(sourceAccountType, direction) : null;
    return cats.parents
      .map((parent) => {
        // #214: a query hitting the PARENT's name keeps the whole group
        const parentMatch = !!q && catName(parent, t).toLowerCase().includes(q);
        return {
        parent,
        children: cats
          .childrenOf(parent.id)
          // `reimbursed` is munni's own bookkeeping: settlement writes it, people never pick it
          .filter((c) => c.id !== REIMBURSED_ID)
          .filter((c) => !direction || directionAllows(c.direction, direction))
          // a transaction's category must speak its type; STANDARD rows also see the marked special families (picking one pulls the
          // type along) and the TRANSFER family (#133 E: its pick opens the mandatory counterparty ask); stamped rows stay narrowed
          .filter(
            (c) =>
              !txType ||
              c.txTypes.includes(txType) ||
              // #261: the Adjustment family never rides this escape: its rows are system-minted only
              (kindOf(txType) === 'standard' && isSpecialCategory(c) && mainCatOf(c.id) !== 'adjustment'),
          )
          .filter((c) => !allowedMovement || specialCatType(c.id) === undefined || allowedMovement.has(c.id))
          .filter((c) => !noSpecials || specialCatType(c.id) === undefined)
          .filter((c) => !specialOnly || isSpecialCategory(c))
          .filter((c) => !counterAcctType || (counterTypesFor(c.id)?.includes(counterAcctType) ?? false))
          .filter((c) => !excludeIds?.includes(c.id))
          .filter((c) => !onlyIds || onlyIds.includes(c.id))
          .filter((c) => !q || parentMatch || catName(c, t).toLowerCase().includes(q)),
        };
      })
      .filter((g) => g.children.length > 0);
  }, [cats, query, t, direction, txType, sourceAccountType, excludeIds, onlyIds, noSpecials, specialOnly, counterAcctType]);

  const pick = (catId: string) => {
    if (counterAcct && onPickWithCounter) onPickWithCounter(catId, counterAcct);
    else onPick(catId);
    onOpenChange(false);
    setQuery('');
  };

  // the sheet's own scroller holds the list, so a rewind means scrolling THAT
  const listRef = useRef<HTMLDivElement>(null);
  // reopening starts whole: lens, query and counter chip reset and the list rewinds (#273 #329 #335 #323)
  useEffect(() => {
    if (!open) return;
    setSpecialOnly(false);
    setCounterAcct(null);
    setQuery('');
    rewindScroller(listRef.current);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [open]);
  // #323: a query change rewinds the scroller so the shorter list starts at its top
  useEffect(() => {
    rewindScroller(listRef.current);
  }, [query]);

  return (
    <Sheet open={open} onOpenChange={onOpenChange} title={t('screen.categories')} size="full">
      <div className="sticky top-0 z-10 -mx-5 bg-bg px-5 pb-2" data-testid="catpicker-search-wrap">
        <SearchField testId="catpicker-search" value={query} onChange={setQuery} placeholder={t('cats.searchPlaceholder')} />
        {!noSpecials && !counterLinked && (
          <div className="mt-2 flex gap-2">
            <Chip testId="catpicker-special-filter" selected={specialOnly} onClick={() => setSpecialOnly((v) => !v)}>
              <span aria-hidden className="inline-block h-[7px] w-[7px] rotate-45 rounded-[1.5px] bg-current" />
              {t('cats.special')}
            </Chip>
          </div>
        )}
        {!counterLinked && counterAccounts && counterAccounts.length > 0 && (
          <div className="mt-2" data-testid="catpicker-counter-filter">
            <div className="flex items-center gap-1.5 px-1 text-[11px] font-semibold text-ink-4">
              {t('cats.counterFilter')}
              <span title={t('cats.counterFilterHint')} aria-label={t('cats.counterFilterHint')}>
                <Icon name="information-outline" size={13} color="var(--m-ink-4)" />
              </span>
            </div>
            <ScrollRow className="mt-1">
              {counterAccounts.map((a) => (
                <Chip
                  key={a.id}
                  testId={`catpicker-counter-${a.id}`}
                  selected={counterAcct === a.id}
                  onClick={() => setCounterAcct((v) => (v === a.id ? null : a.id))}
                >
                  {a.name}
                </Chip>
              ))}
            </ScrollRow>
            {counterAcct && (
              <p className="px-1 pt-0.5 text-[11px] text-ink-4" data-testid="catpicker-counter-note">
                {t('cats.counterFilterActive')}
              </p>
            )}
          </div>
        )}
      </div>
      <div ref={listRef} className="mt-1" data-testid="catpicker-list">
      {/* #322: the narrowed list says why and offers the way out: detaching the counterparty here frees the whole catalog */}
      {onClearCounter && (
        <button
          data-testid="catpicker-clear-counter"
          onClick={onClearCounter}
          className="m-tap mt-1 flex w-full items-center gap-2 rounded-card border border-dashed border-line bg-transparent px-3 py-2.5 text-left text-[13px] font-medium text-accent-deep"
        >
          <Icon name="link-off" size={16} />
          {t('cats.clearCounter')}
        </button>
      )}
      {groups.map(({ parent, children }) => (
        <div key={parent.id}>
          <div className="m-cap mt-3 mb-1 flex items-center gap-1.5 px-1" style={{ color: ink(parent.color) }}>
            <Icon name={parent.icon} size={14} />
            {/* #187: <mark> fragments in a gapped flex row would split the word: the span keeps them one inline run */}
            <span className="min-w-0 truncate">
              <Highlight text={catName(parent, t)} query={query} />
            </span>
          </div>
          {children.map((cat) => (
            <button
              key={cat.id}
              data-testid={`catpicker-${cat.id}`}
              onClick={() => pick(cat.id)}
              className="m-tap flex w-full items-center gap-3 border-none bg-transparent px-1 py-2.5 text-left text-[14px] text-ink"
            >
              <Icon name={cat.icon} size={19} color={cat.color ?? parent.color} />
              <span className="flex min-w-0 flex-1 items-center gap-1.5">
                <SpecialCatMark cat={cat} color={cat.color ?? parent.color} />
                <span className="min-w-0 truncate">
                  <Highlight text={catName(cat, t)} query={query} />
                </span>
              </span>
              {availability.get(cat.id) && (
                <span
                  className="m-num shrink-0 text-[11px]"
                  style={{ color: toneColor(STATUS_TONE[availability.get(cat.id)!.status]) }}
                  data-testid={`catpicker-avail-${cat.id}`}
                  title={availability.get(cat.id)!.subjectName}
                >
                  {fmt(availability.get(cat.id)!.cents, availability.get(cat.id)!.currency)}
                </span>
              )}
              {selectedId === cat.id && <Icon name="check" size={18} color="var(--m-accent)" />}
            </button>
          ))}
        </div>
      ))}
      {/* never a dead end: a door to a custom category; #339 r3: with a counterparty standing, the way out is removing it */}
      {(!counterLinked || groups.length === 0) && (
        <div className="mt-3 mb-2 flex flex-col items-center gap-1 rounded-card border border-dashed border-line px-4 py-3 text-center">
          {groups.length === 0 && (
            <p className="text-[13px] text-ink-3" data-testid="catpicker-empty">
              {t('cats.noneFound')}
            </p>
          )}
          {!counterLinked && (
            <button
              data-testid="catpicker-create-custom"
              onClick={() => {
                onCreateCustomNav?.(); // #275: hosts stash their way back
                onOpenChange(false);
                setQuery('');
                void navigate({ to: '/categories' });
              }}
              className="m-tap flex items-center gap-1.5 border-none bg-transparent text-[13px] font-semibold text-accent-deep"
            >
              <Icon name="plus" size={15} />
              {t('cats.createCustom')}
            </button>
          )}
        </div>
      )}
      </div>
    </Sheet>
  );
}
