import { Fragment, useMemo, useState } from 'react';
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
import { REIMBURSED_ID, UNCATEGORIZED_ID } from '@/domain/categories';
import type { TxSplit } from '@/db/types';

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

/** #233 r3: the preview diffs the REAL settlement engine — settledCats
 *  before vs after — so spreads, earmarks and the claimant carve-out
 *  all preview exactly what the save would write. Module for S3776. */
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
  // read in the after-partition's order, the bookkeeping slice last
  const order = [...after.filter((slice) => slice.catId !== REIMBURSED_ID).map((slice) => slice.catId), REIMBURSED_ID];
  ids.sort((a, b) => order.indexOf(a) - order.indexOf(b));
  return ids
    .map((catId) => ({ catId, before: at(before, catId), after: at(after, catId) }))
    .filter((line) => line.before !== line.after);
}

/** the expense's (or its part's) category shift when `addCents` more is reimbursed */
function expenseImpact(expense: SpaceTx, partId: string | undefined, addCents: number, nameOf: NameOf): ImpactSide {
  const part = partId ? (expense.splits ?? []).find((p) => p.id === partId) : undefined;
  const subject = part ? { amountCents: part.amountCents, catId: part.catId, cats: part.cats } : expense;
  const already = (expense.reimbursements ?? [])
    .filter((link) => (part ? link.partId === partId : true))
    .reduce((sum, link) => sum + link.amountCents, 0);
  return { title: cleanBankText(expense.merchant), lines: impactLinesFor(subject, already, already + addCents, nameOf) };
}

/** the credit's (or its part's) category shift when it gives `addCents` more */
function creditImpact(credit: SpaceTx, creditPartId: string | undefined, addCents: number, allTxs: SpaceTx[], nameOf: NameOf): ImpactSide {
  const part = creditPartId ? (credit.splits ?? []).find((p) => p.id === creditPartId) : undefined;
  const given = part && creditPartId ? creditPartGivenCents(allTxs, credit.id, creditPartId) : givenCents(allTxs, credit.id);
  // the credit self-files as Reimbursed exactly like the save would
  const selfFiles = !part && !isReimbContainer(credit) && (!credit.catId || credit.catId === UNCATEGORIZED_ID || credit.needsReview === 1);
  const subject = part ? { amountCents: part.amountCents, catId: part.catId, cats: part.cats } : { ...credit, catId: selfFiles ? REIMBURSED_ID : credit.catId };
  return { title: cleanBankText(credit.merchant), lines: impactLinesFor(subject, given, given + addCents, nameOf) };
}

/** one picked counterpart: the row (a part of it when the ids say so), its ceiling and the typed amount */
interface Pick {
  key: string;
  row: SpaceTx;
  partId?: string;
  creditPartId?: string;
  /** the pair's honest ceiling - the save refuses more, never shrinks silently (#233) */
  maxCents: number;
  text: string;
}

const keyOf = (rowId: string, partId?: string, creditPartId?: string): string => `${rowId}|${partId ?? ''}|${creditPartId ?? ''}`;
const amountTestId = (key: string): string => `reimb-amount-${key.split('|').filter(Boolean).join('-')}`;
const centsOf = (pick: Pick): number => Math.max(0, parseCents(pick.text) ?? 0);

/** the picks' shades on the composition bar: the accent, lighter with every next pick */
const pickColor = (i: number): string => `color-mix(in srgb, var(--m-accent) ${Math.max(35, 100 - i * 18)}%, white)`;

/**
 * Full-screen counterpart picker for reimbursement links (user redesign
 * 2026-07-28, replaces the cramped sheet): searchable like the main
 * transactions list (title + amount, with highlight), with a "suggested"
 * segment on top — the 1–2 rows scoring highest on timing, P2P repayment
 * wording, reimbursement bookkeeping and size.
 *
 * 2026-10-06 (user): several at once. A tap picks a row and opens its
 * amount under it, prefilled with what the pair can take - the row's
 * reimbursement earmark (expected / received slice) or open value, within
 * what the anchor has left after the earlier picks; the pinned footer
 * draws the anchor's composition (linked before, each pick, still open),
 * previews the category shift and links every pick in one gesture.
 */
