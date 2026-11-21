import { LOCALES, useLang } from '@/i18n';
import { txTitle } from '@/lib/text';
import { useDisplayMoney } from '@/features/currency/useDisplayMoney';
import { REIMB_CAT_IDS, netAmountCents, netCreditCents } from '@/domain/reimbursement';
import type { TransactionRow } from '@/db/types';
import { REIMBURSED_ID } from '@/domain/categories';
import { catName, useCategories } from '@/features/categories/useCategories';
import { isOtherSub } from '@/domain/catalog';
import type { TFunc } from '@/i18n';
import { Highlight, amountQueryFor } from './Highlight';
import { Icon } from './Icon';
import { Pill } from './primitives';

// a single category (or one split taking the full amount) shows it; several splits under one parent show the parent;
// across parents a neutral "mixed" mark
function txVisual(
  tx: Pick<TransactionRow, 'catId' | 'cats' | 'splits'>,
  cats: ReturnType<typeof useCategories>,
  t: TFunc,
): { icon: string; color: string; label: string } {
  // #211: the row's own category spread and a container's parts share these face rules
  // the settled Reimbursed slice is not what the row is ABOUT: a partly paid-back dinner wears the dinner's face,
  // while an expected or received reimbursement entry still counts (the row stays mixed)
  const source = tx.splits?.length ? tx.splits : (tx.cats ?? []);
  const slices = source.filter((s) => s.amountCents !== 0 && s.catId !== REIMBURSED_ID);
  // #493: an expected/received reimbursement its links settled in full is not waiting: it reads Reimbursed
  if (
    slices.length === 0 &&
    REIMB_CAT_IDS.includes(tx.catId ?? '') &&
    source.some((s) => s.catId === REIMBURSED_ID && s.amountCents > 0)
  ) {
    const settled = cats.byId(REIMBURSED_ID);
    const settledParent = settled.parentId ? cats.byId(settled.parentId) : undefined;
    return { icon: settled.icon, color: settled.color ?? settledParent?.color ?? 'var(--m-ink-3)', label: catName(settled, t) };
  }
  const distinctCatIds = [...new Set(slices.map((s) => s.catId))];
  if (distinctCatIds.length > 1) {
    const parents = [...new Set(distinctCatIds.map((id) => cats.byId(id).parentId ?? id))];
    if (parents.length > 1) return { icon: 'shape', color: 'var(--m-ink-3)', label: t('tx.splitMixed') };
    const parentCat = cats.byId(parents[0]);
    return { icon: parentCat.icon, color: parentCat.color ?? 'var(--m-ink-3)', label: catName(parentCat, t) };
  }
  const cat = cats.byId(distinctCatIds.length === 1 ? distinctCatIds[0] : tx.catId);
  const parent = cat.parentId ? cats.byId(cat.parentId) : undefined;
  // #653: a row names no main, and "Other" alone names nothing — a main's catch-all reads as the main
  const named = parent && isOtherSub(cat) ? parent : cat;
  return { icon: cat.icon, color: cat.color ?? parent?.color ?? 'var(--m-ink-3)', label: catName(named, t) };
}

export type TxRowEdge = 'first' | 'last' | 'both' | 'none';

// #156: the full-bleed selection follows the card's corner radius at its edges, and keyboard focus wears the same
// tint (outline suppressed via data-quiet-focus in styles.css); literal class strings: Tailwind extracts only complete names
const EDGE_SELECTED: Record<TxRowEdge, string> = {
  first: 'rounded-t-card rounded-b-none',
  last: 'rounded-t-none rounded-b-card',
  both: 'rounded-card',
  none: 'rounded-none',
};
const EDGE_FOCUS: Record<TxRowEdge, string> = {
  first: 'focus-visible:rounded-t-card focus-visible:rounded-b-none',
  last: 'focus-visible:rounded-t-none focus-visible:rounded-b-card',
  both: 'focus-visible:rounded-card',
  none: 'focus-visible:rounded-none',
};
const SELECTED_BLEED = '-mx-3 w-[calc(100%+1.5rem)] bg-accent-soft/50 px-4';
const FOCUS_BLEED =
  'focus-visible:-mx-3 focus-visible:w-[calc(100%+1.5rem)] focus-visible:bg-accent-soft/50 focus-visible:px-4 focus-visible:outline-none';

