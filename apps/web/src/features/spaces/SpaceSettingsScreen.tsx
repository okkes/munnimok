import { useRef, useState } from 'react';
import { useLiveQuery } from 'dexie-react-hooks';
import { useNavigate, useParams, useRouter } from '@tanstack/react-router';
import { LOCALES, useLang } from '@/i18n';
import { downscaleImage } from '@/lib/image';
import { useData } from '@/app/data';
import { useSession } from '@/app/session';
import { SpaceMembersSection } from './SpaceSharing';
import type { SpaceRole } from './SpaceSharing';
import type { AccountRow, SpacePeriodType } from '@/db/types';
import { AppBar, IconButton } from '@/ui/AppBar';
import { Button } from '@/ui/Button';
import { ColorPicker } from '@/ui/ColorPicker';
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

const WEEKDAYS = [1, 2, 3, 4, 5, 6, 7]; // ISO: Monday … Sunday
const clampWeekday = (day: number) => Math.min(Math.max(day || 1, 1), 7);
/** localized short weekday name — 5 Jan 2020 + n lands on ISO weekday n */
const weekdayName = (weekday: number, lang: keyof typeof LOCALES) =>
  new Intl.DateTimeFormat(LOCALES[lang], { weekday: 'short' }).format(new Date(2020, 0, 5 + weekday));

interface AttachedAccountEntry {
  key: string;
  name: string;
  subtitle: string;
  archived: boolean;
}

/**
 * The financial accounts this space sees: manual/imported accounts that
 * live in the space itself plus feed accounts attached via accountLink
 * rows. Pure local data — renders offline for every identity.
 */
function AttachedAccountsSection({ spaceId }: Readonly<{ spaceId: string }>) {
  const { t } = useLang();
  const { db } = useData();
  const navigate = useNavigate();

  const entries = useLiveQuery(async () => {
    // reads only — a teardown/closed-db rejection must never escape
    const [ownAccounts, links] = await Promise.all([
      db.accounts.filter((a) => a.deleted === 0 && a.spaceId === spaceId).toArray(),
      db.accountLinks.filter((l) => l.deleted === 0 && l.spaceId === spaceId).toArray(),
    ]).catch(() => [[], []] as const);
    const feedAccounts = new Map<string, AccountRow>();
    const linked = await db.accounts.where('id').anyOf(links.map((l) => l.accountId)).toArray().catch(() => []);
    for (const account of linked) {
      feedAccounts.set(account.id, account);
    }
    const ibanTail = (iban?: string) => (iban ? `…${iban.slice(-4)}` : undefined);
    const list: AttachedAccountEntry[] = ownAccounts.map((account) => ({
      key: account.id,
      name: account.name,
      subtitle: [ibanTail(account.iban), t(account.source === 'manual' ? 'acct.manual' : 'acct.automated')]
        .filter(Boolean)
        .join(' · '),
      archived: !!account.archived,
    }));
    for (const link of links) {
      const account = feedAccounts.get(link.accountId);
      list.push({
        key: link.id,
        name: account?.name ?? t('acct.bank'),
        subtitle: [
          ibanTail(account?.iban),
          link.attachedByName ? `${t('space.by')} ${link.attachedByName}` : undefined,
          link.historyFrom ? `${t('acct.historyFrom')} ${link.historyFrom}` : undefined,
        ]
          .filter(Boolean)
          .join(' · '),
        archived: !!link.archived,
      });
    }
    list.sort((x, y) => x.name.localeCompare(y.name));
    return list;
  }, [db, spaceId]);

  return (
    <div className="mt-2" data-testid="space-accounts">
      <div className="m-cap mb-1 px-1">{t('space.financialAccounts')}</div>
      {entries?.length === 0 && (
        <p className="px-1 text-[13px] text-ink-4" data-testid="space-accounts-empty">
          {t('space.noAccounts')}
        </p>
      )}
      {!!entries?.length && (
        <div className="overflow-hidden rounded-card border border-line bg-surface">
          {entries.map((entry) => (
            <div key={entry.key} className="flex items-center gap-3 border-b border-line-2 px-4 py-2.5 last:border-0">
              <Icon name="bank-outline" size={18} color="var(--m-ink-3)" />
              <span className="min-w-0 flex-1">
                <span className="block truncate text-[14px] text-ink">{entry.name}</span>
                {entry.subtitle && <span className="block truncate text-[12px] text-ink-4">{entry.subtitle}</span>}
              </span>
              {entry.archived && (
                <span className="shrink-0 rounded-full bg-bg-2 px-2 py-0.5 text-[11px] text-ink-3">
                  {t('acct.archived')}
                </span>
              )}
            </div>
          ))}
        </div>
      )}
      <button
        data-testid="space-accounts-manage"
        onClick={() => void navigate({ to: '/accounts' })}
        className="m-tap mt-1.5 flex items-center gap-1 border-none bg-transparent px-1 text-[13px] text-accent-deep"
      >
        {t('space.manageAccounts')}
        <Icon name="chevron-right" size={15} />
      </button>
    </div>
  );
}

/**
 * A space's settings as a full screen (was an overloaded sheet):
 * identity (name/icon/color), money (currency/period/history start) and
 * members (roles, ownership, leave). Browser back = route back.
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
  const [historyStart, setHistoryStart] = useState('');
  const [picture, setPicture] = useState('');
  const [deleteError, setDeleteError] = useState<string | null>(null);
  const [confirmDelete, setConfirmDelete] = useState(false);
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
            {/* wrap: NL/TR labels (Tweewekelijks…) must never widen the page */}
            <div className="flex flex-wrap gap-2">
              {PERIODS.map((p) => (
                <button
                  key={p}
                  data-testid={`space-period-${p}`}
                  disabled={readOnly}
                  onClick={() => setPeriodType(p)}
                  className={`m-tap min-w-[30%] flex-1 rounded-full border px-3 py-1.5 text-[12px] ${
                    periodType === p ? 'border-accent bg-accent-soft font-medium text-accent-deep' : 'border-line bg-surface text-ink-2'
                  }`}
                >
                  {t(PERIOD_KEYS[p])}
                </button>
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
                  value={periodDay}
                  disabled={readOnly}
                  onChange={(e) => setPeriodDay(Math.min(28, Math.max(1, Number(e.target.value) || 1)))}
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
              className="h-12 w-full rounded-input border border-line bg-surface px-4 text-[15px] text-ink outline-none"
            />

            {!readOnly && (
              <Button data-testid="space-edit-save" onClick={save} disabled={!name.trim()}>
                {t('action.save')}
              </Button>
            )}
            {syncing && (
              <SpaceMembersSection
                spaceId={space.id}
                spaceName={space.name}
                onMyRole={setMyRole}
                onLeft={() => goBack()}
              />
            )}
            <AttachedAccountsSection spaceId={space.id} />
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
