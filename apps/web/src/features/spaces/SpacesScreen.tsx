import { useState } from 'react';
import { useLiveQuery } from 'dexie-react-hooks';
import { useLang } from '@/i18n';
import { useData } from '@/app/data';
import { useSession } from '@/app/session';
import { SpaceInvitesBanner, SpaceMembersSection } from './SpaceSharing';
import type { SpacePeriodType, SpaceRow } from '@/db/types';
import type { SpaceRole } from './SpaceSharing';
import { AppBar, IconButton } from '@/ui/AppBar';
import { Button } from '@/ui/Button';
import { Icon } from '@/ui/Icon';
import { Sheet } from '@/ui/Sheet';

const SPACE_ICONS = [
  'leaf', 'home-outline', 'account-group-outline', 'briefcase-outline', 'airplane', 'heart-outline',
  'piggy-bank-outline', 'cart-outline', 'star-outline', 'beach', 'paw', 'baby-carriage',
];
const SPACE_COLORS = ['#08372B', '#3498DB', '#27AE60', '#9B59B6', '#E74C3C', '#F39C12', '#16A085', '#E91E63'];
const CURRENCIES = ['EUR', 'USD', 'GBP', 'TRY', 'CHF', 'SEK', 'NOK', 'DKK', 'PLN'];
const PERIODS: SpacePeriodType[] = ['month', 'week', 'biweekly'];
const PERIOD_KEYS = {
  month: 'space.periodMonthly',
  week: 'space.periodWeekly',
  biweekly: 'space.periodBiweekly',
  custom: 'space.periodMonthly',
} as const;

/**
 * Spaces: separate bookkeeping areas, shared with other people or not.
 * The edit sheet is the space's settings: identity (name/icon/color),
 * money (currency/period/history start) and members (roles, ownership).
 */
