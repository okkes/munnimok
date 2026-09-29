import { useEffect, useMemo, useRef, useState } from 'react';
import { useQuery } from '@/db/useQuery';
import { useNavigate, useParams } from '@tanstack/react-router';
import { useLang } from '@/i18n';
import { useData } from '@/app/data';
import { useBudgetOps, useBudgets } from '@/application/budgets';
import { localToday } from '@/application/recurring';
import { budgetFamily, categoryConflicts } from '@/domain/budgets';
import { LOCKED_MAIN_IDS } from '@/domain/categories';
import type { BudgetCarryMode, BudgetEvery, BudgetRow } from '@/db/types';
import { catName, useCategories } from '@/features/categories/useCategories';
import { AppBar, IconButton } from '@/ui/AppBar';
import { useDiscardGuard } from '@/ui/DiscardGuard';
import { FormBlockerNote } from '@/ui/FormBlockerNote';
import { Button } from '@/ui/Button';
import { Collapse } from '@/ui/Collapse';
import { Icon } from '@/ui/Icon';
import { Chip } from '@/ui/primitives';
import { SearchField } from '@/ui/SearchField';
import { BUDGET_ICONS } from './budgetUi';
import { MDI_NAMES } from '@/generated/mdiNames';
import { SpacePhotoStrip } from '@/features/spaces/SpaceSettingsScreen';

/**
 * Create/edit a budget — a full screen, not a sheet: icon, name, amount,
 * cadence + anchor, the category checklist with exclusivity badges,
 * carry-over configuration and the warning threshold.
 */
/** #374: a category row's tick — full, half (some free subs picked) or empty */
type TickState = 'checked' | 'half' | 'off';
const tickStateOf = (checked: boolean, half: boolean): TickState => {
  if (checked) return 'checked';
  if (half) return 'half';
  return 'off';
};
const TICK_BOX: Record<TickState, string> = {
  checked: 'border-accent bg-accent',
  half: 'border-accent bg-accent-soft',
  off: 'border-line bg-transparent',
};

