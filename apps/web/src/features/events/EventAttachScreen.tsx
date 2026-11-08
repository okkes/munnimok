import { SelectAllRow } from '@/ui/SelectAllRow';
import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { useNavigate, useParams } from '@tanstack/react-router';
import { useLang } from '@/i18n';
import { useData } from '@/app/data';
import { useCanEdit } from '@/app/useCanEdit';
import { useEvents } from '@/application/events';
import { logActivity } from '@/application/activity';
import { ReadOnlyNote } from '@/features/spaces/ReadOnlyNote';
import { useSpaceTransactions, useTxTransform } from '@/application/transactions';
import type { SpaceTx } from '@/application/transactions';
import type { EventRow, TxSplit } from '@/db/types';
import { eventNetText, isEventMoney, suggestableTxs } from '@/domain/events';
import { filterTxs } from '@/domain/txFilter';
import { partNetCents } from '@/domain/reimbursement';
import { useDisplayMoney } from '@/features/currency/useDisplayMoney';
import { TxPeekSheet } from '@/features/transactions/TxPeekSheet';
import { useQuery } from '@/db/useQuery';
import { AppBar, IconButton } from '@/ui/AppBar';
import { Button } from '@/ui/Button';
import { Icon } from '@/ui/Icon';
import { MoreRows, PAGE_ROWS } from '@/ui/MoreRows';
import { SearchField } from '@/ui/SearchField';
import { TxRow } from '@/ui/TxRow';
import { TxPartRow } from '@/ui/TxPartRow';
import { partEntries, partPickKey, suggestionKeysOf } from './EventDetailScreen';

/** a split's part the add list offers: event money, not in this event yet */
const isOpenPart = (tx: SpaceTx, part: TxSplit, eventId: string): boolean =>
  isEventMoney(part.txType ?? tx.txType) && (part.eventId ?? tx.eventId) !== eventId;

/** #570: every transaction an event could take — event money not in it yet
 *  (rows filed under another event included: adding moves them), newest
 *  first; a split offers the parts that are not in the event */
export function addableTxs<T extends SpaceTx>(txs: readonly T[], eventId: string): T[] {
  return txs
    .filter((tx) => {
      if (tx.deleted !== 0) return false;
      const entries = partEntries(tx);
      if (entries.length > 1) return entries.some((e) => isOpenPart(tx, e.part, eventId));
      return isEventMoney(tx.txType) && tx.eventId !== eventId;
    })
    .sort((a, b) => b.date.localeCompare(a.date));
}

/** the pick keys a row offers: its open parts (a split) or itself */
function offeredKeys(tx: SpaceTx, eventId: string, mode: 'range' | 'all'): { key: string; part?: TxSplit; ordinal?: number }[] {
  const entries = partEntries(tx);
  if (entries.length <= 1) return [{ key: tx.id }];
  return entries
    .map((e, ordinal) => ({ ...e, ordinal }))
    // the date-range review leaves parts filed anywhere alone; the add list only skips this event's
    .filter((e) => (mode === 'range' ? !e.part.eventId : isOpenPart(tx, e.part, eventId)))
    .map((e) => ({ key: partPickKey(tx.id, e.idx), part: e.part, ordinal: e.ordinal }));
}

/** #570: adding from every transaction — the event's own add door, dated or not */
export function EventAddScreen() {
  return <EventAttachScreen mode="all" />;
}

/**
 * #144 (user): attaching transactions to an event is a FULL SCREEN now,
 * not a cramped sheet — the list wears the transactions screen's look
 * (hairline dividers, the same rows) with one difference: a checkbox on
 * the left. Everything starts selected (excluding is the review), and
 * select/deselect-all does the whole list in one tap.
 *
 * #447 (user): the list offers money RECEIVED in the range too (a
 * reimbursement, a contribution) - only a movement between the person's
 * own accounts stays out. The button sums the picks as the event would:
 * what they cost, or the surplus with a plus.
 */