export function TxRow({
  tx,
  onClick,
  highlight = '',
  showDate = false,
  hideCategory = false,
  hideUnreviewed = false,
  amountOverrideCents,
  selected = false,
  edge = 'none',
  accountName,
  givenCents = 0,
  transferNote,
  linkedNote,
}: Readonly<{
  tx: TransactionRow;
  onClick?: () => void;
  highlight?: string;
  /** lists without date group headers (Home) show it inline */
  showDate?: boolean;
  hideCategory?: boolean;
  /** bulk review sheet: every row is unreviewed — the badge is noise */
  hideUnreviewed?: boolean;
  /** scoped lists (drill) show their slice as the headline amount */
  amountOverrideCents?: number;
  selected?: boolean;
  /** #156: rows at the group card's rim round their selection/focus tint to its radius */
  edge?: TxRowEdge;
  /** desktop density (D2): the account surfaces as an md+ column */
  accountName?: string;
  /** cents this credit gave away as reimbursements (derived by the list) */
  givenCents?: number;
  /** collapsed transfer pair: "From → To" replaces the category line */
  transferNote?: string;
  /** this row stands for a linked unit whose other rows are folded away: says so */
  linkedNote?: string;
}>) {
  const { t, lang } = useLang();
  const cats = useCategories();
  // rows convert at their OWN day's rate (historically honest lists)
  const { fmt } = useDisplayMoney();
  const { icon: iconName, color, label: categoryLabel } = txVisual(tx, cats, t);

  // reimbursements change what a transaction cost: lists show the net, the gross struck through;
  // credits net out what they refunded
  const net = tx.amountCents > 0 ? netCreditCents(tx, givenCents) : netAmountCents(tx);
  const display = amountOverrideCents ?? net;
  const positive = display > 0;
  const reimbursed = net !== tx.amountCents;

  return (
    <button
      type="button"
      onClick={onClick}
      data-testid={`tx-row-${tx.id}`}
      aria-current={selected ? 'true' : undefined}
      // styles.css skips the outline ring for this button: the focus-visible background is the one focus signal
      data-quiet-focus=""
      className={`m-tap flex items-center gap-3 border-none py-2.5 text-left md:py-2 ${
        selected
          ? `${SELECTED_BLEED} ${EDGE_SELECTED[edge]}`
          : // #198: no base radius: divide-y's hairline is this element's border-bottom, which curves on a rounded element
            // the focus/selected tints carry their own edge-aware radii
            `w-full bg-transparent px-1 ${FOCUS_BLEED} ${EDGE_FOCUS[edge]}`
      }`}
    >
      <span
        className="flex h-10 w-10 shrink-0 items-center justify-center rounded-full"
        style={{ background: `color-mix(in srgb, ${color} 14%, transparent)`, color }}
      >
        <Icon name={iconName} size={20} />
      </span>
      <span className="min-w-0 flex-1">
        <span className="block truncate text-[14px] font-medium text-ink">
          <Highlight text={txTitle(tx)} query={highlight} />
        </span>
        <span className="block truncate text-xs text-ink-3">
          {showDate && (
            <span className="text-ink-4">
              {new Date(tx.date).toLocaleDateString(LOCALES[lang], { day: 'numeric', month: 'short' })}
              {!hideCategory && ' · '}
            </span>
          )}
          {transferNote ? (
            <span data-testid={`tx-row-pair-${tx.id}`}>
              <Icon name="swap-horizontal" size={11} /> {transferNote}
            </span>
          ) : (
            !hideCategory && categoryLabel
          )}
          {linkedNote && (
            <Pill tone="accent" className="ml-1.5" testId={`tx-row-linked-${tx.id}`}>
              <Icon name="link-variant" size={10} /> {linkedNote}
            </Pill>
          )}
          {tx.pending === 1 && (
            <Pill className={hideCategory && !showDate ? '' : 'ml-1.5'}>{t('tx.pendingBadge')}</Pill>
          )}
          {/* #547: an icon marks manual and auto transactions merged; an entry still waiting for its bank row says so */}
          {(tx as { entry?: unknown }).entry !== undefined && (
            <span className="ml-1.5 inline-flex align-middle" title={t('entry.linkedTitle')} data-testid={`tx-row-entry-${tx.id}`}>
              <Icon name="link-variant" size={12} color="var(--m-accent-deep)" />
            </span>
          )}
          {!!tx.enteredAt && !tx.bankTxId && (
            <Pill className="ml-1.5" testId={`tx-row-waiting-${tx.id}`}>
              {t('entry.waitingBadge')}
            </Pill>
          )}
          {tx.needsReview === 1 && !hideUnreviewed && (
            <Pill tone="warning" className={hideCategory && !showDate ? '' : 'ml-1.5'}>
              {t('tx.unreviewed')}
            </Pill>
          )}
        </span>
      </span>
      {accountName && (
        <span className="hidden max-w-[180px] shrink-0 truncate text-right text-[12px] text-ink-4 md:block">
          {accountName}
        </span>
      )}
      <span className="shrink-0 text-right">
        <span className={`m-num block text-[14px] font-semibold ${positive ? 'text-accent-deep' : 'text-ink'}`}>
          {(() => {
            const amountText = fmt(display, tx.currency, { sign: true, date: tx.date });
            return <Highlight text={amountText} query={amountQueryFor(amountText, highlight)} />;
          })()}
        </span>
        {amountOverrideCents === undefined && reimbursed && (
          <span className="m-num block text-[11px] text-ink-4 line-through">
            {fmt(tx.amountCents, tx.currency, { sign: true, date: tx.date })}
          </span>
        )}
        {amountOverrideCents !== undefined && amountOverrideCents !== net && (
          <span className="m-num block text-[11px] text-ink-4">{fmt(net, tx.currency, { sign: true, date: tx.date })}</span>
        )}
      </span>
    </button>
  );
}
