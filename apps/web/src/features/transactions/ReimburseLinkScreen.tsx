import { Fragment, useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { useNavigate, useParams, useSearch } from '@tanstack/react-router';
import { useSpaceTransactions } from '@/application/transactions';
import type { SpaceTx } from '@/application/transactions';
import { useLang } from '@/i18n';
import { fmtCents, parseCents } from '@/lib/money';
import { cleanBankText } from '@/lib/text';
import { filterTxs } from '@/domain/txFilter';
import { creditPartGivenCents, creditRemainingCents, givenCents, isReimbContainer, remainingCents, settledCats } from '@/domain/reimbursement';
import { expenseNeedCents, partOpenCents, suggestCounterparts } from '@/domain/reimburseMatch';
import { catName, useCategories } from '@/features/categories/useCategories';
import { useReimburseLinks } from './useReimburseLinks';
import type { LinkEntry } from './useReimburseLinks';
import { AppBar, IconButton } from '@/ui/AppBar';
import { Button } from '@/ui/Button';
import { Icon } from '@/ui/Icon';
import { TxRow } from '@/ui/TxRow';
import { TxPartRow } from '@/ui/TxPartRow';
import { SearchField } from '@/ui/SearchField';
import { FormBlockerNote, blockerRing } from '@/ui/FormBlockerNote';
import { CollapsingSearch, useSearchCollapse } from '@/ui/CollapsingSearch';
import { StackedBar } from '@/ui/charts';
import { JumpToDateButton, useJumpToDate } from '@/ui/JumpToDate';
import { MoreRows, PAGE_ROWS } from '@/ui/MoreRows';
import { REIMBURSED_ID, UNCATEGORIZED_ID } from '@/domain/categories';
import type { TxSplit } from '@/db/types';

/** rows mounted past a jump's target, so there is something to scroll down into */
const JUMP_TAIL = 40;

const toText = (cents: number) => (cents / 100).toFixed(2).replace('.', ',');

interface ImpactLine {
  catId: string;
  before: number;
  after: number;
}

interface ImpactSide {
  title: string;
  lines: ImpactLine[];
}

type NameOf = (catId: string) => string;

/** the preview diffs the real settlement engine (settledCats before vs after), so it shows what save would write (#233) */
function impactLinesFor(
  subject: { amountCents: number; catId?: string; cats?: { catId: string; amountCents: number }[] },
  beforeCents: number,
  afterCents: number,
  nameOf: NameOf,
): ImpactLine[] {
  const before = settledCats(subject, beforeCents, nameOf);
  const after = settledCats(subject, afterCents, nameOf);
  const at = (list: { catId: string; amountCents: number }[], id: string) =>
    list.find((slice) => slice.catId === id)?.amountCents ?? 0;
  const ids = [...new Set([...before, ...after].map((slice) => slice.catId))];
  const order = [...after.filter((slice) => slice.catId !== REIMBURSED_ID).map((slice) => slice.catId), REIMBURSED_ID];
  ids.sort((a, b) => order.indexOf(a) - order.indexOf(b));
  return ids
    .map((catId) => ({ catId, before: at(before, catId), after: at(after, catId) }))
    .filter((line) => line.before !== line.after);
}

function expenseImpact(expense: SpaceTx, partId: string | undefined, addCents: number, nameOf: NameOf): ImpactSide {
  const part = partId ? (expense.splits ?? []).find((p) => p.id === partId) : undefined;
  const subject = part ? { amountCents: part.amountCents, catId: part.catId, cats: part.cats } : expense;
  const already = (expense.reimbursements ?? [])
    .filter((link) => (part ? link.partId === partId : true))
    .reduce((sum, link) => sum + link.amountCents, 0);
  return { title: cleanBankText(expense.merchant), lines: impactLinesFor(subject, already, already + addCents, nameOf) };
}

function creditImpact(credit: SpaceTx, creditPartId: string | undefined, addCents: number, allTxs: SpaceTx[], nameOf: NameOf): ImpactSide {
  const part = creditPartId ? (credit.splits ?? []).find((p) => p.id === creditPartId) : undefined;
  const given = part && creditPartId ? creditPartGivenCents(allTxs, credit.id, creditPartId) : givenCents(allTxs, credit.id);
  // the credit self-files as Reimbursed exactly like the save would
  const selfFiles = !part && !isReimbContainer(credit) && (!credit.catId || credit.catId === UNCATEGORIZED_ID || credit.needsReview === 1);
  const subject = part ? { amountCents: part.amountCents, catId: part.catId, cats: part.cats } : { ...credit, catId: selfFiles ? REIMBURSED_ID : credit.catId };
  return { title: cleanBankText(credit.merchant), lines: impactLinesFor(subject, given, given + addCents, nameOf) };
}

interface Pick {
  key: string;
  row: SpaceTx;
  partId?: string;
  creditPartId?: string;
  /** the pair's honest ceiling - the save refuses more, never shrinks silently (#233) */
  maxCents: number;
  text: string;
}

export interface PickedLink {
  key: string;
  row: SpaceTx;
  partId?: string;
  creditPartId?: string;
  cents: number;
}

const keyOf = (rowId: string, partId?: string, creditPartId?: string): string => `${rowId}|${partId ?? ''}|${creditPartId ?? ''}`;
const amountTestId = (key: string): string => `reimb-amount-${key.split('|').filter(Boolean).join('-')}`;
const centsOf = (pick: Pick): number => Math.max(0, parseCents(pick.text) ?? 0);

const pickColor = (i: number): string => `color-mix(in srgb, var(--m-accent) ${Math.max(35, 100 - i * 18)}%, white)`;

// several picks at once, each prefilled with what the pair can take; the footer previews the category shift
// and links every pick in one gesture
export function ReimburseLinkScreen() {
  const navigate = useNavigate();
  const { txId } = useParams({ strict: false }) as { txId: string };
  // #126 r5: opened from a part page → the link targets that part
  const { part: partId } = useSearch({ strict: false }) as { part?: string };
  const allTxs = useSpaceTransactions();
  const tx = useMemo(() => allTxs?.find((row) => row.id === txId), [allTxs, txId]);
  const { linkMany } = useReimburseLinks(allTxs);
  const anchorIsExpense = (tx?.amountCents ?? 0) < 0;
  const link = (picks: readonly PickedLink[]) => {
    if (!tx) return;
    // the part target lives on the expense side: an expense anchor takes ?part, the credit part rides the pick;
    // a credit anchor's own part page takes ?part (#197)
    const entries: LinkEntry[] = picks.map((pick) =>
      anchorIsExpense
        ? { expense: tx, credit: pick.row, cents: pick.cents, partId, creditPartId: pick.creditPartId }
        : { expense: pick.row, credit: tx, cents: pick.cents, partId: pick.partId, creditPartId: partId },
    );
    linkMany(entries);
    // replace, not back: back from the detail must not resurface a stale picker
    void navigate({ to: '/transactions/$txId', params: { txId }, search: partId ? { part: partId } : {}, replace: true });
  };
  return <ReimburseLinkPicker tx={tx} partId={partId} allTxs={allTxs} onConfirm={link} />;
}

/** also serves a transaction still being typed (#348): nothing is written here, the picks go to the caller */
export function ReimburseLinkPicker({
  tx,
  partId,
  allTxs,
  initial,
  onConfirm,
  onBack = () => window.history.back(),
}: Readonly<{
  tx: SpaceTx | undefined;
  partId?: string;
  allTxs: SpaceTx[] | undefined;
  initial?: readonly Omit<PickedLink, 'row'>[];
  onConfirm: (picks: PickedLink[]) => void;
  onBack?: () => void;
}>) {
  const { t, lang } = useLang();
  const { giveableCents } = useReimburseLinks(allTxs);

  const [query, setQuery] = useState('');
  /** starts folded: open, it ate half the screen under the list */
  const [impactOpen, setImpactOpen] = useState(false);
  const [picks, setPicks] = useState<Pick[]>([]);
  const [error, setError] = useState<{ key?: string; text: string } | null>(null);
  const cats = useCategories();

  // the search bar rides the shared gliding collapse so the list flows into the freed space (#273)
  const { offset: searchOffset, onListScroll } = useSearchCollapse(56);

  const anchorIsExpense = (tx?.amountCents ?? 0) < 0;
  const anchorPart = useMemo(() => (tx && partId ? (tx.splits ?? []).find((p) => p.id === partId) : undefined), [tx, partId]);
  const givenOf = (id: string) => givenCents(allTxs ?? [], id);

  // what ONE part of a split credit can still give: its magnitude minus the links naming it,
  // capped by what the credit has left (#197)
  const creditPartOpen = (row: SpaceTx, part: TxSplit): number =>
    Math.min(
      giveableCents(row),
      Math.max(0, Math.abs(part.amountCents) - (part.id ? creditPartGivenCents(allTxs ?? [], row.id, part.id) : 0)),
    );

  // a part anchor answers for itself, not with the container's numbers
  const anchor = useMemo(() => {
    if (!tx) return { capacity: 0, before: 0, open: 0, need: 0 };
    if (anchorIsExpense) {
      const capacity = Math.abs(anchorPart?.amountCents ?? tx.amountCents);
      const open = anchorPart ? partOpenCents(tx, anchorPart) : remainingCents(tx);
      return { capacity, before: capacity - open, open, need: expenseNeedCents(tx, anchorPart?.id) };
    }
    const capacity = Math.abs(anchorPart?.amountCents ?? tx.amountCents);
    const open = anchorPart ? creditPartOpen(tx, anchorPart) : giveableCents(tx);
    const spent = anchorPart ? Math.abs(anchorPart.amountCents) - open : capacity - creditRemainingCents(tx, givenOf(tx.id));
    return { capacity, before: Math.max(0, spent), open, need: open };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [tx, anchorIsExpense, anchorPart, allTxs]);

  const candidates = useMemo(() => {
    if (!tx) return [];
    const pool = (allTxs ?? []).filter((row) => row.id !== tx.id);
    return anchorIsExpense
      ? pool.filter((row) => row.amountCents > 0 && creditRemainingCents(row, givenOf(row.id)) > 0)
      : pool.filter((row) => row.amountCents < 0 && remainingCents(row) > 0);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [allTxs, tx?.id, anchorIsExpense]);

  const suggested = useMemo(
    () => (tx ? suggestCounterparts(tx, candidates, givenOf) : []),
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [tx, candidates],
  );
  const suggestedIds = useMemo(() => new Set(suggested.map((s) => s.tx.id)), [suggested]);

  // paged as it scrolls: a cap of 100 left an older day out of reach (#502)
  const listed = useMemo(() => {
    const matched = filterTxs(candidates, { query });
    return [...matched].sort((a, b) => b.date.localeCompare(a.date));
  }, [candidates, query]);
  const [shownRows, setShownRows] = useState(PAGE_ROWS);
  const showMore = useCallback(() => setShownRows((n) => n + PAGE_ROWS), []);
  const { scrollerRef, jump, jumpedId } = useJumpToDate(listed, (index) => setShownRows((n) => Math.max(n, index + JUMP_TAIL)));
  const shownList = listed.slice(0, shownRows);

  const openValueOf = (row: SpaceTx): number => (row.amountCents > 0 ? giveableCents(row) : remainingCents(row));
  const pickedCents = picks.reduce((sum, pick) => sum + centsOf(pick), 0);

  const budget = (): number => {
    const need = Math.max(0, anchor.need - pickedCents);
    return need > 0 ? need : Math.max(0, anchor.open - pickedCents);
  };

  const pairOf = (row: SpaceTx, part?: TxSplit): { own: number; max: number } => {
    if (anchorIsExpense) {
      const own = part ? creditPartOpen(row, part) : giveableCents(row);
      return { own, max: Math.min(anchor.open, own) };
    }
    const own = part ? expenseNeedCents(row, part.id) : expenseNeedCents(row);
    const open = part ? partOpenCents(row, part) : remainingCents(row);
    return { own, max: Math.min(open, anchor.open) };
  };

  const toggle = (row: SpaceTx, part?: TxSplit) => {
    const partPick = part && !anchorIsExpense ? part.id : undefined;
    const creditPartPick = part && anchorIsExpense ? part.id : undefined;
    const key = keyOf(row.id, partPick, creditPartPick);
    setError(null);
    if (picks.some((pick) => pick.key === key)) {
      setPicks(picks.filter((pick) => pick.key !== key));
      return;
    }
    const { own, max } = pairOf(row, part);
    const prefill = Math.max(0, Math.min(own, budget()));
    setPicks([...picks, { key, row, partId: partPick, creditPartId: creditPartPick, maxCents: max, text: toText(prefill) }]);
  };

  const setText = (key: string, text: string) => {
    setError(null);
    setPicks(picks.map((pick) => (pick.key === key ? { ...pick, text } : pick)));
  };

  // once, when the rows are there: what the typed transaction holds so far, with today's ceilings
  const seeded = useRef(false);
  useEffect(() => {
    if (seeded.current || !initial?.length || !allTxs || !tx) return;
    seeded.current = true;
    setPicks(
      initial.flatMap((held) => {
        const row = allTxs.find((r) => r.id === held.key.split('|')[0]);
        if (!row) return [];
        const part = (row.splits ?? []).find((p) => p.id && p.id === (held.partId ?? held.creditPartId));
        return [{ key: held.key, row, partId: held.partId, creditPartId: held.creditPartId, maxCents: pairOf(row, part).max, text: toText(held.cents) }];
      }),
    );
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [initial, allTxs, tx]);

  const impact = useMemo((): ImpactSide[] | null => {
    if (!tx || picks.length === 0) return null;
    const nameOf: NameOf = (catId) => catName(cats.byId(catId), t);
    const valid = picks.filter((pick) => centsOf(pick) > 0 && centsOf(pick) <= pick.maxCents);
    if (valid.length === 0) return null;
    const total = valid.reduce((sum, pick) => sum + centsOf(pick), 0);
    const anchorSide = anchorIsExpense ? expenseImpact(tx, partId, total, nameOf) : creditImpact(tx, partId, total, allTxs ?? [], nameOf);
    const others = valid.map((pick) =>
      anchorIsExpense ? creditImpact(pick.row, pick.creditPartId, centsOf(pick), allTxs ?? [], nameOf) : expenseImpact(pick.row, pick.partId, centsOf(pick), nameOf),
    );
    return [anchorSide, ...others].filter((side) => side.lines.length > 0);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [tx, picks, anchorIsExpense, partId, allTxs, cats]);

  const confirm = () => {
    if (!tx || picks.length === 0) return;
    for (const pick of picks) {
      const cents = centsOf(pick);
      // an over-the-ceiling amount interrupts the save and says the max: silently shrinking to the clamp taught nothing (#233)
      if (cents <= 0) {
        setError({ key: pick.key, text: t('form.needAmount') });
        return;
      }
      if (cents > pick.maxCents) {
        setError({ key: pick.key, text: t('reimb.maxError', { max: fmtCents(pick.maxCents, tx.currency, lang) }) });
        return;
      }
    }
    if (pickedCents > anchor.open) {
      setError({ text: t('reimb.totalError', { max: fmtCents(anchor.open, tx.currency, lang) }) });
      return;
    }
    const picked = picks.map((pick) => ({ key: pick.key, row: pick.row, partId: pick.partId, creditPartId: pick.creditPartId, cents: centsOf(pick) }));
    setPicks([]);
    onConfirm(picked);
  };

  const money = (cents: number) => fmtCents(cents, tx?.currency ?? 'EUR', lang);

  const pickable = (row: SpaceTx, part: TxSplit | undefined, testId: string, withInput: boolean, face: React.ReactNode) => {
    const key = keyOf(row.id, part && !anchorIsExpense ? part.id : undefined, part && anchorIsExpense ? part.id : undefined);
    const pick = picks.find((p) => p.key === key);
    const picked = !!pick;
    return (
      <div key={testId} data-testid={testId} data-picked={picked ? '' : undefined} className={picked ? 'bg-accent/5' : ''}>
        <div className="flex items-stretch">
          <button
            type="button"
            aria-pressed={picked}
            data-testid={`${testId}-check`}
            onClick={() => toggle(row, part)}
            className="m-tap flex w-9 shrink-0 items-center justify-center border-none bg-transparent"
          >
            <Icon name={picked ? 'check-circle' : 'checkbox-blank-circle-outline'} size={20} color={picked ? 'var(--m-accent)' : 'var(--m-ink-4)'} />
          </button>
          <div className="min-w-0 flex-1">{face}</div>
        </div>
        {pick && withInput && (
          <div className="flex items-center gap-2 pb-2 pl-9">
            <input
              data-testid={amountTestId(key)}
              value={pick.text}
              onChange={(e) => setText(key, e.target.value)}
              aria-invalid={error?.key === key}
              inputMode="decimal"
              placeholder={t('reimb.amountLabel')}
              className={`h-9 w-32 rounded-input border border-line bg-surface px-3 text-[14px] text-ink outline-none${blockerRing(error?.key === key)}`}
            />
            <span className="text-[11px] text-ink-4">{t('reimb.ofMax', { max: money(pick.maxCents) })}</span>
          </div>
        )}
      </div>
    );
  };

  const rowFor = (row: SpaceTx, testId: string, segment: 'suggested' | 'list') => {
    const withInput = segment === (suggestedIds.has(row.id) ? 'suggested' : 'list');
    // a split row offers its PARTS, never the root (#197)
    const parts = (row.splits ?? []).map((part, idx) => ({ part, idx })).filter((e) => e.part.catId !== REIMBURSED_ID);
    if (parts.length > 1) {
      const sign = row.amountCents < 0 ? -1 : 1;
      return (
        <div key={`${testId}-${row.id}`}>
          {parts.map((e, ordinal) => {
            const open = anchorIsExpense ? creditPartOpen(row, e.part) : partOpenCents(row, e.part);
            if (open <= 0) return null;
            return pickable(
              row,
              e.part,
              `${testId}-${row.id}-part-${e.idx}`,
              withInput,
              <TxPartRow tx={row} part={e.part} index={ordinal} showDate amountText={money(sign * open)} onClick={() => toggle(row, e.part)} highlight={query} />,
            );
          })}
        </div>
      );
    }
    return (
      <Fragment key={`${testId}-${row.id}`}>
        {pickable(
          row,
          undefined,
          `${testId}-${row.id}`,
          withInput,
          <TxRow
            tx={row}
            showDate
            hideUnreviewed
            highlight={query}
            amountOverrideCents={row.amountCents > 0 ? openValueOf(row) : -openValueOf(row)}
            onClick={() => toggle(row)}
          />,
        )}
      </Fragment>
    );
  };

  const left = Math.max(0, anchor.capacity - anchor.before - pickedCents);
  const segments = [
    { id: 'before', value: anchor.before, color: 'var(--m-ink-4)' },
    ...picks.map((pick, i) => ({ id: pick.key, value: centsOf(pick), color: pickColor(i) })),
    { id: 'open', value: left, color: 'var(--m-line)' },
  ];

  return (
    <div className="m-fade flex h-full flex-col" data-testid="screen-reimb-link">
      <AppBar
        title={t(anchorIsExpense ? 'reimb.link' : 'reimb.linkOut')}
        leading={
          <IconButton label={t('action.back')} testId="reimb-link-back" onClick={onBack}>
            <Icon name="chevron-left" size={24} />
          </IconButton>
        }
      />
      {tx && (
        <div className="shrink-0 border-b border-line-2 px-5 pb-2 text-[12px] text-ink-3" data-testid="reimb-link-anchor">
          {cleanBankText(tx.merchant)} · {fmtCents(tx.amountCents, tx.currency, lang, { sign: true })}
        </div>
      )}
      {/* the field sits above the scroller: the sticky+translate version left its slot as a void (#273) */}
      <CollapsingSearch offset={searchOffset}>
        <div className="px-5 pt-1 pb-2">
          <SearchField
            testId="reimb-link-search"
            value={query}
            onChange={(value) => {
              setQuery(value);
              setShownRows(PAGE_ROWS);
            }}
            placeholder={t('tx.searchPlaceholder')}
          />
        </div>
      </CollapsingSearch>
      <div ref={scrollerRef} className="min-h-0 flex-1 overflow-y-auto px-5 pb-4" onScroll={onListScroll}>
        {!query && suggested.length > 0 && (
          <>
            <div className="m-cap mt-2 mb-1 flex items-center gap-1.5 px-1 text-accent-deep">
              <Icon name="lightbulb-outline" size={13} />
              {t('reimb.suggested')}
            </div>
            <div className="mb-3 divide-y divide-line-2 overflow-hidden rounded-card border border-accent/40 bg-surface px-1" data-testid="reimb-link-suggested">
              {suggested.map(({ tx: row }) => rowFor(row, 'reimb-suggest', 'suggested'))}
            </div>
          </>
        )}

        <div className="m-cap mt-2 mb-1 flex items-center gap-2 px-1">
          <span>{t(anchorIsExpense ? 'reimb.allCredits' : 'reimb.allExpenses')}</span>
          {tx && listed.length > 0 && <JumpToDateButton date={tx.date} onJump={() => jump(tx.date)} testId="reimb-link-jump" />}
        </div>
        <div className="divide-y divide-line-2 overflow-hidden rounded-card border border-line bg-surface px-1" data-testid="reimb-link-list">
          {shownList.map((row) => (
            <div key={row.id} data-jump-id={row.id} className={`transition-colors ${jumpedId === row.id ? 'bg-accent-soft' : ''}`}>
              {rowFor(row, 'reimb-pick', 'list')}
            </div>
          ))}
          {listed.length === 0 && <div className="px-1 py-4 text-center text-[12px] text-ink-4">—</div>}
        </div>
        {listed.length > shownList.length && (
          <MoreRows rootRef={scrollerRef} remaining={listed.length - shownList.length} onMore={showMore} testId="reimb-link-more" />
        )}
      </div>

      {tx && (
        <div className="shrink-0 border-t border-line-2 bg-bg px-5 pt-3 pb-[max(16px,env(safe-area-inset-bottom))]" data-testid="reimb-footer">
          <StackedBar segments={segments} height={10} />
          <div className="mt-1.5 flex flex-wrap items-baseline gap-x-3 text-[11px] text-ink-4" data-testid="reimb-footer-line">
            {anchor.before > 0 && <span>{t('reimb.linkedBefore', { amount: money(anchor.before) })}</span>}
            {picks.length > 0 && <span className="font-medium text-accent-deep">{t('reimb.pickedCount', { n: picks.length, amount: money(pickedCents) })}</span>}
            <span>{t(anchorIsExpense ? 'reimb.stillOpen' : 'reimb.stillToGive', { amount: money(left) })}</span>
          </div>
          <FormBlockerNote show={!!error} text={error?.text ?? ''} testId="reimb-amount-error" />
          {impact && (
            <button
              type="button"
              data-testid="reimb-impact-toggle"
              aria-expanded={impactOpen}
              onClick={() => setImpactOpen((v) => !v)}
              className="m-tap mt-2 flex w-full items-center gap-2 border-none bg-transparent px-1 py-1 text-left"
            >
              <span className="text-[11px] font-medium uppercase tracking-wide text-ink-4">{t('reimb.impactCaption')}</span>
              <span className="min-w-0 flex-1 truncate text-[11px] text-ink-4">{t('reimb.impactCount', { n: impact.length })}</span>
              <Icon name={impactOpen ? 'chevron-up' : 'chevron-down'} size={16} color="var(--m-ink-4)" />
            </button>
          )}
          {impact && impactOpen && (
            <div className="flex max-h-44 flex-col gap-1.5 overflow-y-auto" data-testid="reimb-impact" data-sheet-no-drag>
              {impact.map((side) => (
                <div key={side.title} className="rounded-input border border-line-2 bg-surface px-3 py-2" data-testid="reimb-impact-side">
                  <p className="truncate pb-1 text-[11px] font-medium text-ink-3">{side.title}</p>
                  <div className="grid grid-cols-[auto_minmax(0,1fr)_auto_auto_auto] items-center gap-x-2 gap-y-1">
                    {side.lines.map((line) => {
                      const cat = cats.byId(line.catId);
                      const color = cat.color ?? cats.byId(cat.parentId ?? '').color ?? 'var(--m-ink-3)';
                      return (
                        <Fragment key={line.catId}>
                          <span className="flex h-6 w-6 items-center justify-center rounded-full" style={{ background: `color-mix(in srgb, ${color} 14%, transparent)` }}>
                            <Icon name={cat.icon} size={13} color={color} />
                          </span>
                          <span className="min-w-0 truncate text-[12.5px] text-ink-2" data-testid="reimb-impact-line">
                            {catName(cat, t)}
                          </span>
                          <span className="m-num text-right text-[12.5px] text-ink-4">{money(line.before)}</span>
                          <span className="text-[12px] text-ink-4"> → </span>
                          <span className="m-num text-right text-[12.5px] font-medium text-ink">{money(line.after)}</span>
                        </Fragment>
                      );
                    })}
                  </div>
                </div>
              ))}
            </div>
          )}
          <Button className="mt-2 w-full" data-testid="reimb-save" disabled={picks.length === 0} onClick={confirm}>
            {picks.length > 0 ? t('reimb.pickedCount', { n: picks.length, amount: money(pickedCents) }) : t('reimb.nothingPicked')}
          </Button>
        </div>
      )}
    </div>
  );
}
