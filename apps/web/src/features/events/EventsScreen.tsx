import { useEffect, useState } from 'react';
import { useNavigate } from '@tanstack/react-router';
import { useLiveQuery } from 'dexie-react-hooks';
import { LOCALES, useLang } from '@/i18n';
import { useData } from '@/app/data';
import { useEventOps, useEvents } from '@/application/events';
import { useSpaceTransactions } from '@/application/transactions';
import { eventSpentCents } from '@/domain/events';
import type { EventRow } from '@/db/types';
import { fmtCents, parseCents } from '@/lib/money';
import { HelpButton } from '@/features/help/HelpButton';
import { IntroCard } from '@/features/help/IntroCard';
import { AppBar, IconButton } from '@/ui/AppBar';
import { Button } from '@/ui/Button';
import { Icon } from '@/ui/Icon';
import { Sheet } from '@/ui/Sheet';

export const EVENT_ICONS = ['beach', 'airplane', 'ring', 'home-outline', 'party-popper', 'baby-carriage', 'school-outline', 'car-outline'] as const;

/** create/edit sheet — small enough to stay a sheet (unlike budgets) */
export function EventFormSheet({ initial, onClose }: Readonly<{ initial: EventRow | 'new' | null; onClose: () => void }>) {
  const { t } = useLang();
  const ops = useEventOps();
  const editing = initial !== 'new' && initial !== null ? initial : null;
  const [name, setName] = useState('');
  const [icon, setIcon] = useState<string>(EVENT_ICONS[0]);
  const [from, setFrom] = useState('');
  const [to, setTo] = useState('');
  const [budget, setBudget] = useState('');
  const [confirmDelete, setConfirmDelete] = useState(false);

  useEffect(() => {
    setName(editing?.name ?? '');
    setIcon(editing?.icon ?? EVENT_ICONS[0]);
    setFrom(editing?.from ?? '');
    setTo(editing?.to ?? '');
    setBudget(editing?.budgetCents ? (editing.budgetCents / 100).toFixed(2) : '');
    setConfirmDelete(false);
  }, [initial, editing]);

  const save = async () => {
    if (!name.trim()) return;
    const budgetCents = parseCents(budget);
    await ops.save(editing?.id ?? null, {
      name: name.trim(),
      icon,
      from: from || undefined,
      to: to || undefined,
      budgetCents: budgetCents && budgetCents > 0 ? budgetCents : undefined,
      archived: editing?.archived ?? 0,
    });
    onClose();
  };

  const removeEvent = async () => {
    if (!editing) return;
    if (!confirmDelete) {
      setConfirmDelete(true);
      return;
    }
    await ops.remove(editing.id);
    onClose();
  };

  return (
    <Sheet open={initial !== null} onOpenChange={(open) => !open && onClose()} title={editing ? t('events.edit') : t('events.new')} size="tall">
      <div className="flex flex-col gap-3 pt-1">
        <div className="flex gap-2 overflow-x-auto pb-1">
          {EVENT_ICONS.map((candidate) => (
            <button
              key={candidate}
              data-testid={`eventform-icon-${candidate}`}
              onClick={() => setIcon(candidate)}
              className={`m-tap flex h-11 w-11 shrink-0 items-center justify-center rounded-xl border ${
                icon === candidate ? 'border-accent bg-accent-soft text-accent-deep' : 'border-line bg-surface text-ink-2'
              }`}
            >
              <Icon name={candidate} size={19} />
            </button>
          ))}
        </div>
        <input
          data-testid="eventform-name"
          value={name}
          onChange={(e) => setName(e.target.value)}
          placeholder={t('events.namePlaceholder')}
          className="h-12 w-full rounded-input border border-line bg-surface px-4 text-[15px] text-ink outline-none placeholder:text-ink-4"
        />
        <div className="flex items-center gap-2 text-[13px] text-ink-2">
          <input
            data-testid="eventform-from"
            type="date"
            value={from}
            onChange={(e) => setFrom(e.target.value)}
            className="h-10 min-w-0 flex-1 appearance-none rounded-input border border-line bg-surface px-3 text-[14px] text-ink outline-none"
          />
          <span>–</span>
          <input
            data-testid="eventform-to"
            type="date"
            value={to}
            onChange={(e) => setTo(e.target.value)}
            className="h-10 min-w-0 flex-1 appearance-none rounded-input border border-line bg-surface px-3 text-[14px] text-ink outline-none"
          />
        </div>
        <div className="m-cap px-1">{t('events.budget')}</div>
        <input
          data-testid="eventform-budget"
          type="number"
          inputMode="decimal"
          step="0.01"
          min="0"
          value={budget}
          onChange={(e) => setBudget(e.target.value)}
          placeholder="0.00"
          className="h-12 w-full rounded-input border border-line bg-surface px-4 font-mono text-[15px] text-ink outline-none placeholder:text-ink-4"
        />
        {editing && (
          <button
            data-testid="eventform-archive"
            onClick={() => void ops.save(editing.id, { archived: editing.archived === 1 ? 0 : 1 }).then(onClose)}
            className="m-tap flex w-full items-center gap-3 rounded-card border border-line bg-surface px-4 py-3 text-left text-[14px] text-ink"
          >
            <Icon name={editing.archived === 1 ? 'archive-arrow-up-outline' : 'archive-outline'} size={18} />
            {t(editing.archived === 1 ? 'events.unarchive' : 'events.archive')}
          </button>
        )}
        <Button data-testid="eventform-save" onClick={() => void save()} disabled={!name.trim()}>
          {editing ? t('action.save') : t('action.create')}
        </Button>
        {editing && (
          <Button variant="danger" data-testid="eventform-delete" onClick={() => void removeEvent()}>
            {confirmDelete ? t('action.confirm') : t('action.delete')}
          </Button>
        )}
      </div>
    </Sheet>
  );
}

