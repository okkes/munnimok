import { useEffect, useMemo, useState } from 'react';
import { useQuery } from '@/db/useQuery';
import { useNavigate, useParams } from '@tanstack/react-router';
import { LOCALES, useLang } from '@/i18n';
import { useData } from '@/app/data';
import { useCanEdit } from '@/app/useCanEdit';
import { useEvents } from '@/application/events';
import { ReadOnlyNote } from '@/features/spaces/ReadOnlyNote';
import { useSpaceTransactions } from '@/application/transactions';
import { eventCategoryBreakdown, eventNetText, eventPerDayCents, eventSubcategoryBreakdown, eventTotals, suggestableTxs } from '@/domain/events';
import { catName, useCategories } from '@/features/categories/useCategories';
import { useDisplayMoney } from '@/features/currency/useDisplayMoney';
import { AppBar, IconButton } from '@/ui/AppBar';
import { Button } from '@/ui/Button';
import { Icon } from '@/ui/Icon';
import { Chip, ProgressBar } from '@/ui/primitives';
import { TxRow } from '@/ui/TxRow';
import { TxPartRow } from '@/ui/TxPartRow';
import { EventFormSheet, eventPicture, eventPictureStyle } from './EventsScreen';
import { SplitEventSummary } from '@/features/splits/SplitEventSummary';
import { REIMBURSED_ID } from '@/domain/categories';
import { partNetCents } from '@/domain/reimbursement';
import type { EventRow, TransactionRow, TxSplit } from '@/db/types';

/** a row's pickable parts keyed by their ORIGINAL splits index: legacy flat spreads may lack part ids */
export function partEntries(tx: TransactionRow): { part: TxSplit; idx: number }[] {
  return (tx.splits ?? []).map((part, idx) => ({ part, idx })).filter((e) => e.part.catId !== REIMBURSED_ID);
}
export const partPickKey = (txId: string, idx: number): string => `${txId}#${idx}`;

export interface EventListUnit<T> {
  key: string;
  date: string;
  rows: T[];
}

type UnitTx = Pick<TransactionRow, 'id' | 'date' | 'reimbursements' | 'splits'>;

// #493: an expense and the credits that paid it back are one story: they stand together, at the expense's day,
// wherever the credit's own day falls. A split shows its parts and is never the head of one
export function eventListUnits<T extends UnitTx>(list: readonly T[]): EventListUnit<T>[] {
  const byId = new Map(list.map((tx) => [tx.id, tx]));
  const member = new Set<string>();
  const creditsOf = new Map<string, T[]>();
  for (const tx of list) {
    if (member.has(tx.id) || (tx.splits ?? []).filter((s) => s.catId !== REIMBURSED_ID).length > 1) continue;
    const credits = new Set<T>();
    for (const link of tx.reimbursements ?? []) {
      const credit = byId.get(link.txId);
      if (credit && credit.id !== tx.id && !member.has(credit.id) && !creditsOf.has(credit.id)) credits.add(credit);
    }
    if (credits.size === 0) continue;
    creditsOf.set(tx.id, [...credits]);
    for (const credit of credits) member.add(credit.id);
  }
  return list.filter((tx) => !member.has(tx.id)).map((tx) => ({ key: tx.id, date: tx.date, rows: [tx, ...(creditsOf.get(tx.id) ?? [])] }));
}

// the fold survives the detour into a transaction and back; a reload starts folded again
const linkedApartByEvent = new Map<string, boolean>();

/** the units under their day, in the order they came */
export function unitsByDay<T>(units: readonly EventListUnit<T>[]): [string, EventListUnit<T>[]][] {
  const days = new Map<string, EventListUnit<T>[]>();
  for (const unit of units) days.set(unit.date, [...(days.get(unit.date) ?? []), unit]);
  return [...days.entries()];
}
export function suggestionKeysOf(txs: readonly TransactionRow[] | undefined): string[] {
  return (txs ?? []).flatMap((tx) => {
    const entries = partEntries(tx);
    if (entries.length > 1) return entries.filter((e) => !e.part.eventId).map((e) => partPickKey(tx.id, e.idx));
    return [tx.id];
  });
}

