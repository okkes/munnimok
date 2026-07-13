import { useRef, useState } from 'react';
import { useLiveQuery } from 'dexie-react-hooks';
import { useParams, useRouter } from '@tanstack/react-router';
import { LOCALES, useLang } from '@/i18n';
import { downscaleImage } from '@/lib/image';
import { useData } from '@/app/data';
import { useSession } from '@/app/session';
import { useMyRole } from './SpaceSharing';
import type { SpacePeriodType } from '@/db/types';
import { AppBar, IconButton } from '@/ui/AppBar';
import { Button } from '@/ui/Button';
import { ColorPicker } from '@/ui/ColorPicker';
import { Icon } from '@/ui/Icon';
import { Chip } from '@/ui/primitives';

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

const WEEKDAYS = [1, 2, 3, 4, 5, 6, 7]; // ISO: Monday … Sunday
const clampWeekday = (day: number) => Math.min(Math.max(day || 1, 1), 7);
const isoMonthsAgo = (months: number): string => {
  const d = new Date();
  d.setMonth(d.getMonth() - months);
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
};
/** localized short weekday name — 5 Jan 2020 + n lands on ISO weekday n */
const weekdayName = (weekday: number, lang: keyof typeof LOCALES) =>
  new Intl.DateTimeFormat(LOCALES[lang], { weekday: 'short' }).format(new Date(2020, 0, 5 + weekday));

/**
 * A space's settings as a full screen: identity (name/icon/color) and
 * money (currency/period/history start). Members and financial accounts
 * live on their own screens, reached from Settings (user remark: the
 * doors here were redundant). Browser back = route back.
 */
