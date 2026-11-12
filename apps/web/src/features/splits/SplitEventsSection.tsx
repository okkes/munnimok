import { useState } from 'react';
import { useLang } from '@/i18n';
import { useData } from '@/app/data';
import type { SplitDetail } from '@/application/splitsApi';
import { writeTxTransform } from '@/db/joined';
import type { EventRow } from '@/db/types';
import { useQuery } from '@/db/useQuery';
import { fmtCents } from '@/lib/money';
import { txTitle } from '@/lib/text';
import { Button } from '@/ui/Button';
import { Icon } from '@/ui/Icon';
import { Sheet } from '@/ui/Sheet';
import type { EntrySeed } from './SplitEntrySheet';
import { boundEvents, eventSuggestions, skipSuggestion } from './splitEvents';
import type { EventSuggestion } from './splitEvents';

const CARD = 'overflow-hidden rounded-card border border-line bg-surface';
const QUIET = 'm-tap shrink-0 border-none bg-transparent p-0 text-[12px] font-medium';

function SuggestionRow({
  suggestion,
  primary,
  onPrimary,
  onIgnore,
}: Readonly<{ suggestion: EventSuggestion; primary: string; onPrimary: () => void; onIgnore: () => void }>) {
  const { t, lang } = useLang();
  const { tx } = suggestion;
  return (
    <div className="flex items-center gap-3 border-b border-line-2 px-4 py-2.5 last:border-0" data-testid={`split-suggest-${tx.id}`}>
      <span className="min-w-0 flex-1">
        <span className="block truncate text-[13px] text-ink">{txTitle(tx)}</span>
        <span className="m-num block text-[11px] text-ink-4">{fmtCents(Math.abs(tx.amountCents), tx.currency, lang)}</span>
      </span>
      <button className={`${QUIET} text-accent-deep`} data-testid={`split-suggest-add-${tx.id}`} onClick={onPrimary}>
        {primary}
      </button>
      <button className={`${QUIET} text-ink-3`} data-testid={`split-suggest-ignore-${tx.id}`} onClick={onIgnore}>
        {t('splits.events.ignore')}
      </button>
    </div>
  );
}

/**
 * #538 (user): the regular events a split belongs to, and what is in one
 * and not in the other — a payment the person put in the split that sits in
 * no event yet, and a payment of the event that is not in the split. Each
 * is added on a tap or ignored for good; nothing is moved for the person.
 */