export function EventDetailScreen() {
  const { t, lang } = useLang();
  const navigate = useNavigate();
  const { store, spaceId } = useData();
  const { eventId } = useParams({ strict: false }) as { eventId: string };
  const events = useEvents();
  const txs = useSpaceTransactions();
  const cats = useCategories();
  const space = useQuery(store, async () => store.get('space', spaceId), [spaceId]);
  const [formInitial, setFormInitial] = useState<EventRow | 'new' | null>(null);
  const canEdit = useCanEdit(); // #505
  const [drillMain, setDrillMain] = useState<string | null>(null);
  const [drillSub, setDrillSub] = useState<string | null>(null);
  const [linkedApart, setLinkedApart] = useState(() => linkedApartByEvent.get(eventId) ?? false);

  const event = events?.find((e) => e.id === eventId);
  // deleted here or on another device: leave the orphaned detail
  useEffect(() => {
    if (events && !event) void navigate({ to: '/events', replace: true });
  }, [events, event, navigate]);
  const currency = space?.currency ?? 'EUR';
  const { fmt } = useDisplayMoney();
  const money = (cents: number) => fmt(cents, currency);

  // #493: a credit nets out what it paid back, struck through like the expense it settled
  const givenByCredit = useMemo(() => {
    const map = new Map<string, number>();
    for (const item of txs ?? []) {
      for (const link of item.reimbursements ?? []) map.set(link.txId, (map.get(link.txId) ?? 0) + link.amountCents);
    }
    return map;
  }, [txs]);

  const view = useMemo(() => {
    if (!event || !txs) return undefined;
    // #143: membership is per-slice — a row belongs when it (or any of
    // its parts) carries the event
    const list = txs
      .filter(
        (tx) =>
          tx.deleted === 0 &&
          (tx.eventId === event.id || (tx.splits ?? []).some((s) => s.catId !== REIMBURSED_ID && s.eventId === event.id)),
      )
      .sort((a, b) => b.date.localeCompare(a.date));
    // #448: what went out AND what came in - the headline is the net
    const totals = eventTotals(txs, event.id);
    return {
      list,
      totals,
      perDay: eventPerDayCents(totals.spentCents, event.from, event.to),
      breakdown: eventCategoryBreakdown(txs, event.id, cats),
      suggestions: suggestableTxs(txs, event.id, event.from, event.to),
    };
  }, [event, txs, cats]);

  if (!event || !view) return <div className="h-full" data-testid="screen-event-detail" />;

  const filteredList = view.list.filter((tx) => {
    if (!drillMain) return true;
    const cat = cats.byId(tx.catId);
    if (drillSub) return cat.id === drillSub;
    return (cat.parentId ?? cat.id) === drillMain;
  });

  const fmtDate = (iso: string) => new Date(iso).toLocaleDateString(LOCALES[lang], { day: 'numeric', month: 'short', year: 'numeric' });
  const fmtDay = (iso: string) => new Intl.DateTimeFormat(LOCALES[lang], { weekday: 'short', day: 'numeric', month: 'short' }).format(new Date(iso));
  const units = eventListUnits(filteredList);
  const hasLinked = units.some((unit) => unit.rows.length > 1);
  const days = unitsByDay(units);
  const toggleLinkedApart = () => {
    linkedApartByEvent.set(eventId, !linkedApart);
    setLinkedApart(!linkedApart);
  };
  const linkedNoteOf = (n: number) => (n === 1 ? t('events.linkedOne') : t('events.linkedMany', { n }));
  const canFindMore = canEdit && view.suggestions.length > 0 && view.list.length > 0;
  // a row in a linked unit names its own day when that is not the day it stands under
  const renderTx = (tx: (typeof filteredList)[number], showDate: boolean, linkedNote?: string) => {
    const entries = partEntries(tx);
    if (entries.length > 1) {
      const sign = tx.amountCents < 0 ? -1 : 1;
      return entries
        .map((e, ordinal) => ({ ...e, ordinal }))
        .filter((e) => (e.part.eventId ?? tx.eventId) === event.id)
        .map((e) => (
          <TxPartRow
            key={partPickKey(tx.id, e.idx)}
            tx={tx}
            part={e.part}
            index={e.ordinal}
            amountText={money(sign * partNetCents(e.part))}
            onClick={() => void navigate({ to: '/transactions/$txId', params: { txId: tx.id }, search: { part: e.part.id } })}
            showDate={showDate}
          />
        ));
    }
    return (
      <TxRow
        key={tx.id}
        tx={tx}
        showDate={showDate}
        linkedNote={linkedNote}
        givenCents={givenByCredit.get(tx.id) ?? 0}
        onClick={() => void navigate({ to: '/transactions/$txId', params: { txId: tx.id } })}
      />
    );
  };

  return (
    <div className="m-fade flex h-full flex-col" data-testid="screen-event-detail">
      <AppBar
        title={event.name}
        leading={
          <IconButton label={t('action.back')} testId="eventdetail-back" onClick={() => window.history.back()}>
            <Icon name="arrow-left" size={22} />
          </IconButton>
        }
        trailing={
          canEdit && (
            <IconButton label={t('events.edit')} testId="eventdetail-edit" onClick={() => setFormInitial(event)}>
              <Icon name="pencil-outline" size={20} />
            </IconButton>
          )
        }
      />
      <div className="min-h-0 flex-1 overflow-y-auto px-5 pb-6">
        <ReadOnlyNote className="mb-3" testId="eventdetail-readonly-note" />
        <div className="overflow-hidden rounded-card border border-line bg-surface" data-testid="eventdetail-hero">
          <div className="relative h-36 w-full">
            <img src={eventPicture(event)} alt="" className="h-full w-full object-cover" style={eventPictureStyle(event)} />
            <span className="absolute right-3 bottom-2 rounded-lg bg-black/45 px-2.5 py-1 backdrop-blur-sm">
              <span className="m-num text-[20px] font-semibold text-white" data-testid="eventdetail-total">
                {eventNetText(view.totals.netCents, currency, fmt)}
              </span>
            </span>
          </div>
          <div className="px-4 py-3">
            <span className="block text-[12px] text-ink-3">
              {event.from && event.to && `${fmtDate(event.from)} – ${fmtDate(event.to)}`}
              {view.perDay !== null && ` · ${t('events.perDay', { amount: money(view.perDay) })}`}
            </span>
            {/* #448: once money came in the headline is a net; show out and in so a plus reads as a surplus */}
            {view.totals.receivedCents > 0 && (
              <span className="mt-0.5 block text-[12px] text-ink-3" data-testid="eventdetail-flows">
                {t('events.spentReceived', { spent: money(view.totals.spentCents), received: money(view.totals.receivedCents) })}
              </span>
            )}
            {event.note && (
              <p className="mt-1 text-[13px] text-ink-2" data-testid="eventdetail-note">
                {event.note}
              </p>
            )}
            {!!event.budgetCents && (
              <>
                <ProgressBar
                  className="mt-2"
                  value={Math.max(view.totals.netCents, 0) / event.budgetCents}
                  tone={view.totals.netCents > event.budgetCents ? 'negative' : 'accent'}
                />
                <div className="mt-1.5 text-[11px] text-ink-3">{t('events.estimateOf', { amount: money(event.budgetCents) })}</div>
              </>
            )}
          </div>
        </div>

        <SplitEventSummary eventId={eventId} />

        {/* #379: loud only while nothing is attached; afterwards a quiet "find more" sits with the payments header */}
        {canEdit && view.suggestions.length > 0 && view.list.length === 0 && (
          <div className="mt-3 flex items-center gap-3 rounded-card border border-accent bg-accent-soft/40 px-4 py-3" data-testid="eventdetail-suggest">
            <Icon name="creation" size={17} color="var(--m-accent-deep)" />
            <span className="min-w-0 flex-1 text-[13px] text-ink-2">
              {t('events.suggestAttach', { n: view.suggestions.length })}
            </span>
            <Button
              size="sm"
              data-testid="eventdetail-attach-all"
              onClick={() => void navigate({ to: '/events/$eventId/attach', params: { eventId: event.id } })}
            >
              {t('events.reviewSuggested')}
            </Button>
          </div>
        )}

        {view.breakdown.length > 0 && (
          <>
            <div className="m-cap mt-5 mb-1 px-1">{t('screen.categories')}</div>
            <div className="rounded-card border border-line bg-surface px-4 py-1" data-testid="eventdetail-cats">
              {view.breakdown.map(({ catId, totalCents }) => {
                const cat = cats.byId(catId);
                const active = drillMain === catId;
                const subs = active ? eventSubcategoryBreakdown(txs ?? [], event.id, cats, catId) : [];
                return (
                  <div key={catId} className="border-b border-line-2 last:border-0">
                    <button
                      data-testid={`eventdetail-cat-${catId}`}
                      onClick={() => {
                        setDrillMain(active ? null : catId);
                        setDrillSub(null);
                      }}
                      className={`m-tap flex w-full items-center gap-3 border-none bg-transparent py-2.5 text-left ${
                        active ? 'text-accent-deep' : ''
                      }`}
                    >
                      <Icon name={cat.icon} size={17} color={cat.color ?? 'var(--m-ink-3)'} />
                      <span className="min-w-0 flex-1 truncate text-[14px] text-ink">{catName(cat, t)}</span>
                      <span className="m-num text-[14px] font-semibold text-ink">{money(totalCents)}</span>
                      <Icon name={active ? 'chevron-up' : 'chevron-down'} size={15} color="var(--m-ink-4)" />
                    </button>
                    {active &&
                      subs.map((sub) => {
                        const subCat = cats.byId(sub.catId);
                        const subActive = drillSub === sub.catId;
                        return (
                          <button
                            key={sub.catId}
                            data-testid={`eventdetail-subcat-${sub.catId}`}
                            onClick={() => setDrillSub(subActive ? null : sub.catId)}
                            className={`m-tap flex w-full items-center gap-3 border-none bg-transparent py-2 pl-7 text-left ${
                              subActive ? 'text-accent-deep' : ''
                            }`}
                          >
                            <Icon name={subCat.icon} size={15} color={subCat.color ?? cat.color ?? 'var(--m-ink-4)'} />
                            <span className="min-w-0 flex-1 truncate text-[13px] text-ink-2">{catName(subCat, t)}</span>
                            <span className="m-num text-[13px] text-ink-2">{money(sub.totalCents)}</span>
                            {subActive && <Icon name="check" size={14} color="var(--m-accent)" />}
                          </button>
                        );
                      })}
                  </div>
                );
              })}
            </div>
          </>
        )}

        <div className="m-cap mt-5 mb-1 flex items-center gap-2 px-1">
          <span>
            {t('overview.payments')} · {linkedApart ? filteredList.length : units.length}
          </span>
          {drillMain && (
            <button
              data-testid="eventdetail-filter-clear"
              onClick={() => {
                setDrillMain(null);
                setDrillSub(null);
              }}
              className="m-tap flex items-center gap-1 rounded-full border border-line bg-surface px-2 py-0.5 text-[11px] normal-case"
            >
              {catName(cats.byId(drillSub ?? drillMain), t)}
              <Icon name="close" size={11} />
            </button>
          )}
          {canEdit && (
            <button
              data-testid="eventdetail-add"
              onClick={() => void navigate({ to: '/events/$eventId/add', params: { eventId: event.id } })}
              className="m-tap ml-auto flex items-center gap-1 rounded-full border border-line bg-surface px-2.5 py-1 text-[11px] font-semibold text-accent-deep normal-case"
            >
              <Icon name="plus" size={13} />
              {t('events.addTxs')}
            </button>
          )}
        </div>
        {/* #493: an offer, not a second action beside Add: payments of these days that are not on the event yet */}
        {canFindMore && (
          <button
            data-testid="eventdetail-find-more"
            onClick={() => void navigate({ to: '/events/$eventId/attach', params: { eventId: event.id } })}
            className="m-tap mb-1 flex w-full items-center gap-2.5 rounded-card border border-dashed border-line bg-surface px-3 py-2.5 text-left"
          >
            <Icon name="magnify" size={16} color="var(--m-accent-deep)" />
            <span className="min-w-0 flex-1 text-[12px] text-ink-2">
              {view.suggestions.length === 1 ? t('events.findMoreOne') : t('events.findMoreMany', { n: view.suggestions.length })}
            </span>
            <Icon name="chevron-right" size={15} color="var(--m-ink-4)" />
          </button>
        )}
        {/* #493: an expense stands for the payments that paid it back — where the money went; this shows them all */}
        {hasLinked && (
          <div className="mb-1 flex px-1">
            <Chip testId="eventdetail-filter-linked" selected={linkedApart} onClick={toggleLinkedApart}>
              <Icon name="swap-horizontal" size={14} />
              {t('tx.counterFilter')}
            </Chip>
          </div>
        )}
        {filteredList.length > 0 ? (
          <div data-testid="eventdetail-txs">
            {days.map(([date, units]) => (
              <div key={date} data-testid={`eventdetail-day-${date}`}>
                <div className="m-cap sticky top-0 z-10 -mx-1 mt-3 mb-1 bg-bg px-2 py-1">{fmtDay(date)}</div>
                <div className="divide-y divide-line-2 rounded-card border border-line bg-surface px-3 py-1">
                  {units.map((unit) =>
                    unit.rows.length > 1 && linkedApart ? (
                      <div key={unit.key} className="py-1.5" data-testid={`eventdetail-linked-${unit.key}`}>
                        <div className="mb-0.5 flex items-center gap-1.5 px-1 text-[10px] font-semibold tracking-wide text-accent-deep uppercase">
                          <Icon name="cash-refund" size={12} color="var(--m-accent-deep)" />
                          {t('tx.linkedReimbursement')}
                        </div>
                        <div className="rounded-card bg-bg px-2">{unit.rows.map((tx) => renderTx(tx, tx.date !== date))}</div>
                      </div>
                    ) : (
                      renderTx(unit.rows[0], false, unit.rows.length > 1 ? linkedNoteOf(unit.rows.length - 1) : undefined)
                    ),
                  )}
                </div>
              </div>
            ))}
          </div>
        ) : (
          <p className="px-1 text-[12px] text-ink-4" data-testid="eventdetail-empty">
            {t('events.noTxs')}
          </p>
        )}
      </div>

      <EventFormSheet initial={formInitial} onClose={() => setFormInitial(null)} />
    </div>
  );
}
