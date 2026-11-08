import { useState } from 'react';
import { LOCALES, useLang } from '@/i18n';
import { useData } from '@/app/data';
import { useQuery } from '@/db/useQuery';
import { visibleTransactions } from '@/db/joined';
import type { EventRow } from '@/db/types';
import { eventNetText, eventTotals } from '@/domain/events';
import { useDisplayMoney } from '@/features/currency/useDisplayMoney';
import { Icon } from '@/ui/Icon';
import { Pill } from '@/ui/primitives';
import { eventPicture, eventPictureStyle } from './EventsScreen';

/**
 * #537 (user): every event picker lists the same way — active events
 * first, archived ones after them with a label, the date range under the
 * name, and a peek that unfolds the event (picture, money, note) under
 * its row before anything is chosen. A peek inside the picker rather than
 * a sheet of its own: a sheet never opens inside another.
 */
export function EventPickList({
  events,
  selectedId,
  onPick,
  testIdPrefix,
  variant = 'check',
}: Readonly<{
  events: readonly EventRow[];
  selectedId?: string | null;
  onPick: (eventId: string) => void;
  /** the pick button's testid is `${testIdPrefix}${event.id}` */
  testIdPrefix: string;
  /** 'radio' leads with the radio mark (the split's picker); 'check' trails a check when chosen */
  variant?: 'check' | 'radio';
}>) {
  const [peekId, setPeekId] = useState<string | null>(null);
  const ordered = [...events].filter((e) => e.deleted === 0).sort((a, b) => (a.archived ?? 0) - (b.archived ?? 0));
  return (
    <>
      {ordered.map((event) => (
        <EventPickRow
          key={event.id}
          event={event}
          selected={selectedId === event.id}
          peeking={peekId === event.id}
          onPick={() => onPick(event.id)}
          onPeek={() => setPeekId((id) => (id === event.id ? null : event.id))}
          testId={`${testIdPrefix}${event.id}`}
          variant={variant}
        />
      ))}
    </>
  );
}

function EventPickRow({
  event,
  selected,
  peeking,
  onPick,
  onPeek,
  testId,
  variant,
}: Readonly<{
  event: EventRow;
  selected: boolean;
  peeking: boolean;
  onPick: () => void;
  onPeek: () => void;
  testId: string;
  variant: 'check' | 'radio';
}>) {
  const { t, lang } = useLang();
  const day = (iso: string) => new Date(iso).toLocaleDateString(LOCALES[lang], { day: 'numeric', month: 'short', year: 'numeric' });
  const range = event.from && event.to ? `${day(event.from)} – ${day(event.to)}` : t('events.undated');
  const archived = event.archived === 1;
  return (
    <div className="border-b border-line-2 last:border-0" data-testid={`${testId}-row`}>
      <div className="flex items-center">
        <button
          data-testid={testId}
          onClick={onPick}
          aria-pressed={selected}
          className="m-tap flex min-w-0 flex-1 items-center gap-3 border-none bg-transparent px-1 py-2.5 text-left"
        >
          {variant === 'radio' && (
            <Icon
              name={selected ? 'radiobox-marked' : 'radiobox-blank'}
              size={20}
              color={selected ? 'var(--m-accent-deep)' : 'var(--m-ink-4)'}
            />
          )}
          <img
            src={eventPicture(event)}
            alt=""
            className={`h-9 w-9 shrink-0 rounded-lg object-cover ${archived ? 'opacity-60' : ''}`}
            style={eventPictureStyle(event)}
          />
          <span className="min-w-0 flex-1">
            <span className={`block truncate text-[14px] ${archived ? 'text-ink-3' : 'text-ink'}`}>{event.name}</span>
            <span className="block truncate text-[12px] text-ink-4">{range}</span>
          </span>
          {archived && <Pill testId={`${testId}-archived`}>{t('events.archivedPill')}</Pill>}
          {variant === 'check' && selected && <Icon name="check" size={17} color="var(--m-accent-deep)" />}
        </button>
        <button
          data-testid={`${testId}-peek`}
          aria-label={t('events.peek')}
          aria-expanded={peeking}
          onClick={onPeek}
          className="m-tap shrink-0 border-none bg-transparent p-2 text-ink-3"
        >
          <Icon name={peeking ? 'eye-off-outline' : 'eye-outline'} size={18} />
        </button>
      </div>
      {peeking && <EventPeek event={event} testId={`${testId}-preview`} />}
    </div>
  );
}

/** the unfolded event: its picture, what it holds so far and its note —
 *  its transactions are read from the event's own space */
function EventPeek({ event, testId }: Readonly<{ event: EventRow; testId: string }>) {
  const { t } = useLang();
  const { store } = useData();
  const { fmt } = useDisplayMoney();
  const summary = useQuery(
    store,
    async () => {
      const [txs, space] = await Promise.all([visibleTransactions(store, event.spaceId), store.get('space', event.spaceId)]);
      const count = txs.filter(
        (tx) => tx.deleted === 0 && (tx.eventId === event.id || (tx.splits ?? []).some((s) => s.eventId === event.id)),
      ).length;
      return { totals: eventTotals(txs, event.id), count, currency: space?.currency ?? 'EUR' };
    },
    [event.id, event.spaceId],
  );
  return (
    <div className="mb-2.5 overflow-hidden rounded-card bg-bg" data-testid={testId}>
      <img src={eventPicture(event)} alt="" className="h-24 w-full object-cover" style={eventPictureStyle(event)} />
      <div className="px-3 py-2">
        {summary && (
          <span className="m-num block text-[13px] font-semibold text-ink">
            {t('events.peekTotal', { amount: eventNetText(summary.totals.netCents, summary.currency, fmt), n: summary.count })}
          </span>
        )}
        {event.note && <p className="mt-0.5 text-[12px] text-ink-3">{event.note}</p>}
      </div>
    </div>
  );
}