export function SplitEventsSection({ detail, onAddToSplit }: Readonly<{ detail: SplitDetail; onAddToSplit: (seed: EntrySeed) => void }>) {
  const { t } = useLang();
  const { store, repo } = useData();
  const splitId = detail.split.id;
  const [open, setOpen] = useState(false);
  const bound = useQuery(store, async () => boundEvents(store, splitId), [splitId]);
  const all = useQuery(
    store,
    async () => {
      const spaces = new Map((await store.allRows('space')).filter((space) => space.deleted === 0).map((space) => [space.id, space.name]));
      const events = (await store.allRows('event')).filter((event) => event.deleted === 0 && spaces.has(event.spaceId));
      events.sort((a, b) => (a.archived ?? 0) - (b.archived ?? 0) || a.name.localeCompare(b.name));
      return { spaces, events };
    },
    [],
  );
  const suggestions = useQuery(store, async () => eventSuggestions(store, splitId, await boundEvents(store, splitId), detail.entries), [splitId, detail.entries]);

  const toggle = (event: EventRow) => void repo.upsert('event', event.spaceId, event.id, { splitId: event.splitId === splitId ? null : splitId });
  const toEvent = (suggestion: EventSuggestion) => writeTxTransform(repo, suggestion.tx, { eventId: suggestion.event.id });
  const ignore = (suggestion: EventSuggestion) => void skipSuggestion(repo, suggestion.event, suggestion.tx.id);
  const seedOf = ({ tx }: EventSuggestion): EntrySeed => ({ description: txTitle(tx), amountCents: Math.abs(tx.amountCents), date: tx.date, currency: tx.currency, sourceTxId: tx.id, sourceSpaceId: tx.spaceId });
  const severalSpaces = (all?.spaces.size ?? 0) > 1;
  const names = (bound ?? []).map((event) => event.name).join(', ');

  return (
    <>
      <div className="m-cap mt-5 mb-1 px-1">{t('splits.events.cap')}</div>
      <button data-testid="split-event-row" onClick={() => setOpen(true)} className={`${CARD} m-tap flex w-full items-center gap-3 px-4 py-3 text-left`}>
        <Icon name="calendar-star" size={19} color="var(--m-ink-3)" />
        <span className="min-w-0 flex-1 truncate text-[14px] text-ink">{names || t('splits.events.none')}</span>
        <Icon name="chevron-right" size={18} color="var(--m-ink-4)" />
      </button>

      {(suggestions?.toEvent.length ?? 0) > 0 && (
        <div data-testid="split-suggest-to-event">
          <div className="mt-3 mb-1 flex items-center px-1">
            <span className="m-cap min-w-0 flex-1">{t('splits.events.toEvent', { event: suggestions?.toEvent[0].event.name ?? '' })}</span>
            {(suggestions?.toEvent.length ?? 0) > 1 && (
              <button className={`${QUIET} text-accent-deep`} data-testid="split-suggest-add-all" onClick={() => void Promise.all((suggestions?.toEvent ?? []).map(toEvent))}>
                {t('splits.events.addAll')}
              </button>
            )}
          </div>
          <div className={CARD}>
            {suggestions?.toEvent.map((suggestion) => (
              <SuggestionRow key={suggestion.tx.id} suggestion={suggestion} primary={t('splits.events.add')} onPrimary={() => void toEvent(suggestion)} onIgnore={() => ignore(suggestion)} />
            ))}
          </div>
        </div>
      )}
      {(suggestions?.toSplit.length ?? 0) > 0 && detail.split.status === 'open' && detail.split.state === 'active' && (
        <div data-testid="split-suggest-to-split">
          <div className="m-cap mt-3 mb-1 px-1">{t('splits.events.toSplit', { event: suggestions?.toSplit[0].event.name ?? '' })}</div>
          <div className={CARD}>
            {suggestions?.toSplit.map((suggestion) => (
              <SuggestionRow key={suggestion.tx.id} suggestion={suggestion} primary={t('splits.events.addToSplit')} onPrimary={() => onAddToSplit(seedOf(suggestion))} onIgnore={() => ignore(suggestion)} />
            ))}
          </div>
        </div>
      )}

      <Sheet open={open} onOpenChange={setOpen} title={t('splits.events.cap')} size="tall">
        <div className="flex flex-col gap-3 pt-1" data-testid="split-events-sheet">
          <p className="text-[12px] leading-snug text-ink-4">{t('splits.events.hint')}</p>
          <div className={`${CARD} px-4`}>
            {all?.events.map((event) => (
              <label key={event.id} className="flex items-center gap-3 border-b border-line-2 py-2.5 text-[14px] text-ink last:border-0">
                <input type="checkbox" data-testid={`split-event-${event.id}`} checked={event.splitId === splitId} onChange={() => toggle(event)} className="h-5 w-5 shrink-0 accent-[var(--m-accent-deep)]" />
                <span className="min-w-0 flex-1">
                  <span className="block truncate">{event.name}</span>
                  {severalSpaces && <span className="block truncate text-[11px] text-ink-4">{all.spaces.get(event.spaceId)}</span>}
                </span>
              </label>
            ))}
            {all?.events.length === 0 && <div className="py-6 text-center text-[13px] text-ink-4">{t('splits.events.empty')}</div>}
          </div>
          <Button variant="outline" data-testid="split-events-done" onClick={() => setOpen(false)}>
            {t('action.done')}
          </Button>
        </div>
      </Sheet>
    </>
  );
}