export function EventAttachScreen({ mode = 'range' }: Readonly<{ mode?: 'range' | 'all' }>) {
  const { t } = useLang();
  const navigate = useNavigate();
  const { store, repo, spaceId } = useData();
  const { eventId } = useParams({ strict: false }) as { eventId: string };
  const events = useEvents();
  const txs = useSpaceTransactions();
  const transform = useTxTransform();
  const space = useQuery(store, async () => store.get('space', spaceId), [spaceId]);
  const [picked, setPicked] = useState<ReadonlySet<string> | null>(null);
  const [attaching, setAttaching] = useState(false);
  // #570: the add list searches every transaction, a page at a time, and
  // any row can be looked at before it is picked
  const [query, setQuery] = useState('');
  const [shownRows, setShownRows] = useState(PAGE_ROWS);
  const showMore = useCallback(() => setShownRows((n) => n + PAGE_ROWS), []);
  const scrollRef = useRef<HTMLDivElement>(null);
  const [peek, setPeek] = useState<{ tx: SpaceTx; key: string; part?: TxSplit } | null>(null);
  const canEdit = useCanEdit(); // #505

  const event = events?.find((e) => e.id === eventId);
  useEffect(() => {
    if (events && !event) void navigate({ to: '/events', replace: true });
  }, [events, event, navigate]);
  const currency = space?.currency ?? 'EUR';
  const { fmt } = useDisplayMoney();
  const money = (cents: number) => fmt(cents, currency);

  const suggestions = useMemo(() => {
    if (!event || !txs) return undefined;
    return mode === 'range' ? suggestableTxs(txs, event.id, event.from, event.to) : addableTxs(txs, event.id);
  }, [event, txs, mode]);
  // the search only narrows what is LISTED: picks a later search hides still attach
  const listed = useMemo(
    () => (suggestions && mode === 'all' && query ? filterTxs(suggestions, { query }) : suggestions),
    [suggestions, mode, query],
  );
  // the date-range review starts with everything selected — excluding is
  // the review. Adopted at RENDER time the moment suggestions exist (null
  // = not seeded yet): the rows and their checks land in the SAME commit,
  // so no tap can slip in between; later emissions never re-seed (the
  // LoanMatchSheet seed-once lesson). The add list starts empty.
  if (picked === null && suggestions) setPicked(new Set(mode === 'range' ? suggestionKeysOf(suggestions) : []));
  const pickedSet: ReadonlySet<string> = picked ?? new Set<string>();

  if (!event) return <div className="h-full" data-testid="screen-event-attach" />;

  const allKeys = suggestionKeysOf(suggestions);
  const shown = mode === 'all' ? (listed ?? []).slice(0, shownRows) : (listed ?? []);
  const remaining = (listed ?? []).length - shown.length;
  const togglePick = (id: string) => {
    const next = new Set(pickedSet);
    if (next.has(id)) next.delete(id);
    else next.add(id);
    setPicked(next);
  };

  const attachPicked = async () => {
    setAttaching(true);
    try {
      let n = 0;
      for (const tx of suggestions ?? []) {
        // #143: multi-part rows attach PART BY PART — the picked parts
        // get the event in one splits write; the container stays bare
        const entries = partEntries(tx);
        if (entries.length > 1) {
          const idxs = new Set(entries.filter((e) => pickedSet.has(partPickKey(tx.id, e.idx))).map((e) => e.idx));
          if (idxs.size === 0) continue;
          const nextSplits = (tx.splits ?? []).map((s, i) => (idxs.has(i) ? { ...s, eventId: event.id } : s));
          await transform(tx, { splits: nextSplits }, null);
          n += idxs.size;
        } else if (pickedSet.has(tx.id)) {
          await transform(tx, { eventId: event.id }, null);
          n++;
        }
      }
      if (n > 0) void logActivity(store, repo, spaceId, 'txLink', `${event.name} +${n}`);
      // replace, not back: the attach step vanishes from history — the
      // browser back on the detail then leaves the event, not re-picks
      void navigate({ to: '/events/$eventId', params: { eventId: event.id }, replace: true });
    } finally {
      setAttaching(false);
    }
  };

  const pickedTotal = (suggestions ?? []).reduce((sum, tx) => {
    const entries = partEntries(tx);
    if (entries.length > 1) {
      const sign = tx.amountCents < 0 ? -1 : 1;
      return (
        sum +
        entries
          .filter((e) => pickedSet.has(partPickKey(tx.id, e.idx)))
          .reduce((inner, e) => inner + -(sign * partNetCents(e.part)), 0)
      );
    }
    return sum + (pickedSet.has(tx.id) ? -tx.amountCents : 0);
  }, 0);

  return (
    <div className="m-fade flex h-full flex-col" data-testid="screen-event-attach">
      <AppBar
        title={t(mode === 'all' ? 'events.addTitle' : 'events.pickTitle')}
        leading={
          <IconButton label={t('action.back')} testId="eventpick-back" onClick={() => window.history.back()}>
            <Icon name="arrow-left" size={22} />
          </IconButton>
        }
      />
      <div ref={scrollRef} className="min-h-0 flex-1 overflow-y-auto px-5 pb-6">
        {mode === 'all' ? (
          // #570: the whole history to pick from — nothing starts selected
          <div className="mb-2">
            <SearchField
              testId="eventpick-search"
              value={query}
              onChange={(value) => {
                setQuery(value);
                setShownRows(PAGE_ROWS);
              }}
              placeholder={t('tx.searchPlaceholder')}
            />
          </div>
        ) : (
          // #378: the one select-all row every transaction list wears
          <SelectAllRow
            total={allKeys.length}
            selected={picked?.size ?? 0}
            onChange={(next) => setPicked(next ? new Set(allKeys) : new Set())}
            testId="eventpick-all"
            className="mb-2"
          />
        )}
        <div className="divide-y divide-line-2 rounded-card border border-line bg-surface px-3 py-1" data-testid="eventpick-list">
          {shown.flatMap((tx) =>
            // #143: a split offers its PARTS, one checkbox each — the
            // container itself is never a pick. #570: a tap on a row looks
            // at it; the box picks it
            offeredKeys(tx, event.id, mode).map(({ key, part, ordinal }) => {
              const checked = pickedSet.has(key);
              const sign = tx.amountCents < 0 ? -1 : 1;
              const elsewhere = otherEventOf(tx, part, event.id, events ?? []);
              return (
                <div key={key} className="flex items-center gap-2">
                  <button
                    data-testid={part ? `eventpick-${tx.id}-part-${key.slice(tx.id.length + 1)}` : `eventpick-${tx.id}`}
                    aria-label={tx.merchant}
                    aria-pressed={checked}
                    onClick={() => togglePick(key)}
                    className={`m-tap ml-1 flex h-5 w-5 shrink-0 items-center justify-center rounded-md border-2 ${
                      checked ? 'border-accent bg-accent text-white' : 'border-line bg-surface'
                    }`}
                  >
                    {checked && <Icon name="check" size={12} />}
                  </button>
                  <div className="min-w-0 flex-1">
                    {part ? (
                      <TxPartRow
                        tx={tx}
                        part={part}
                        index={ordinal ?? 0}
                        amountText={money(sign * partNetCents(part))}
                        onClick={() => setPeek({ tx, key, part })}
                        showDate
                      />
                    ) : (
                      <TxRow tx={tx} showDate hideCategory={false} onClick={() => setPeek({ tx, key })} />
                    )}
                    {elsewhere && (
                      <span className="-mt-1.5 block truncate pb-1.5 pl-[3.25rem] text-[11px] text-ink-4" data-testid={`eventpick-elsewhere-${key}`}>
                        {t('events.inOther', { name: elsewhere.name })}
                      </span>
                    )}
                  </div>
                </div>
              );
            }),
          )}
          {shown.length === 0 && (
            <p className="px-1 py-3 text-[12px] text-ink-4" data-testid="eventpick-empty">
              {t(query ? 'tx.emptyFiltered' : 'events.pickEmpty')}
            </p>
          )}
        </div>
        {remaining > 0 && <MoreRows rootRef={scrollRef} remaining={remaining} onMore={showMore} testId="eventpick-more" />}
      </div>
      <div className="shrink-0 border-t border-line-2 bg-bg px-5 pt-3 pb-[max(16px,env(safe-area-inset-bottom))]">
        <ReadOnlyNote className="mb-2" testId="eventpick-readonly-note" />
        <Button className="w-full" data-testid="eventpick-attach" disabled={attaching || pickedSet.size === 0 || !canEdit} onClick={() => void attachPicked()}>
          {t('events.attachPicked', { n: pickedSet.size, amount: eventNetText(pickedTotal, currency, fmt) })}
        </Button>
      </div>
      <TxPeekSheet
        tx={peek?.tx ?? null}
        part={peek?.part}
        onClose={() => setPeek(null)}
        action={
          peek && (
            <Button
              className="w-full"
              variant={pickedSet.has(peek.key) ? 'outline' : undefined}
              data-testid="eventpick-peek-toggle"
              onClick={() => {
                togglePick(peek.key);
                setPeek(null);
              }}
            >
              {t(pickedSet.has(peek.key) ? 'events.peekDeselect' : 'events.peekSelect')}
            </Button>
          )
        }
      />
    </div>
  );
}

/** the event a row (or part) is filed under now, when it is another one */
function otherEventOf(tx: SpaceTx, part: TxSplit | undefined, eventId: string, events: readonly EventRow[]): EventRow | undefined {
  const current = part ? (part.eventId ?? tx.eventId) : tx.eventId;
  return current && current !== eventId ? events.find((e) => e.id === current) : undefined;
}
