import { useEffect, useMemo, useState } from 'react';
import { useLiveQuery } from 'dexie-react-hooks';
import { useNavigate, useParams } from '@tanstack/react-router';
import { LOCALES, useLang } from '@/i18n';
import { useData } from '@/app/data';
import { useEvents } from '@/application/events';
import { useSpaceTransactions, useTxTransform } from '@/application/transactions';
import { eventCategoryBreakdown, eventPerDayCents, eventSpentCents, suggestableTxs } from '@/domain/events';
import { catName, useCategories } from '@/features/categories/useCategories';
import { fmtCents } from '@/lib/money';
import { AppBar, IconButton } from '@/ui/AppBar';
import { Button } from '@/ui/Button';
import { Icon } from '@/ui/Icon';
import { TxRow } from '@/ui/TxRow';
import { EventFormSheet } from './EventsScreen';
import type { EventRow } from '@/db/types';

/**
 * One event in full: what it cost (per day when dated), where the money
 * went, every transaction — and the fast path: attach everything that
 * happened inside the date range in one tap.
 */
export function EventDetailScreen() {
  const { t, lang } = useLang();
  const navigate = useNavigate();
  const { db, spaceId } = useData();
  const { eventId } = useParams({ strict: false }) as { eventId: string };
  const events = useEvents();
  const txs = useSpaceTransactions();
  const transform = useTxTransform();
  const cats = useCategories();
  const space = useLiveQuery(() => db.spaces.get(spaceId), [spaceId]);
  const [formInitial, setFormInitial] = useState<EventRow | 'new' | null>(null);
  const [attaching, setAttaching] = useState(false);

  const event = events?.find((e) => e.id === eventId);
  // deleted here or on another device: leave the orphaned detail
  useEffect(() => {
    if (events && !event) void navigate({ to: '/events', replace: true });
  }, [events, event, navigate]);
  const currency = space?.currency ?? 'EUR';
  const money = (cents: number) => fmtCents(cents, currency, lang);

  const view = useMemo(() => {
    if (!event || !txs) return undefined;
    const list = txs
      .filter((tx) => tx.deleted === 0 && tx.eventId === event.id)
      .sort((a, b) => b.date.localeCompare(a.date));
    const spent = eventSpentCents(txs, event.id);
    return {
      list,
      spent,
      perDay: eventPerDayCents(spent, event.from, event.to),
      breakdown: eventCategoryBreakdown(txs, event.id, cats),
      suggestions: suggestableTxs(txs, event.id, event.from, event.to),
    };
  }, [event, txs, cats]);

  if (!event || !view) return <div className="h-full" data-testid="screen-event-detail" />;

  const attachSuggestions = async () => {
    setAttaching(true);
    try {
      for (const tx of view.suggestions) await transform(tx, { eventId: event.id });
    } finally {
      setAttaching(false);
    }
  };

  const fmtDate = (iso: string) => new Date(iso).toLocaleDateString(LOCALES[lang], { day: 'numeric', month: 'short', year: 'numeric' });

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
          <IconButton label={t('events.edit')} testId="eventdetail-edit" onClick={() => setFormInitial(event)}>
            <Icon name="pencil-outline" size={20} />
          </IconButton>
        }
      />
      <div className="min-h-0 flex-1 overflow-y-auto px-5 pb-6">
        <div className="rounded-card border border-line bg-surface p-4" data-testid="eventdetail-hero">
          <div className="flex items-center gap-3">
            <span className="flex h-12 w-12 shrink-0 items-center justify-center rounded-2xl bg-accent-soft text-accent-deep">
              <Icon name={event.icon ?? 'party-popper'} size={22} />
            </span>
            <span className="min-w-0 flex-1">
              <span className="m-num block text-[24px] font-semibold text-ink" data-testid="eventdetail-total">
                {money(view.spent)}
              </span>
              <span className="block text-[12px] text-ink-3">
                {event.from && event.to && `${fmtDate(event.from)} – ${fmtDate(event.to)}`}
                {view.perDay !== null && ` · ${t('events.perDay', { amount: money(view.perDay) })}`}
              </span>
            </span>
          </div>
          {!!event.budgetCents && (
            <>
              <div className="mt-3 h-1.5 overflow-hidden rounded-full bg-bg-2">
                <div
                  className="m-grow-x h-full origin-left rounded-full"
                  style={{
                    width: `${Math.min(100, (view.spent / event.budgetCents) * 100)}%`,
                    background: view.spent > event.budgetCents ? 'var(--m-negative)' : 'var(--m-accent)',
                  }}
                />
              </div>
              <div className="mt-1.5 text-[11px] text-ink-3">{t('budgets.of', { amount: money(event.budgetCents) })}</div>
            </>
          )}
        </div>

        {/* the fast path after a trip: attach the whole date range */}
        {view.suggestions.length > 0 && (
          <div className="mt-3 flex items-center gap-3 rounded-card border border-accent bg-accent-soft/40 px-4 py-3" data-testid="eventdetail-suggest">
            <Icon name="creation" size={17} color="var(--m-accent-deep)" />
            <span className="min-w-0 flex-1 text-[13px] text-ink-2">
              {t('events.suggestAttach', { n: view.suggestions.length })}
            </span>
            <Button size="sm" data-testid="eventdetail-attach-all" disabled={attaching} onClick={() => void attachSuggestions()}>
              {t('events.attachAll')}
            </Button>
          </div>
        )}

        {view.breakdown.length > 0 && (
          <>
            <div className="m-cap mt-5 mb-1 px-1">{t('screen.categories')}</div>
            <div className="rounded-card border border-line bg-surface px-4 py-1" data-testid="eventdetail-cats">
              {view.breakdown.map(({ catId, totalCents }) => {
                const cat = cats.byId(catId);
                return (
                  <div key={catId} className="flex items-center gap-3 border-b border-line-2 py-2.5 last:border-0">
                    <Icon name={cat.icon} size={17} color={cat.color ?? 'var(--m-ink-3)'} />
                    <span className="min-w-0 flex-1 truncate text-[14px] text-ink">{catName(cat, t)}</span>
                    <span className="m-num text-[14px] font-semibold text-ink">{money(totalCents)}</span>
                  </div>
                );
              })}
            </div>
          </>
        )}

        <div className="m-cap mt-5 mb-1 px-1">
          {t('overview.payments')} · {view.list.length}
        </div>
        {view.list.length > 0 ? (
          <div className="rounded-card border border-line bg-surface px-3 py-1" data-testid="eventdetail-txs">
            {view.list.map((tx) => (
              <TxRow key={tx.id} tx={tx} showDate onClick={() => void navigate({ to: '/transactions/$txId', params: { txId: tx.id } })} />
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
