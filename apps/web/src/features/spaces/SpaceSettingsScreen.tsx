import { useRef, useState } from 'react';
import { useLiveQuery } from 'dexie-react-hooks';
import { useParams, useRouter } from '@tanstack/react-router';
import { useLang } from '@/i18n';
import { downscaleImage } from '@/lib/image';
import { useData } from '@/app/data';
import { useSession } from '@/app/session';
import { SpaceMembersSection } from './SpaceSharing';
import type { SpaceRole } from './SpaceSharing';
import type { SpacePeriodType } from '@/db/types';
import { AppBar, IconButton } from '@/ui/AppBar';
import { Button } from '@/ui/Button';
import { Icon } from '@/ui/Icon';

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
 * A space's settings as a full screen (was an overloaded sheet):
 * identity (name/icon/color), money (currency/period/history start) and
 * members (roles, ownership, leave). Browser back = route back.
 */
export function SpaceSettingsScreen() {
  const { t } = useLang();
  const { db, repo, spaceId: activeSpaceId } = useData();
  const identity = useSession((s) => s.identity);
  const syncing = identity?.kind === 'user';
  const { spaceId } = useParams({ strict: false }) as { spaceId: string };
  // router-aware back: window.history only drives the real hash history,
  // not the memory history used by tests
  const router = useRouter();
  const goBack = () => router.history.back();

  const space = useLiveQuery(() => db.spaces.get(spaceId), [spaceId]);
  const spaceCount = useLiveQuery(() => db.spaces.filter((s) => s.deleted === 0).count(), []);

  const [name, setName] = useState('');
  const [icon, setIcon] = useState(SPACE_ICONS[0]);
  const [color, setColor] = useState(SPACE_COLORS[0]);
  const [currency, setCurrency] = useState('EUR');
  const [periodType, setPeriodType] = useState<SpacePeriodType>('month');
  const [periodDay, setPeriodDay] = useState(1);
  const [historyStart, setHistoryStart] = useState('');
  const [picture, setPicture] = useState('');
  const [deleteError, setDeleteError] = useState<string | null>(null);
  const fileRef = useRef<HTMLInputElement>(null);
  // role in this space; local-only identities are always owner
  const [myRole, setMyRole] = useState<SpaceRole>('owner');
  const [loadedFor, setLoadedFor] = useState<string | null>(null);

  // initialize the form once per space DURING render (not an effect): the
  // inputs must never be interactable before initialization, or a fast
  // keystroke would be clobbered — and live-query refreshes must not
  // overwrite what the user is typing afterwards
  if (space && loadedFor !== space.id) {
    setLoadedFor(space.id);
    setName(space.name);
    setIcon(space.icon ?? SPACE_ICONS[0]);
    setColor(space.color ?? SPACE_COLORS[0]);
    setCurrency(space.currency);
    setPeriodType(space.periodType === 'custom' ? 'month' : space.periodType);
    setPeriodDay(space.periodDay || 1);
    setHistoryStart(space.historyStartDate ?? '');
    setPicture(space.picture ?? '');
  }

  const readOnly = myRole === 'reader';

  const save = () => {
    if (!space || !name.trim() || readOnly) return;
    void repo.upsert('space', space.id, space.id, {
      name: name.trim(),
      icon,
      color,
      currency,
      periodType,
      periodDay,
      historyStartDate: historyStart || undefined,
      picture, // '' clears a previously set image
    });
    goBack();
  };

  const deleteSpace = () => {
    if (!space) return;
    if (space.id === activeSpaceId) {
      setDeleteError(t('space.cannotDeleteActive'));
      return;
    }
    if ((spaceCount ?? 0) <= 1) {
      setDeleteError(t('space.cannotDeleteOnly'));
      return;
    }
    void repo.remove('space', space.id, space.id);
    goBack();
  };

  return (
    <div className="m-fade flex h-full flex-col" data-testid="screen-space-settings">
      <AppBar
        title={space?.name ?? t('space.settings')}
        leading={
          <IconButton label={t('action.back')} testId="spacesettings-back" onClick={() => goBack()}>
            <Icon name="chevron-left" size={24} />
          </IconButton>
        }
      />
      <div className="min-h-0 flex-1 overflow-y-auto px-5 pb-8">
        {space && (
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
            <input
              ref={fileRef}
              type="file"
              accept="image/*"
              hidden
              data-testid="space-photo-input"
              onChange={(e) => {
                const file = e.target.files?.[0];
                if (file) void downscaleImage(file, 128).then(setPicture).catch(() => undefined);
              }}
            />
            <div className="flex gap-2 overflow-x-auto pb-1">
              {/* own image: shown first, wins over the icon everywhere */}
              {picture ? (
                <button
                  data-testid="space-photo-clear"
                  disabled={readOnly}
                  onClick={() => setPicture('')}
                  title={t('action.delete')}
                  className="m-tap relative h-10 w-10 shrink-0 overflow-hidden rounded-xl border border-accent"
                >
                  <img src={picture} alt="" className="h-full w-full object-cover" />
                  <span className="absolute inset-0 flex items-center justify-center bg-black/35 text-white">
                    <Icon name="close" size={14} />
                  </span>
                </button>
              ) : (
                <button
                  data-testid="space-photo-upload"
                  disabled={readOnly}
                  onClick={() => fileRef.current?.click()}
                  title={t('profile.photoUpload')}
                  className="m-tap flex h-10 w-10 shrink-0 items-center justify-center rounded-xl border border-dashed border-line bg-surface text-ink-3"
                >
                  <Icon name="camera-outline" size={17} />
                </button>
              )}
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
              <Button data-testid="space-edit-save" onClick={save} disabled={!name.trim()}>
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
            {syncing && (
              <SpaceMembersSection
                spaceId={space.id}
                spaceName={space.name}
                onMyRole={setMyRole}
                onLeft={() => goBack()}
              />
            )}
          </div>
        )}
      </div>
    </div>
  );
}