/** All events with live totals; archived keep their story below. */
export function EventsScreen() {
  const { t, lang } = useLang();
  const navigate = useNavigate();
  const { db, spaceId } = useData();
  const events = useEvents();
  const txs = useSpaceTransactions();
  const space = useLiveQuery(() => db.spaces.get(spaceId), [spaceId]);
  const currency = space?.currency ?? 'EUR';
  const [formInitial, setFormInitial] = useState<EventRow | 'new' | null>(null);

  const fmtRange = (event: EventRow) => {
    if (!event.from) return null;
    const f = (iso: string) => new Date(iso).toLocaleDateString(LOCALES[lang], { day: 'numeric', month: 'short' });
    return event.to ? `${f(event.from)} – ${f(event.to)}` : f(event.from);
  };

  const renderCard = (event: EventRow) => {
    const spent = eventSpentCents(txs ?? [], event.id);
    const overBudget = !!event.budgetCents && spent > event.budgetCents;
    return (
      <button
        key={event.id}
        data-testid={`event-card-${event.id}`}
        onClick={() => void navigate({ to: '/events/$eventId', params: { eventId: event.id } })}
        className={`m-tap w-full rounded-card border border-line bg-surface p-4 text-left ${event.archived === 1 ? 'opacity-60' : ''}`}
      >
        <div className="flex items-center gap-3">
          <span className="flex h-10 w-10 shrink-0 items-center justify-center rounded-xl bg-accent-soft text-accent-deep">
            <Icon name={event.icon ?? 'party-popper'} size={19} />
          </span>
          <span className="min-w-0 flex-1">
            <span className="flex items-baseline justify-between gap-2">
              <span className="truncate text-[15px] font-semibold text-ink">{event.name}</span>
              <span className="m-num shrink-0 text-[14px] font-semibold text-ink" data-testid={`event-total-${event.id}`}>
                {fmtCents(spent, currency, lang)}
              </span>
            </span>
            <span className="block text-[11px] text-ink-4">
              {fmtRange(event) ?? t('events.undated')}
              {event.budgetCents ? ` · ${t('budgets.of', { amount: fmtCents(event.budgetCents, currency, lang) })}` : ''}
            </span>
          </span>
        </div>
        {!!event.budgetCents && (
          <div className="mt-3 h-1.5 overflow-hidden rounded-full bg-bg-2">
            <div
              className="m-grow-x h-full origin-left rounded-full"
              style={{
                width: `${Math.min(100, (spent / event.budgetCents) * 100)}%`,
                background: overBudget ? 'var(--m-negative)' : 'var(--m-accent)',
              }}
            />
          </div>
        )}
      </button>
    );
  };

  return (
    <div className="m-fade flex h-full flex-col" data-testid="screen-events">
      <AppBar
        title={t('events.title')}
        leading={
          <IconButton label={t('action.back')} testId="events-back" onClick={() => window.history.back()}>
            <Icon name="arrow-left" size={22} />
          </IconButton>
        }
        trailing={
          <>
            <HelpButton tourId="events" />
            <IconButton label={t('events.new')} testId="events-add" onClick={() => setFormInitial('new')}>
              <Icon name="plus" size={22} />
            </IconButton>
          </>
        }
      />
      <div className="min-h-0 flex-1 overflow-y-auto px-5 pb-6">
        <IntroCard tourId="events" />
        <div className="flex flex-col gap-2.5 pt-1">{(events ?? []).map(renderCard)}</div>
        {events?.length === 0 && (
          <div className="flex flex-col items-center gap-2 px-6 pt-16 text-center" data-testid="events-empty">
            <Icon name="party-popper" size={34} color="var(--m-ink-4)" />
            <p className="text-[14px] font-medium text-ink-2">{t('events.emptyTitle')}</p>
            <p className="text-[12px] text-ink-4">{t('events.emptyBody')}</p>
          </div>
        )}
      </div>
      <EventFormSheet initial={formInitial} onClose={() => setFormInitial(null)} />
    </div>
  );
}
