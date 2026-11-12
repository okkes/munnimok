import { useEffect, useState } from 'react';
import { useNavigate } from '@tanstack/react-router';
import { useLang } from '@/i18n';
import { useData } from '@/app/data';
import type { SplitSummary } from '@/application/splitsApi';
import type { EventRow } from '@/db/types';
import { useQuery } from '@/db/useQuery';
import { fmtCents } from '@/lib/money';
import { Icon } from '@/ui/Icon';
import { adoptEventLinks, eventSuggestions } from './splitEvents';
import { useSplitsApi } from './splitsCore';

/**
 * The split a regular event is linked to, on the event's page (#538,
 * user): what the WHOLE thing cost — the event's own figure is my part of
 * it, and looking back at a wintersport with four people the total is
 * what one wants to see — with where I stand as the smaller line. Splits
 * are online-only, so this renders nothing offline, without an account,
 * or when no split of mine is linked to this event.
 */
export function SplitEventSummary({ eventId }: Readonly<{ eventId: string }>) {
  const { t, lang } = useLang();
  const navigate = useNavigate();
  const api = useSplitsApi();
  const { store, repo } = useData();
  const event = useQuery(store, async () => store.get('event', eventId), [eventId]);
  const [split, setSplit] = useState<SplitSummary | null>(null);
  const [pending, setPending] = useState(0);
  const boundTo = event?.splitId ?? null;

  useEffect(() => {
    if (!api) return;
    let stale = false;
    void (async () => {
      const splits = await api.list();
      if (stale || !splits) return;
      // a link the server still keeps from before lands on its event once
      await adoptEventLinks(store, repo, splits);
      const mine = splits.find((candidate) => candidate.id === boundTo) ?? null;
      setSplit(mine);
      const detail = mine && event ? await api.get(mine.id) : null;
      const open = detail && detail !== 'gone' ? (await eventSuggestions(store, mine?.id ?? '', [event as EventRow], detail.entries)).toSplit.length : 0;
      if (!stale) setPending(open);
    })();
    return () => {
      stale = true;
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [api, eventId, boundTo, store, repo]);

  if (!split) return null;
  const standing = () => {
    if (split.myBalanceCents > 0) return t('splits.youGet', { amount: fmtCents(split.myBalanceCents, split.currency, lang) });
    if (split.myBalanceCents < 0) return t('splits.youOwe', { amount: fmtCents(-split.myBalanceCents, split.currency, lang) });
    return split.status === 'open' ? t('splits.even') : t(`splits.status.${split.status}`);
  };
  return (
    <button
      data-testid="event-split-summary"
      onClick={() => void navigate({ to: '/splits/$splitId', params: { splitId: split.id } })}
      className="m-tap mt-3 flex w-full items-center gap-3 rounded-card border border-line bg-surface px-4 py-3 text-left"
    >
      <Icon name="account-cash-outline" size={20} color="var(--m-accent-deep)" />
      <span className="min-w-0 flex-1">
        <span className="block truncate text-[14px] text-ink">{split.name}</span>
        <span className="block text-[11px] text-ink-4" data-testid="event-split-standing">
          {standing()}
        </span>
        {pending > 0 && (
          <span className="block text-[11px] text-warning" data-testid="event-split-pending">
            {t(pending === 1 ? 'splits.events.pendingOne' : 'splits.events.pending', { n: pending })}
          </span>
        )}
      </span>
      <span className="shrink-0 text-right">
        <span className="m-num block text-[14px] font-semibold text-ink" data-testid="event-split-total">
          {fmtCents(split.totalCents, split.currency, lang)}
        </span>
        <span className="block text-[10px] text-ink-4">{t('splits.totalCap')}</span>
      </span>
      <Icon name="chevron-right" size={18} color="var(--m-ink-4)" />
    </button>
  );
}