export function SpaceSettingsScreen() {
  const { t, lang } = useLang();
  const { db, repo, spaceId: activeSpaceId } = useData();
  const identity = useSession((s) => s.identity);
  const syncing = identity?.kind === 'user';
  const { spaceId } = useParams({ strict: false }) as { spaceId: string };
  // router-aware back: window.history only drives the real hash history,
  // not the memory history used by tests
  const router = useRouter();
  const goBack = () => router.history.back();

  const space = useLiveQuery(() => db.spaces.get(spaceId), [spaceId]);

  const [name, setName] = useState('');
  const [icon, setIcon] = useState(SPACE_ICONS[0]);
  const [color, setColor] = useState(SPACE_COLORS[0]);
  const [currency, setCurrency] = useState('EUR');
  const [periodType, setPeriodType] = useState<SpacePeriodType>('month');
  const [periodDay, setPeriodDay] = useState(1);
  // free-typed draft so the '1' can be deleted while editing; clamped on blur
  const [periodDayText, setPeriodDayText] = useState('1');
  const [historyStart, setHistoryStart] = useState('');
  const [picture, setPicture] = useState('');
  const [deleteError, setDeleteError] = useState<string | null>(null);
  const [confirmDelete, setConfirmDelete] = useState(false);
  const fileRef = useRef<HTMLInputElement>(null);
  // role in this space; local-only identities are always owner
  const myRole = useMyRole(spaceId, syncing);
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
    setPeriodDayText(String(space.periodDay || 1));
    // default 3 months back (approved accounts ruling) — an empty iOS
    // date input also renders as a blank bar, so it always has a value
    setHistoryStart(space.historyStartDate ?? isoMonthsAgo(3));
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

  const deleteSpace = async () => {
    if (!space) return;
    if (space.id === activeSpaceId) {
      setDeleteError(t('space.cannotDeleteActive'));
      return;
    }
    // counted on demand — a liveQuery would read undefined (= "only
    // space") for a tap that lands before its first emission
    const count = await db.spaces.filter((s) => s.deleted === 0).count();
    if (count <= 1) {
      setDeleteError(t('space.cannotDeleteOnly'));
      return;
    }
    if (!confirmDelete) {
      setConfirmDelete(true); // destructive: second tap confirms
      return;
    }
    await repo.remove('space', space.id, space.id);
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
      {/* overflow-x-hidden: wide chip rows must swipe inside their own
          containers, never pan the whole screen sideways */}
      <div className="min-h-0 flex-1 overflow-x-hidden overflow-y-auto px-5 pb-8">
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
            <ColorPicker
              colors={SPACE_COLORS}
              value={color}
              onChange={setColor}
              disabled={readOnly}
              testIdPrefix="space-color"
              customLabel={t('color.custom')}
            />

            <div className="m-cap px-1">{t('space.currency')}</div>
            <div className="flex gap-2 overflow-x-auto pb-1">
              {CURRENCIES.map((c) => (
                <Chip
                  key={c}
                  className="font-mono"
                  testId={`space-currency-${c}`}
                  disabled={readOnly}
                  selected={currency === c}
                  onClick={() => setCurrency(c)}
                >
                  {c}
                </Chip>
              ))}
            </div>

            <div className="m-cap px-1">{t('space.periodTitle')}</div>
            {/* wrap: NL/TR labels (Tweewekelijks…) must never widen the page */}
            <div className="flex flex-wrap gap-2">
              {PERIODS.map((p) => (
                <Chip
                  key={p}
                  className="min-w-[30%] flex-1"
                  testId={`space-period-${p}`}
                  disabled={readOnly}
                  selected={periodType === p}
                  onClick={() => setPeriodType(p)}
                >
                  {t(PERIOD_KEYS[p])}
                </Chip>
              ))}
            </div>
            {periodType === 'month' ? (
              <label className="flex items-center gap-3 text-[13px] text-ink-2">
                {t('space.periodDayLabel')}
                <input
                  data-testid="space-period-day"
                  type="number"
                  min={1}
                  max={28}
                  value={periodDayText}
                  disabled={readOnly}
                  onChange={(e) => setPeriodDayText(e.target.value)}
                  onBlur={() => {
                    const clamped = Math.min(28, Math.max(1, Number(periodDayText) || 1));
                    setPeriodDay(clamped);
                    setPeriodDayText(String(clamped));
                  }}
                  className="h-10 w-20 rounded-input border border-line bg-surface px-3 text-[14px] text-ink outline-none"
                />
              </label>
            ) : (
              // weekly/bi-weekly periods start on a chosen weekday (legacy parity)
              <div className="flex flex-wrap gap-1.5">
                {WEEKDAYS.map((weekday) => (
                  <button
                    key={weekday}
                    data-testid={`space-weekday-${weekday}`}
                    disabled={readOnly}
                    onClick={() => setPeriodDay(weekday)}
                    className={`m-tap rounded-full border px-2.5 py-1.5 text-[12px] ${
                      clampWeekday(periodDay) === weekday
                        ? 'border-accent bg-accent-soft font-medium text-accent-deep'
                        : 'border-line bg-surface text-ink-2'
                    }`}
                  >
                    {weekdayName(weekday, lang)}
                  </button>
                ))}
              </div>
            )}

            <div className="m-cap px-1">{t('space.historyStart')}</div>
            <p className="-mt-2 px-1 text-[11px] text-ink-4">{t('space.historyStartSub')}</p>
            <input
              data-testid="space-history-start"
              type="date"
              value={historyStart}
              disabled={readOnly}
              onChange={(e) => setHistoryStart(e.target.value)}
              className="h-12 w-full appearance-none rounded-input border border-line bg-surface px-4 text-left text-[15px] text-ink outline-none"
            />

            {!readOnly && (
              <Button data-testid="space-edit-save" onClick={save} disabled={!name.trim()}>
                {t('action.save')}
              </Button>
            )}

            {/* danger zone last: deleting is the one action that must never sit
                between things people actually come here for */}
            {myRole === 'owner' && (
              <div className="mt-4 flex flex-col gap-2">
                {confirmDelete && (
                  <p className="px-1 text-[13px] text-ink-3" data-testid="space-delete-confirm-note">
                    {t('space.deleteConfirmNote')}
                  </p>
                )}
                <Button variant="danger" data-testid="space-edit-delete" onClick={() => void deleteSpace()}>
                  {confirmDelete ? t('action.confirm') : t('space.delete')}
                </Button>
              </div>
            )}
            {deleteError && (
              <p className="text-center text-[13px] text-negative" data-testid="space-delete-error">
                {deleteError}
              </p>
            )}
          </div>
        )}
      </div>
    </div>
  );
}