export function SpacesScreen() {
  const { t } = useLang();
  const { db, repo, spaceId, setActiveSpace } = useData();
  const identity = useSession((s) => s.identity);
  const syncing = identity?.kind === 'user';
  const [createOpen, setCreateOpen] = useState(false);
  const [editing, setEditing] = useState<SpaceRow | null>(null);
  const [name, setName] = useState('');
  const [icon, setIcon] = useState(SPACE_ICONS[0]);
  const [color, setColor] = useState(SPACE_COLORS[0]);
  const [currency, setCurrency] = useState('EUR');
  const [periodType, setPeriodType] = useState<SpacePeriodType>('month');
  const [periodDay, setPeriodDay] = useState(1);
  const [historyStart, setHistoryStart] = useState('');
  const [deleteError, setDeleteError] = useState<string | null>(null);
  // role in the space being edited; local-only identities are always owner
  const [myRole, setMyRole] = useState<SpaceRole>('owner');

  const spaces = useLiveQuery(() => db.spaces.filter((s) => s.deleted === 0).toArray(), []);
  const readOnly = myRole === 'reader';

  const openEdit = (space: SpaceRow) => {
    setEditing(space);
    setName(space.name);
    setIcon(space.icon ?? SPACE_ICONS[0]);
    setColor(space.color ?? SPACE_COLORS[0]);
    setCurrency(space.currency);
    setPeriodType(space.periodType === 'custom' ? 'month' : space.periodType);
    setPeriodDay(space.periodDay || 1);
    setHistoryStart(space.historyStartDate ?? '');
    setDeleteError(null);
    setMyRole('owner'); // members section corrects this for shared spaces
  };

  const createSpace = () => {
    if (!name.trim()) return;
    const id = repo.newId();
    void repo
      .upsert('space', id, id, {
        name: name.trim(),
        kind: 'personal',
        currency: 'EUR',
        periodType: 'month',
        periodDay: 1,
      })
      .then(() => setActiveSpace(id));
    setCreateOpen(false);
    setName('');
  };

  const saveSettings = () => {
    if (!editing || !name.trim() || readOnly) return;
    void repo.upsert('space', editing.id, editing.id, {
      name: name.trim(),
      icon,
      color,
      currency,
      periodType,
      periodDay,
      historyStartDate: historyStart || undefined,
    });
    setEditing(null);
  };

  const deleteSpace = () => {
    if (!editing) return;
    if (editing.id === spaceId) {
      setDeleteError(t('space.cannotDeleteActive'));
      return;
    }
    if ((spaces ?? []).length <= 1) {
      setDeleteError(t('space.cannotDeleteOnly'));
      return;
    }
    void repo.remove('space', editing.id, editing.id);
    setEditing(null);
  };

  return (
    <div className="m-fade flex h-full flex-col" data-testid="screen-spaces">
      <AppBar
        large
        title={t('screen.spaces')}
        trailing={
          <IconButton
            label={t('space.new')}
            testId="spaces-add"
            onClick={() => {
              setName('');
              setCreateOpen(true);
            }}
          >
            <Icon name="plus" size={22} />
          </IconButton>
        }
      />
      <div className="min-h-0 flex-1 overflow-y-auto px-5 pb-6">
        {syncing && <SpaceInvitesBanner />}
        <div className="overflow-hidden rounded-card border border-line bg-surface">
          {(spaces ?? []).map((space, i) => {
            const active = space.id === spaceId;
            return (
              <div key={space.id}>
                {i > 0 && <div className="mx-4 h-px bg-line-2" />}
                <div className="flex items-center">
                  <button
                    data-testid={`space-row-${space.id}`}
                    onClick={() => void setActiveSpace(space.id)}
                    className="m-tap flex min-w-0 flex-1 items-center gap-3 border-none bg-transparent px-4 py-3.5 text-left"
                  >
                    <span
                      className="flex h-10 w-10 shrink-0 items-center justify-center rounded-full"
                      style={{
                        background: active ? (space.color ?? 'var(--m-accent)') + '22' : 'var(--m-bg-2)',
                        color: space.color ?? (active ? 'var(--m-accent-deep)' : 'var(--m-ink-3)'),
                      }}
                    >
                      <Icon name={space.icon ?? (space.kind === 'shared' ? 'account-group-outline' : 'leaf')} size={20} />
                    </span>
                    <span className="min-w-0 flex-1">
                      <span className="block truncate text-[15px] font-medium text-ink">{space.name}</span>
                      {active && <span className="block text-xs text-accent-deep">{t('space.active')}</span>}
                    </span>
                    {active && <Icon name="check" size={18} color="var(--m-accent)" />}
                  </button>
                  <button
                    aria-label={t('space.settings')}
                    data-testid={`space-edit-${space.id}`}
                    onClick={() => openEdit(space)}
                    className="m-tap flex h-9 w-9 shrink-0 items-center justify-center border-none bg-transparent text-ink-4"
                  >
                    <Icon name="cog-outline" size={18} />
                  </button>
                </div>
              </div>
            );
          })}
        </div>
      </div>

      {/* Create space */}
      <Sheet open={createOpen} onOpenChange={setCreateOpen} title={t('space.new')} height={300}>
        <div className="flex flex-col gap-3 pt-1">
          <input
            data-testid="space-create-name"
            value={name}
            onChange={(e) => setName(e.target.value)}
            placeholder={t('space.nameThisSpace')}
            className="h-12 w-full rounded-input border border-line bg-surface px-4 text-[15px] text-ink outline-none placeholder:text-ink-4"
          />
          <Button data-testid="space-create-save" onClick={createSpace} disabled={!name.trim()}>
            {t('space.create')}
          </Button>
        </div>
      </Sheet>

      {/* Space settings */}
      <Sheet open={!!editing} onOpenChange={(open) => !open && setEditing(null)} title={t('space.settings')} height={640}>
        <div className="flex flex-col gap-3 pt-1 pb-4">
          {readOnly && (
            <p className="rounded-card bg-bg-2 px-4 py-2.5 text-[13px] text-ink-3" data-testid="space-reader-note">
              {t('space.readerNote')}
            </p>
          )}
          <input
            data-testid="space-edit-name"
            value={name}
            onChange={(e) => setName(e.target.value)}
            disabled={readOnly}
            className="h-12 w-full rounded-input border border-line bg-surface px-4 text-[15px] text-ink outline-none disabled:opacity-60"
          />

          <div className="m-cap px-1">{t('space.icon')}</div>
          <div className="flex gap-2 overflow-x-auto pb-1">
            {SPACE_ICONS.map((name_) => (
              <button
                key={name_}
                data-testid={`space-icon-${name_}`}
                disabled={readOnly}
                onClick={() => setIcon(name_)}
                className={`m-tap flex h-10 w-10 shrink-0 items-center justify-center rounded-xl border ${
                  icon === name_ ? 'border-accent bg-accent-soft text-accent-deep' : 'border-line bg-surface text-ink-2'
                }`}
              >
                <Icon name={name_} size={19} />
              </button>
            ))}
          </div>

          <div className="m-cap px-1">{t('space.color')}</div>
          <div className="flex flex-wrap gap-2">
            {SPACE_COLORS.map((c) => (
              <button
                key={c}
                aria-label={c}
                data-testid={`space-color-${c.slice(1)}`}
                disabled={readOnly}
                onClick={() => setColor(c)}
                className={`m-tap h-8 w-8 rounded-full border-2 ${color === c ? 'border-ink' : 'border-transparent'}`}
                style={{ background: c }}
              />
            ))}
          </div>

          <div className="m-cap px-1">{t('space.currency')}</div>
          <div className="flex gap-2 overflow-x-auto pb-1">
            {CURRENCIES.map((c) => (
              <button
                key={c}
                data-testid={`space-currency-${c}`}
                disabled={readOnly}
                onClick={() => setCurrency(c)}
                className={`m-tap shrink-0 rounded-full border px-3 py-1.5 font-mono text-[12px] ${
                  currency === c ? 'border-accent bg-accent-soft font-semibold text-accent-deep' : 'border-line bg-surface text-ink-2'
                }`}
              >
                {c}
              </button>
            ))}
          </div>

          <div className="m-cap px-1">{t('space.periodTitle')}</div>
          <div className="flex gap-2">
            {PERIODS.map((p) => (
              <button
                key={p}
                data-testid={`space-period-${p}`}
                disabled={readOnly}
                onClick={() => setPeriodType(p)}
                className={`m-tap flex-1 rounded-full border px-3 py-1.5 text-[12px] ${
                  periodType === p ? 'border-accent bg-accent-soft font-medium text-accent-deep' : 'border-line bg-surface text-ink-2'
                }`}
              >
                {t(PERIOD_KEYS[p])}
              </button>
            ))}
          </div>
          {periodType === 'month' && (
            <label className="flex items-center gap-3 text-[13px] text-ink-2">
              {t('space.periodDayLabel')}
              <input
                data-testid="space-period-day"
                type="number"
                min={1}
                max={28}
                value={periodDay}
                disabled={readOnly}
                onChange={(e) => setPeriodDay(Math.min(28, Math.max(1, Number(e.target.value) || 1)))}
                className="h-10 w-20 rounded-input border border-line bg-surface px-3 text-[14px] text-ink outline-none"
              />
            </label>
          )}

          <div className="m-cap px-1">{t('space.historyStart')}</div>
          <p className="-mt-2 px-1 text-[11px] text-ink-4">{t('space.historyStartSub')}</p>
          <input
            data-testid="space-history-start"
            type="date"
            value={historyStart}
            disabled={readOnly}
            onChange={(e) => setHistoryStart(e.target.value)}
            className="h-12 w-full rounded-input border border-line bg-surface px-4 text-[15px] text-ink outline-none"
          />

          {!readOnly && (
            <Button data-testid="space-edit-save" onClick={saveSettings} disabled={!name.trim()}>
              {t('action.save')}
            </Button>
          )}
          {myRole === 'owner' && (
            <Button variant="danger" data-testid="space-edit-delete" onClick={deleteSpace}>
              {t('space.delete')}
            </Button>
          )}
          {deleteError && (
            <p className="text-center text-[13px] text-negative" data-testid="space-delete-error">
              {deleteError}
            </p>
          )}
          {syncing && editing && (
            <SpaceMembersSection
              spaceId={editing.id}
              spaceName={editing.name}
              onMyRole={setMyRole}
              onLeft={() => setEditing(null)}
            />
          )}
        </div>
      </Sheet>
    </div>
  );
}