export function BudgetFormScreen() {
  const { t } = useLang();
  const navigate = useNavigate();
  const { store, spaceId } = useData();
  const { budgetId } = useParams({ strict: false }) as { budgetId?: string };
  const budgets = useBudgets();
  const ops = useBudgetOps();
  const cats = useCategories();
  const space = useQuery(store, async () => store.get('space', spaceId), [spaceId]);

  const editing = budgets?.find((b) => b.id === budgetId);
  const [name, setName] = useState('');
  const [icon, setIcon] = useState<string>(BUDGET_ICONS[0]);
  // #373: the whole icon font by search, or an own picture
  const [iconQuery, setIconQuery] = useState('');
  const [picture, setPicture] = useState('');
  const [amount, setAmount] = useState('');
  const [every, setEvery] = useState<BudgetEvery>('month');
  const [anchor, setAnchor] = useState(localToday());
  // #371: monthly budgets may reset on a day other than the start date's
  const [resetDayText, setResetDayText] = useState('');
  const [catIds, setCatIds] = useState<string[]>([]);
  // long list tamed (user request): search + fold, mains start collapsed
  const [catQuery, setCatQuery] = useState('');
  const [openCats, setOpenCats] = useState<ReadonlySet<string>>(new Set());
  const [carryOver, setCarryOver] = useState(false);
  const [carryMode, setCarryMode] = useState<BudgetCarryMode>('periods');
  const [carryPeriods, setCarryPeriods] = useState(1);
  // free-typed draft so the '1' can be deleted while editing; clamped on blur
  const [carryPeriodsText, setCarryPeriodsText] = useState('1');
  const [carryCap, setCarryCap] = useState('');
  const [notifyAtPct, setNotifyAtPct] = useState(0);
  const [confirmDelete, setConfirmDelete] = useState(false);
  const [loaded, setLoaded] = useState(false);

  useEffect(() => {
    if (!editing || loaded) return;
    setName(editing.name);
    setIcon(editing.icon ?? BUDGET_ICONS[0]);
    setPicture(editing.picture ?? '');
    setAmount((editing.amountCents / 100).toFixed(2));
    setEvery(editing.every);
    setAnchor(editing.anchor);
    setResetDayText(editing.resetDay ? String(editing.resetDay) : '');
    setCatIds(editing.catIds);
    setCarryOver(editing.carryOver === 1);
    setCarryMode(editing.carryMode ?? 'periods');
    setCarryPeriods(editing.carryPeriods ?? 1);
    setCarryPeriodsText(String(editing.carryPeriods ?? 1));
    setCarryCap(editing.carryCapCents ? (editing.carryCapCents / 100).toFixed(2) : '');
    setNotifyAtPct(editing.notifyAtPct ?? 0);
    setLoaded(true);
  }, [editing, loaded]);

  // exclusivity: categories other budgets already claim get a badge
  const otherBudgets = useMemo(
    () => (budgets ?? []).filter((b): b is BudgetRow => b.id !== budgetId),
    [budgets, budgetId],
  );
  // the locked reimbursement tree is excluded from budget math (rule c) —
  // budgeting it would be budgeting money that is not spending
  const expenseParents = useMemo(
    () => cats.parents.filter((p) => p.txTypes.includes('expense') && !LOCKED_MAIN_IDS.has(p.id)),
    [cats],
  );
  const conflictCandidates = useMemo(
    () => expenseParents.flatMap((p) => [p.id, ...cats.childrenOf(p.id).map((c) => c.id)]),
    [expenseParents, cats],
  );
  const conflicts = useMemo(
    () => categoryConflicts(conflictCandidates, otherBudgets, cats),
    [conflictCandidates, otherBudgets, cats],
  );
  // a checked main claims its subs — the family covers them
  const ownFamily = useMemo(() => budgetFamily(catIds, cats), [catIds, cats]);
  // #374: a main whose subs are partly claimed elsewhere is still pickable — it takes the free subs
  const wholeMainOwner = (parentId: string) => otherBudgets.find((b) => b.catIds.includes(parentId))?.name;
  const freeSubsOf = (parentId: string) => cats.childrenOf(parentId).filter((sub) => !conflicts.get(sub.id)).map((sub) => sub.id);
  const claimedSubsOf = (parentId: string) => cats.childrenOf(parentId).filter((sub) => !!conflicts.get(sub.id)).length;

  const toggleCat = (id: string) =>
    setCatIds((prev) => (prev.includes(id) ? prev.filter((x) => x !== id) : [...prev, id]));
  const toggleMain = (parentId: string) => {
    if (catIds.includes(parentId)) {
      setCatIds((prev) => prev.filter((x) => x !== parentId));
      return;
    }
    if (claimedSubsOf(parentId) === 0) {
      const subIds = new Set(cats.childrenOf(parentId).map((sub) => sub.id));
      setCatIds((prev) => [...prev.filter((x) => !subIds.has(x)), parentId]);
      return;
    }
    const free = freeSubsOf(parentId);
    const allFree = free.length > 0 && free.every((id) => catIds.includes(id));
    setCatIds((prev) => (allFree ? prev.filter((x) => !free.includes(x)) : [...new Set([...prev, ...free])]));
  };

  const amountCents = Math.round(Number.parseFloat(amount.replace(',', '.')) * 100);
  const valid = name.trim().length > 0 && Number.isFinite(amountCents) && amountCents > 0 && catIds.length > 0 && !!anchor;
  // #195: the save stays tappable — an invalid tap names the blocker.
  // r2 (user): the note renders under the field it names — one
  // (field, text) pair at a time, the note scrolls itself into view
  const [attempted, setAttempted] = useState(false);
  const [blockerField, blockerText] = ((): [string, string] => {
    if (!attempted || valid) return ['', ''];
    if (!name.trim()) return ['name', t('form.needName')];
    if (!Number.isFinite(amountCents) || amountCents <= 0) return ['amount', t('form.needAmount')];
    if (catIds.length === 0) return ['cats', t('form.needCategory')];
    return ['anchor', t('form.needFields')]; // only the anchor is left to miss
  })();
  // #164: edits guard the back arrow — the draft is dirty once any field
  // moved away from the seeded state (creation counts from blank)
  const draftPrint = JSON.stringify([name, icon, picture, amount, every, anchor, resetDayText, catIds, carryOver, carryMode, carryPeriods, carryCap, notifyAtPct]);
  const baselineRef = useRef<string | null>(null);
  if (baselineRef.current === null && (!budgetId || loaded)) baselineRef.current = draftPrint;
  const formDirty = baselineRef.current !== null && draftPrint !== baselineRef.current;
  const { guardedBack, sheet: discardSheet } = useDiscardGuard(formDirty, () => window.history.back());

  const save = async () => {
    if (!valid) return;
    const capCents = Math.round(Number.parseFloat(carryCap.replace(',', '.')) * 100);
    const resetDay = Math.min(28, Math.max(1, Number(resetDayText) || 0));
    await ops.save(editing?.id ?? null, {
      name: name.trim(),
      icon,
      picture: picture || undefined,
      amountCents,
      every,
      anchor,
      resetDay: every === 'month' && resetDayText.trim() ? resetDay : undefined,
      catIds,
      carryOver: carryOver ? 1 : 0,
      carryMode: carryOver ? carryMode : undefined,
      carryPeriods: carryOver && carryMode === 'periods' ? Math.max(1, carryPeriods) : undefined,
      carryCapCents: carryOver && carryMode === 'cap' && Number.isFinite(capCents) && capCents > 0 ? capCents : undefined,
      notifyAtPct: notifyAtPct || undefined,
      active: editing?.active ?? 1,
    });
    if (editing) await navigate({ to: '/budgets/$budgetId', params: { budgetId: editing.id }, replace: true });
    else await navigate({ to: '/budgets', replace: true });
  };

  const removeBudget = async () => {
    if (!editing) return;
    if (!confirmDelete) {
      setConfirmDelete(true);
      return;
    }
    await ops.remove(editing.id);
    await navigate({ to: '/budgets', replace: true });
  };

  const currency = space?.currency ?? 'EUR';

  const renderCatRow = (id: string, indent: boolean) => {
    const cat = cats.byId(id);
    const isMain = !indent;
    // #374: a main is blocked only when another budget holds the WHOLE main; claimed subs just stay out of the tick
    const conflictOwner = isMain ? wholeMainOwner(id) : conflicts.get(id);
    const coveredByMain = !catIds.includes(id) && ownFamily.has(id);
    const disabled = !!conflictOwner || coveredByMain;
    const free = isMain ? freeSubsOf(id) : [];
    const half = isMain && !catIds.includes(id) && free.some((sub) => catIds.includes(sub));
    const checked = catIds.includes(id) || coveredByMain || (isMain && free.length > 0 && free.every((sub) => catIds.includes(sub)) && claimedSubsOf(id) > 0);
    const tick = tickStateOf(checked, half);
    return (
      <button
        key={id}
        data-testid={`budget-cat-${id}`}
        data-state={tick}
        disabled={disabled}
        onClick={() => (isMain ? toggleMain(id) : toggleCat(id))}
        className={`m-tap flex w-full items-center gap-3 border-b border-line-2 bg-transparent py-2.5 text-left last:border-0 ${indent ? 'pl-8' : 'pl-1'} ${disabled ? 'opacity-45' : ''}`}
      >
        <span
          className={`flex h-5 w-5 shrink-0 items-center justify-center rounded-md border ${TICK_BOX[tick]}`}
        >
          {checked && <Icon name="check" size={12} color="#fff" />}
          {!checked && half && <Icon name="minus" size={12} color="var(--m-accent-deep)" />}
        </span>
        <Icon name={cat.icon} size={16} color={cat.color ?? cats.byId(cat.parentId)?.color ?? 'var(--m-ink-3)'} />
        <span className="min-w-0 flex-1 truncate text-[14px] text-ink">{catName(cat, t)}</span>
        {conflictOwner && (
          <span className="shrink-0 rounded-full bg-bg-2 px-2 py-0.5 text-[10px] font-medium text-ink-3" data-testid={`budget-cat-conflict-${id}`}>
            {t('budgets.inBudget', { name: conflictOwner })}
          </span>
        )}
      </button>
    );
  };

  return (
    <div className="m-fade flex h-full flex-col" data-testid="screen-budget-form">
      <AppBar
        title={editing ? t('budgets.edit') : t('budgets.new')}
        leading={
          <IconButton label={t('action.back')} testId="budgetform-back" onClick={guardedBack}>
            <Icon name="arrow-left" size={22} />
          </IconButton>
        }
      />
      {discardSheet}
      <div className="min-h-0 flex-1 overflow-y-auto px-5 pb-6">
        <div className="flex flex-col gap-3 pt-1">
          {/* #373: an own picture wins over the icon; the curated icons by default, the whole font by search */}
          <SpacePhotoStrip picture={picture} onPicture={setPicture} onWebcam={null} testIdPrefix="budgetform-photo" />
          <SearchField testId="budgetform-icon-search" value={iconQuery} onChange={setIconQuery} placeholder={t('cats.iconSearch')} height="h-10" textSize="text-[13px]" />
          <div className="grid max-h-40 grid-cols-6 gap-2 overflow-y-auto">
            {(iconQuery.trim() ? MDI_NAMES.filter((n) => n.includes(iconQuery.trim().toLowerCase())).slice(0, 48) : BUDGET_ICONS).map((candidate) => (
              <button
                key={candidate}
                data-testid={`budgetform-icon-${candidate}`}
                title={candidate}
                onClick={() => setIcon(candidate)}
                className={`m-tap flex h-11 items-center justify-center rounded-xl border ${
                  icon === candidate && !picture ? 'border-accent bg-accent-soft text-accent-deep' : 'border-line bg-surface text-ink-2'
                }`}
              >
                <Icon name={candidate} size={19} />
              </button>
            ))}
            {iconQuery.trim() && MDI_NAMES.every((n) => !n.includes(iconQuery.trim().toLowerCase())) && (
              <p className="col-span-6 py-2 text-center text-[12px] text-ink-4">{t('cats.iconNone')}</p>
            )}
          </div>

          <input
            data-testid="budgetform-name"
            value={name}
            onChange={(e) => setName(e.target.value)}
            placeholder={t('budgets.namePlaceholder')}
            className="h-12 w-full rounded-input border border-line bg-surface px-4 text-[15px] text-ink outline-none placeholder:text-ink-4"
          />
          {/* #195 r2 (user): the blocker sits AT the field */}
          <FormBlockerNote show={blockerField === 'name'} text={blockerText} testId="budgetform-blocker" />

          <div className="m-cap px-1">{t('budgets.amount', { currency })}</div>
          <input
            data-testid="budgetform-amount"
            type="number"
            inputMode="decimal"
            step="0.01"
            min="0"
            value={amount}
            onChange={(e) => setAmount(e.target.value)}
            placeholder="0.00"
            className="h-12 w-full rounded-input border border-line bg-surface px-4 font-mono text-[15px] text-ink outline-none placeholder:text-ink-4"
          />
          <FormBlockerNote show={blockerField === 'amount'} text={blockerText} testId="budgetform-blocker" />

          <div className="m-cap px-1">{t('budgets.cadence')}</div>
          <div className="flex flex-wrap items-center gap-2">
            {(
              [
                ['week', 'budgets.everyWeek'],
                ['2weeks', 'budgets.every2Weeks'],
                ['month', 'budgets.everyMonth'],
                ['period', 'budgets.everyPeriod'],
              ] as const
            ).map(([value, labelKey]) => (
              <Chip key={value} testId={`budgetform-every-${value}`} selected={every === value} onClick={() => setEvery(value)}>
                {t(labelKey)}
              </Chip>
            ))}
          </div>
          <label className="flex items-center gap-3 text-[13px] text-ink-2">
            {t('budgets.anchor')}
            <input
              data-testid="budgetform-anchor"
              type="date"
              value={anchor}
              onChange={(e) => setAnchor(e.target.value)}
              className="h-10 rounded-input border border-line bg-surface px-3 text-[14px] text-ink outline-none"
            />
          </label>
          <FormBlockerNote show={blockerField === 'anchor'} text={blockerText} testId="budgetform-blocker" />
          {every === 'month' && (
            <label className="flex flex-wrap items-center gap-3 text-[13px] text-ink-2">
              {t('budgets.resetDay')}
              <input
                data-testid="budgetform-resetday"
                type="number"
                inputMode="numeric"
                min={1}
                max={28}
                value={resetDayText}
                onChange={(e) => setResetDayText(e.target.value)}
                onBlur={() => {
                  if (!resetDayText.trim()) return;
                  setResetDayText(String(Math.min(28, Math.max(1, Number(resetDayText) || 1))));
                }}
                placeholder={String(Number(anchor.slice(8, 10)) || 1)}
                className="h-10 w-20 rounded-input border border-line bg-surface px-3 text-[14px] text-ink outline-none placeholder:text-ink-4"
              />
              <span className="text-[11px] text-ink-4">{t('budgets.resetDayHint')}</span>
            </label>
          )}
          {every === 'period' && (
            <p className="px-1 text-[11px] text-ink-4" data-testid="budgetform-period-note">
              {t('budgets.everyPeriodNote')}
            </p>
          )}

          <div className="m-cap px-1">
            {t('screen.categories')} · {catIds.length}
          </div>
          <SearchField
            testId="budgetform-cat-search"
            value={catQuery}
            onChange={setCatQuery}
            placeholder={t('cats.searchPlaceholder')}
            height="h-10"
            textSize="text-[14px]"
          />
          <div className="rounded-card border border-line bg-surface px-3 py-1" data-testid="budgetform-cats">
            {expenseParents.map((parent) => {
              const q = catQuery.trim().toLowerCase();
              const subs = cats.childrenOf(parent.id);
              const matches = (id: string) => !q || catName(cats.byId(id), t).toLowerCase().includes(q);
              const anySub = subs.some((sub) => matches(sub.id));
              if (q && !matches(parent.id) && !anySub) return null;
              // searching unfolds the hits; otherwise the fold state rules
              const open = q ? true : openCats.has(parent.id);
              return (
                <div key={parent.id}>
                  <div className="flex items-center">
                    <button
                      data-testid={`budgetform-fold-${parent.id}`}
                      aria-expanded={open}
                      onClick={() =>
                        setOpenCats((prev) => {
                          const next = new Set(prev);
                          if (next.has(parent.id)) next.delete(parent.id);
                          else next.add(parent.id);
                          return next;
                        })
                      }
                      className="m-tap flex h-9 w-7 shrink-0 items-center justify-center border-none bg-transparent text-ink-4"
                    >
                      <Icon name={open ? 'chevron-down' : 'chevron-right'} size={16} />
                    </button>
                    <div className="min-w-0 flex-1">{renderCatRow(parent.id, false)}</div>
                  </div>
                  <Collapse open={open}>
                    <div>{subs.filter((sub) => matches(sub.id) || matches(parent.id)).map((sub) => renderCatRow(sub.id, true))}</div>
                  </Collapse>
                </div>
              );
            })}
          </div>
          <FormBlockerNote show={blockerField === 'cats'} text={blockerText} testId="budgetform-blocker" />

          {/* carry-over */}
          <button
            data-testid="budgetform-carry"
            onClick={() => setCarryOver((v) => !v)}
            className="m-tap flex w-full items-center gap-3 rounded-card border border-line bg-surface px-4 py-3 text-left"
          >
            <span className="min-w-0 flex-1">
              <span className="block text-[14px] text-ink">{t('budgets.carryOver')}</span>
              <span className="block text-[11px] text-ink-4">{t('budgets.carryHint')}</span>
            </span>
            <span className={`flex h-6 w-10 items-center rounded-full p-0.5 transition-colors ${carryOver ? 'justify-end bg-accent' : 'justify-start bg-bg-2'}`}>
              <span className="h-5 w-5 rounded-full bg-surface shadow" />
            </span>
          </button>
          {carryOver && (
            <div className="flex flex-wrap items-center gap-2 px-1">
              <Chip testId="budgetform-carrymode-periods" selected={carryMode === 'periods'} onClick={() => setCarryMode('periods')}>
                {t('budgets.carryPeriods')}
              </Chip>
              <Chip testId="budgetform-carrymode-cap" selected={carryMode === 'cap'} onClick={() => setCarryMode('cap')}>
                {t('budgets.carryCap')}
              </Chip>
              {carryMode === 'periods' ? (
                <input
                  data-testid="budgetform-carryperiods"
                  type="number"
                  min={1}
                  max={52}
                  value={carryPeriodsText}
                  onChange={(e) => setCarryPeriodsText(e.target.value)}
                  onBlur={() => {
                    const clamped = Math.min(52, Math.max(1, Number(carryPeriodsText) || 1));
                    setCarryPeriods(clamped);
                    setCarryPeriodsText(String(clamped));
                  }}
                  className="h-10 w-20 rounded-input border border-line bg-surface px-3 text-[14px] text-ink outline-none"
                />
              ) : (
                <input
                  data-testid="budgetform-carrycap"
                  type="number"
                  inputMode="decimal"
                  step="0.01"
                  min="0"
                  value={carryCap}
                  onChange={(e) => setCarryCap(e.target.value)}
                  placeholder="0.00"
                  className="h-10 w-28 rounded-input border border-line bg-surface px-3 font-mono text-[14px] text-ink outline-none placeholder:text-ink-4"
                />
              )}
              {/* #372 (user): the number needed a sentence, not a technical label */}
              <p className="w-full text-[11px] text-ink-4" data-testid="budgetform-carry-explain">
                {carryMode === 'periods' ? t('budgets.carryPeriodsExplain', { n: Math.max(1, Number(carryPeriodsText) || 1) }) : t('budgets.carryCapExplain')}
              </p>
            </div>
          )}

          <div className="m-cap px-1">{t('budgets.notify')}</div>
          <div className="flex flex-wrap gap-2">
            {[0, 80, 90, 100].map((pct) => (
              <Chip key={pct} testId={`budgetform-notify-${pct}`} selected={notifyAtPct === pct} onClick={() => setNotifyAtPct(pct)}>
                {pct === 0 ? t('recurring.notifyOff') : `${pct}%`}
              </Chip>
            ))}
          </div>

          <Button
            data-testid="budgetform-save"
            onClick={() => {
              if (!valid) {
                setAttempted(true);
                return;
              }
              void save();
            }}
          >
            {editing ? t('action.save') : t('action.create')}
          </Button>
          {editing && (
            <Button variant="danger" data-testid="budgetform-delete" onClick={() => void removeBudget()}>
              {confirmDelete ? t('action.confirm') : t('action.delete')}
            </Button>
          )}
        </div>
      </div>
    </div>
  );
}
