import { useEffect, useState } from 'react';
import { useNavigate } from '@tanstack/react-router';
import { useLiveQuery } from 'dexie-react-hooks';
import { useLang } from '@/i18n';
import { useData } from '@/app/data';
import { useGoalOps, useGoals } from '@/application/goals';
import { useSpaceAccounts } from '@/application/transactions';
import { localToday } from '@/application/recurring';
import { goalOverview, goalProgress, paceCentsPerMonth } from '@/domain/goals';
import type { GoalRow } from '@/db/types';
import { fmtCents, parseCents } from '@/lib/money';
import { HelpButton } from '@/features/help/HelpButton';
import { IntroCard } from '@/features/help/IntroCard';
import { AppBar, IconButton } from '@/ui/AppBar';
import { Button } from '@/ui/Button';
import { Icon } from '@/ui/Icon';
import { ProgressBar, Tile } from '@/ui/primitives';
import { Sheet } from '@/ui/Sheet';

export const GOAL_ICONS = ['home-outline', 'car-outline', 'airplane', 'shield-check-outline', 'laptop', 'ring', 'sail-boat', 'school-outline'] as const;

/** create/edit sheet */
export function GoalFormSheet({ initial, onClose }: Readonly<{ initial: GoalRow | 'new' | null; onClose: () => void }>) {
  const { t } = useLang();
  const ops = useGoalOps();
  const editing = initial !== 'new' && initial !== null ? initial : null;
  const [name, setName] = useState('');
  const [icon, setIcon] = useState<string>(GOAL_ICONS[0]);
  const [target, setTarget] = useState('');
  const [targetDate, setTargetDate] = useState('');
  const [confirmDelete, setConfirmDelete] = useState(false);

  useEffect(() => {
    setName(editing?.name ?? '');
    setIcon(editing?.icon ?? GOAL_ICONS[0]);
    setTarget(editing?.targetCents ? (editing.targetCents / 100).toFixed(2) : '');
    setTargetDate(editing?.targetDate ?? '');
    setConfirmDelete(false);
  }, [initial, editing]);

  const targetCents = parseCents(target);
  const valid = name.trim().length > 0 && targetCents !== null && targetCents > 0;

  const save = async () => {
    if (!valid || targetCents === null) return;
    await ops.save(editing?.id ?? null, {
      name: name.trim(),
      icon,
      targetCents,
      targetDate: targetDate || undefined,
      allocatedCents: editing?.allocatedCents ?? 0,
      archived: editing?.archived ?? 0,
    });
    onClose();
  };

  const removeGoal = async () => {
    if (!editing) return;
    if (!confirmDelete) {
      setConfirmDelete(true);
      return;
    }
    await ops.remove(editing.id);
    onClose();
  };

  return (
    <Sheet open={initial !== null} onOpenChange={(open) => !open && onClose()} title={editing ? t('goals.edit') : t('goals.new')} size="tall">
      <div className="flex flex-col gap-3 pt-1">
        <div className="flex gap-2 overflow-x-auto pb-1">
          {GOAL_ICONS.map((candidate) => (
            <button
              key={candidate}
              data-testid={`goalform-icon-${candidate}`}
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
          data-testid="goalform-name"
          value={name}
          onChange={(e) => setName(e.target.value)}
          placeholder={t('goals.namePlaceholder')}
          className="h-12 w-full rounded-input border border-line bg-surface px-4 text-[15px] text-ink outline-none placeholder:text-ink-4"
        />
        <div className="m-cap px-1">{t('goals.target')}</div>
        <input
          data-testid="goalform-target"
          type="number"
          inputMode="decimal"
          step="0.01"
          min="0"
          value={target}
          onChange={(e) => setTarget(e.target.value)}
          placeholder="0.00"
          className="h-12 w-full rounded-input border border-line bg-surface px-4 font-mono text-[15px] text-ink outline-none placeholder:text-ink-4"
        />
        <label className="flex items-center gap-3 text-[13px] text-ink-2">
          {t('goals.targetDate')}
          <input
            data-testid="goalform-date"
            type="date"
            value={targetDate}
            onChange={(e) => setTargetDate(e.target.value)}
            className="h-10 min-w-0 flex-1 appearance-none rounded-input border border-line bg-surface px-3 text-[14px] text-ink outline-none"
          />
        </label>
        <Button data-testid="goalform-save" onClick={() => void save()} disabled={!valid}>
          {editing ? t('action.save') : t('action.create')}
        </Button>
        {editing && (
          <Button variant="danger" data-testid="goalform-delete" onClick={() => void removeGoal()}>
            {confirmDelete ? t('action.confirm') : t('action.delete')}
          </Button>
        )}
      </div>
    </Sheet>
  );
}

/** All goals + the honesty header: saved vs allocated vs unallocated. */
export function GoalsScreen() {
  const { t, lang } = useLang();
  const navigate = useNavigate();
  const { db, spaceId } = useData();
  const goals = useGoals();
  const accounts = useSpaceAccounts();
  const space = useLiveQuery(() => db.spaces.get(spaceId), [spaceId]);
  const currency = space?.currency ?? 'EUR';
  const [formInitial, setFormInitial] = useState<GoalRow | 'new' | null>(null);

  const money = (cents: number) => fmtCents(cents, currency, lang);
  const overview = goalOverview(goals ?? [], accounts ?? []);
  const negative = overview.unallocatedCents < 0;
  const today = localToday();

  return (
    <div className="m-fade flex h-full flex-col" data-testid="screen-goals">
      <AppBar
        title={t('goals.title')}
        leading={
          <IconButton label={t('action.back')} testId="goals-back" onClick={() => window.history.back()}>
            <Icon name="arrow-left" size={22} />
          </IconButton>
        }
        trailing={
          <>
            <HelpButton tourId="goals" />
            <IconButton label={t('goals.new')} testId="goals-add" onClick={() => setFormInitial('new')}>
              <Icon name="plus" size={22} />
            </IconButton>
          </>
        }
      />
      <div className="min-h-0 flex-1 overflow-y-auto px-5 pb-6">
        <IntroCard tourId="goals" />
        {/* the honesty header — negative unallocated is the rebalance signal.
            Held back until both sides loaded so it never flashes €0 savings. */}
        {goals && accounts && (
          <div className="rounded-card border border-line bg-surface p-4" data-testid="goals-overview">
            <div className="grid grid-cols-3 gap-3">
              {(
                [
                  ['goals.saved', overview.savedCents, 'var(--m-ink)'],
                  ['goals.allocated', overview.allocatedCents, 'var(--m-accent-deep)'],
                  ['goals.unallocated', overview.unallocatedCents, negative ? 'var(--m-negative)' : 'var(--m-ink)'],
                ] as const
              ).map(([key, cents, color]) => (
                <div key={key}>
                  <div className="text-[10px] font-semibold tracking-wide text-ink-4 uppercase">{t(key)}</div>
                  <div className="mt-0.5 font-mono text-[15px] font-semibold" style={{ color }}>
                    {money(cents)}
                  </div>
                </div>
              ))}
            </div>
            {negative && (
              <p className="mt-3 flex items-center gap-1.5 text-[12px] text-negative" data-testid="goals-negative-note">
                <Icon name="alert-circle-outline" size={14} />
                {t('goals.negativeNote', { amount: money(-overview.unallocatedCents) })}
              </p>
            )}
          </div>
        )}

        <div className="flex flex-col gap-2.5 pt-3">
          {(goals ?? []).map((goal) => {
            const progress = goalProgress(goal);
            const pace = paceCentsPerMonth(goal, today);
            const reached = goal.allocatedCents >= goal.targetCents;
            let subtitle = t('goals.toGo', { amount: money(goal.targetCents - goal.allocatedCents) });
            if (reached) subtitle = t('goals.reached');
            else if (pace !== null) subtitle = t('goals.pace', { amount: money(pace) });
            return (
              <button
                key={goal.id}
                data-testid={`goal-card-${goal.id}`}
                onClick={() => void navigate({ to: '/goals/$goalId', params: { goalId: goal.id } })}
                className={`m-tap w-full rounded-card border border-line bg-surface p-4 text-left ${goal.archived === 1 ? 'opacity-60' : ''}`}
              >
                <div className="flex items-center gap-3">
                  <Tile icon={goal.icon ?? 'flag-outline'} />
                  <span className="min-w-0 flex-1">
                    <span className="flex items-baseline justify-between gap-2">
                      <span className="truncate text-[15px] font-semibold text-ink">{goal.name}</span>
                      <span className="m-num shrink-0 text-[13px] font-semibold text-ink">
                        {money(goal.allocatedCents)} / {money(goal.targetCents)}
                      </span>
                    </span>
                    <span className="block text-[11px] text-ink-4">{subtitle}</span>
                  </span>
                </div>
                <ProgressBar
                  className="mt-3"
                  value={progress}
                  color={reached ? 'var(--m-accent)' : 'var(--m-accent-deep)'}
                />
              </button>
            );
          })}
        </div>
        {goals?.length === 0 && (
          <div className="flex flex-col items-center gap-2 px-6 pt-16 text-center" data-testid="goals-empty">
            <Icon name="flag-outline" size={34} color="var(--m-ink-4)" />
            <p className="text-[14px] font-medium text-ink-2">{t('goals.emptyTitle')}</p>
            <p className="text-[12px] text-ink-4">{t('goals.emptyBody')}</p>
          </div>
        )}
      </div>
      <GoalFormSheet initial={formInitial} onClose={() => setFormInitial(null)} />
    </div>
  );
}