export function ReimburseLinkScreen() {
  const { t, lang } = useLang();
  const navigate = useNavigate();
  const { txId } = useParams({ strict: false }) as { txId: string };
  // #126 r5: opened from a part page → the link targets that part
  const { part: partId } = useSearch({ strict: false }) as { part?: string };
  const allTxs = useSpaceTransactions();
  const tx = useMemo(() => allTxs?.find((row) => row.id === txId), [allTxs, txId]);
  const { linkMany, giveableCents } = useReimburseLinks(allTxs);

  const [query, setQuery] = useState('');
  /** the category impact starts folded (user 2026-10-07): open, it ate half the screen under the list */
  const [impactOpen, setImpactOpen] = useState(false);
  const [picks, setPicks] = useState<Pick[]>([]);
  const [error, setError] = useState<{ key?: string; text: string } | null>(null);
  const cats = useCategories();

  // the search bar rides along — #273: through the shared GLIDING
  // collapse (deliberate up-travel rule + measured max-height, so the
  // list flows into the freed space instead of jumping past a void)
  const { offset: searchOffset, onListScroll } = useSearchCollapse(56);

  const anchorIsExpense = (tx?.amountCents ?? 0) < 0;
  const anchorPart = useMemo(() => (tx && partId ? (tx.splits ?? []).find((p) => p.id === partId) : undefined), [tx, partId]);
  const givenOf = (id: string) => givenCents(allTxs ?? [], id);

  // #197: what ONE part of a split credit can still give — its own
  // magnitude minus the links naming it, never more than the whole
  // credit has left
  const creditPartOpen = (row: SpaceTx, part: TxSplit): number =>
    Math.min(
      giveableCents(row),
      Math.max(0, Math.abs(part.amountCents) - (part.id ? creditPartGivenCents(allTxs ?? [], row.id, part.id) : 0)),
    );

  // the anchor's capacity: what it is worth, what was linked before, and
  // what it can still take / give - a part anchor answers for itself
  // (2026-10-06: it used to borrow the container's numbers)
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

  // an expense looks at credits with value left; a credit looks at
  // expenses still open — the same space-scoped pools the section used
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

  const listed = useMemo(() => {
    const matched = filterTxs(candidates, { query });
    return [...matched].sort((a, b) => b.date.localeCompare(a.date)).slice(0, 100);
  }, [candidates, query]);

  const openValueOf = (row: SpaceTx): number => (row.amountCents > 0 ? giveableCents(row) : remainingCents(row));
  const pickedCents = picks.reduce((sum, pick) => sum + centsOf(pick), 0);

  /** what the anchor can still take for ONE more pick: its need first, then whatever is still open */
  const budget = (): number => {
    const need = Math.max(0, anchor.need - pickedCents);
    return need > 0 ? need : Math.max(0, anchor.open - pickedCents);
  };

  /** the row's own value for this pair and the pair's ceiling */
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

  // #233 r2 (user): the category impact of the typed amounts, live while
  // they are saveable values — the anchor once over every pick, each
  // counterpart for its own
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
      // #233 (user): an over-the-ceiling amount INTERRUPTS the save and
      // says the max — silently shrinking to the clamp taught nothing
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
    // the part target lives on the EXPENSE side's split — from the
    // expense anchor it rides the ?part param; the CREDIT part rides
    // the pick (expense anchor) or the ?part param (credit anchor's
    // own part page, #197)
    const entries: LinkEntry[] = picks.map((pick) =>
      anchorIsExpense
        ? { expense: tx, credit: pick.row, cents: centsOf(pick), partId, creditPartId: pick.creditPartId }
        : { expense: pick.row, credit: tx, cents: centsOf(pick), partId: pick.partId, creditPartId: partId },
    );
    linkMany(entries);
    setPicks([]);
    // REPLACE, not back: pressing back on the detail afterwards must not
    // resurface a stale picker — a part-born link returns to its part
    void navigate({ to: '/transactions/$txId', params: { txId }, search: partId ? { part: partId } : {}, replace: true });
  };

  const money = (cents: number) => fmtCents(cents, tx?.currency ?? 'EUR', lang);

  /** a pickable row: the check, the row itself, and under a picked one its amount (once, in one segment) */
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
    // #197 (both directions): a split row offers its PARTS, never the
    // root — expenses their still-expected parts, credits their
    // still-giveable ones
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
          <IconButton label={t('action.back')} testId="reimb-link-back" onClick={() => window.history.back()}>
            <Icon name="chevron-left" size={24} />
          </IconButton>
        }
      />
      {/* the origin transaction stays PINNED above the list (user
          request 2026-07-31) — the one fact the whole screen is about */}
      {tx && (
        <div className="shrink-0 border-b border-line-2 px-5 pb-2 text-[12px] text-ink-3" data-testid="reimb-link-anchor">
          {cleanBankText(tx.merchant)} · {fmtCents(tx.amountCents, tx.currency, lang, { sign: true })}
        </div>
      )}
      {/* #273: the field lives ABOVE the scroller and collapses smoothly —
          the sticky+translate version left its slot as a void */}
      <CollapsingSearch offset={searchOffset}>
        <div className="px-5 pt-1 pb-2">
          <SearchField testId="reimb-link-search" value={query} onChange={setQuery} placeholder={t('tx.searchPlaceholder')} />
        </div>
      </CollapsingSearch>
      <div className="min-h-0 flex-1 overflow-y-auto px-5 pb-4" onScroll={onListScroll}>
        {/* the smart segment stands down while the user searches */}
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

        <div className="m-cap mt-2 mb-1 px-1">{t(anchorIsExpense ? 'reimb.allCredits' : 'reimb.allExpenses')}</div>
        <div className="divide-y divide-line-2 overflow-hidden rounded-card border border-line bg-surface px-1" data-testid="reimb-link-list">
          {listed.map((row) => rowFor(row, 'reimb-pick', 'list'))}
          {listed.length === 0 && <div className="px-1 py-4 text-center text-[12px] text-ink-4">—</div>}
        </div>
      </div>

      {/* the pinned footer: the anchor's composition, the category shift, the one save for every pick */}
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
                  {/* #233 r3 (user): icon + name, amounts in aligned
                      columns — the whole diff readable at a glance */}
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
