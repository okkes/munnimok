import { useEffect, useMemo, useState } from 'react';
import { useLiveQuery } from 'dexie-react-hooks';
import { useLang } from '@/i18n';
import { LOCALES } from '@/i18n';
import { useData } from '@/app/data';
import { useSpaceTransactions } from '@/application/transactions';
import { localToday, useDismissedKeys, useRecurringOps, useRecurrings } from '@/application/recurring';
import { computeRange, summarize } from '@/domain/recurring';
import type { RecurringComputed } from '@/domain/recurring';
import { detectRecurring } from '@/domain/detectRecurring';
import type { RecurringSuggestion } from '@/domain/detectRecurring';
import { periodHistory } from '@/domain/periods';
import { fmtCents } from '@/lib/money';
import { CategoryPicker } from '@/features/categories/CategoryPicker';
import { catName, useCategories } from '@/features/categories/useCategories';
import type { RecurringEvery, RecurringKind, RecurringRow } from '@/db/types';
import { AppBar, IconButton } from '@/ui/AppBar';
import { Button } from '@/ui/Button';
import { Icon } from '@/ui/Icon';
import { Sheet } from '@/ui/Sheet';

const KIND_ICON: Record<RecurringKind, string> = {
  fixed: 'home-lightning-bolt-outline',
  subscription: 'television-play',
};
const NOTIFY_CHOICES = [0, 1, 3, 7];

interface FormState {
  id: string | null;
  name: string;
  kind: RecurringKind;
  amount: string; // major units as typed
  catId?: string;
  every: RecurringEvery;
  dueDay: number;
  dueMonth: number;
  luxury: boolean;
  notify: number;
  active: boolean;
  merchantKey?: string;
}

const emptyForm = (): FormState => ({
  id: null,
  name: '',
  kind: 'subscription',
  amount: '',
  every: 'month',
  dueDay: 1,
  dueMonth: 1,
  luxury: false,
  notify: 0,
  active: true,
});

const formFromRec = (rec: RecurringRow): FormState => ({
  id: rec.id,
  name: rec.name,
  kind: rec.kind,
  amount: (rec.amountCents / 100).toFixed(2),
  catId: rec.catId,
  every: rec.every,
  dueDay: rec.dueDay,
  dueMonth: rec.dueMonth ?? 1,
  luxury: rec.luxury === 1,
  notify: rec.notifyDaysBefore ?? 0,
  active: rec.active === 1,
  merchantKey: rec.merchantKey,
});

const formFromSuggestion = (s: RecurringSuggestion): FormState => ({
  ...emptyForm(),
  name: s.name,
  kind: s.every === 'year' ? 'fixed' : 'subscription',
  amount: (s.amountCents / 100).toFixed(2),
  every: s.every,
  dueDay: s.dueDay,
  merchantKey: s.merchantKey,
});

function Chip({ selected, onClick, children, testId }: Readonly<{ selected: boolean; onClick: () => void; children: React.ReactNode; testId?: string }>) {
  return (
    <button
      data-testid={testId}
      onClick={onClick}
      className={`m-tap shrink-0 rounded-full border px-3 py-1.5 text-[12px] ${
        selected ? 'border-accent bg-accent-soft font-medium text-accent-deep' : 'border-line bg-surface text-ink-2'
      }`}
    >
      {children}
    </button>
  );
}

export function RecurringScreen() {
  const { t, lang } = useLang();
  const { db, spaceId } = useData();
  const space = useLiveQuery(() => db.spaces.get(spaceId), [spaceId]);
  const recs = useRecurrings();
  const dismissed = useDismissedKeys();
  const txs = useSpaceTransactions();
  const ops = useRecurringOps();
  const cats = useCategories();

  const [view, setView] = useState<'period' | 'year'>('period');
  const [form, setForm] = useState<FormState | null>(null);
  const [catPickerOpen, setCatPickerOpen] = useState(false);
  const [confirmDelete, setConfirmDelete] = useState(false);

  // pick up freshly imported payments the moment the screen opens
  useEffect(() => {
    void ops.reconcile().catch(() => undefined); // teardown-safe
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [spaceId]);

  const today = localToday();
  const currency = space?.currency ?? 'EUR';
  const money = (cents: number) => fmtCents(cents, currency, lang);
  const fmtDate = (iso: string) => new Date(iso).toLocaleDateString(LOCALES[lang], { day: 'numeric', month: 'short' });

  const period = useMemo(
    () => periodHistory(space?.periodType ?? 'month', space?.periodDay || 1, 1)[0],
    [space?.periodType, space?.periodDay],
  );
  const range = view === 'period' ? period : { start: `${today.slice(0, 4)}-01-01`, end: `${today.slice(0, 4)}-12-31` };

  const linkedByRec = useMemo(() => {
    const map = new Map<string, { date: string; amountCents: number }[]>();
    for (const tx of txs ?? []) {
      if (!tx.recurringId) continue;
      const list = map.get(tx.recurringId) ?? [];
      list.push({ date: tx.date, amountCents: tx.amountCents });
      map.set(tx.recurringId, list);
    }
    return map;
  }, [txs]);

  const computed = useMemo(
    () => computeRange(recs ?? [], linkedByRec, range.start, range.end, today),
    [recs, linkedByRec, range.start, range.end, today],
  );
  const summary = summarize(computed.filter((c) => c.rec.active === 1));

  const suggestions = useMemo(() => {
    if (!txs || !recs || !dismissed) return [];
    const exclude = new Set([...dismissed, ...recs.flatMap((r) => (r.merchantKey ? [r.merchantKey] : []))]);
    return detectRecurring(txs, { excludeKeys: exclude, today }).slice(0, 5);
  }, [txs, recs, dismissed, today]);

  const fixed = computed.filter((c) => c.rec.kind === 'fixed' && c.rec.active === 1);
  const subs = computed.filter((c) => c.rec.kind === 'subscription' && c.rec.active === 1);
  const inactive = computed.filter((c) => c.rec.active !== 1);
  const empty = (recs?.length ?? 0) === 0 && suggestions.length === 0;

  const save = async () => {
    if (!form || !form.name.trim()) return;
    const amountCents = Math.round(Number.parseFloat(form.amount.replace(',', '.')) * 100);
    if (!Number.isFinite(amountCents) || amountCents <= 0) return;
    const fromSuggestion = form.id === null && !!form.merchantKey;
    await ops.save(form.id, {
      name: form.name.trim(),
      kind: form.kind,
      luxury: form.luxury ? 1 : 0,
      amountCents,
      catId: form.catId,
      icon: KIND_ICON[form.kind],
      every: form.every,
      dueDay: Math.min(31, Math.max(1, form.dueDay || 1)),
      ...(form.every === 'year' ? { dueMonth: Math.min(12, Math.max(1, form.dueMonth || 1)) } : {}),
      active: form.active ? 1 : 0,
      notifyDaysBefore: form.notify || undefined,
      merchantKey: form.merchantKey,
      // no auto-`since`: a cost added mid-period still counts for the
      // whole current period (and accepted suggestions own their history)
    });
    setForm(null);
    // an accepted suggestion should immediately own its past payments
    if (fromSuggestion) await ops.reconcile();
  };

  const removeCurrent = async () => {
    if (!form?.id) return;
    if (!confirmDelete) {
      setConfirmDelete(true);
      return;
    }
    await ops.remove(form.id);
    setForm(null);
  };

  const subtitleFor = (c: RecurringComputed): string => {
    if (view === 'period' && c.paid) return t('recurring.paidThisPeriod');
    const parts = [t('recurring.dueDay2', { day: c.rec.dueDay })];
    if (c.nextDue) parts.push(t('recurring.next', { date: fmtDate(c.nextDue) }));
    if (c.rec.until) parts.push(t('recurring.ends', { date: fmtDate(c.rec.until) }));
    return parts.join(' · ');
  };

  const renderRow = (c: RecurringComputed) => (
    <button
      key={c.rec.id}
      data-testid={`recurring-row-${c.rec.id}`}
      onClick={() => {
        setConfirmDelete(false);
        setForm(formFromRec(c.rec));
      }}
      className="m-tap flex w-full items-center gap-3 border-b border-line-2 px-4 py-3 text-left last:border-0"
    >
      <span className={`relative flex h-9 w-9 shrink-0 items-center justify-center rounded-xl ${c.paid && view === 'period' ? 'bg-accent-soft' : 'bg-bg-2'}`}>
        <Icon name={c.rec.icon ?? KIND_ICON[c.rec.kind]} size={17} color={c.paid && view === 'period' ? 'var(--m-accent-deep)' : 'var(--m-ink-2)'} />
        {c.paid && view === 'period' && (
          <span className="absolute -right-1 -bottom-1 flex h-4 w-4 items-center justify-center rounded-full bg-accent text-white ring-2 ring-surface">
            <Icon name="check" size={9} />
          </span>
        )}
      </span>
      <span className="min-w-0 flex-1">
        <span className="flex items-center gap-1.5">
          <span className="truncate text-[14px] font-medium text-ink">{c.rec.name}</span>
          {c.rec.luxury === 1 && (
            <span className="shrink-0 rounded-full bg-accent-soft px-1.5 py-0.5 text-[9px] font-bold tracking-wide text-accent-deep uppercase">
              {t('recurring.luxury')}
            </span>
          )}
        </span>
        <span className="block truncate text-[11px] text-ink-4">{subtitleFor(c)}</span>
      </span>
      <span className="font-mono text-[14px] font-semibold text-ink">{money(c.effectiveCents)}</span>
      <Icon name="chevron-right" size={14} color="var(--m-ink-4)" />
    </button>
  );

  const section = (labelKey: 'recurring.fixed' | 'recurring.subs' | 'recurring.inactive', rows: RecurringComputed[]) =>
    rows.length > 0 && (
      <>
        <div className="m-cap mt-5 mb-1 px-1">
          {t(labelKey)} · {rows.length}
        </div>
        <div className={`overflow-hidden rounded-card border border-line bg-surface ${labelKey === 'recurring.inactive' ? 'opacity-60' : ''}`}>
          {rows.map(renderRow)}
        </div>
      </>
    );

  const progress = summary.totalCents > 0 ? Math.min(1, summary.paidCents / summary.totalCents) : 0;

  return (
    <div className="m-fade flex h-full flex-col" data-testid="screen-recurring">
      <AppBar
        title={t('screen.recurring')}
        trailing={
          <IconButton label={t('recurring.add')} testId="recurring-add" onClick={() => { setConfirmDelete(false); setForm(emptyForm()); }}>
            <Icon name="plus" size={22} />
          </IconButton>
        }
      />
      <div className="min-h-0 flex-1 overflow-y-auto px-5 pb-6">
        {/* period / year toggle */}
        <div className="mt-1 flex rounded-xl bg-bg-2 p-0.5">
          {(['period', 'year'] as const).map((v) => (
            <button
              key={v}
              data-testid={`recurring-view-${v}`}
              onClick={() => setView(v)}
              className={`m-tap flex-1 rounded-[10px] border-none py-2 text-[13px] ${
                view === v ? 'bg-surface font-semibold text-ink shadow-sm' : 'bg-transparent text-ink-3'
              }`}
            >
              {t(v === 'period' ? 'overview.thisPeriod' : 'recurring.thisYear')}
            </button>
          ))}
        </div>

        {/* summary card */}
        <div className="mt-3 rounded-card border border-line bg-surface p-4" data-testid="recurring-summary">
          <div className="grid grid-cols-3 gap-3">
            {(
              [
                ['recurring.total', summary.totalCents, 'var(--m-ink)'],
                ['recurring.paid', summary.paidCents, 'var(--m-accent-deep)'],
                ['recurring.remaining', summary.remainingCents, summary.remainingCents > 0 ? 'var(--m-warning)' : 'var(--m-accent-deep)'],
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
          <div className="mt-3 h-1.5 overflow-hidden rounded-full bg-bg-2">
            <div className="h-full rounded-full bg-accent transition-[width]" style={{ width: `${progress * 100}%` }} />
          </div>
          {summary.luxuryCents > 0 && (
            <div className="mt-3 flex items-center gap-1.5 text-[11px] text-ink-3" data-testid="recurring-luxury-line">
              <span className="rounded-full bg-accent-soft px-1.5 py-0.5 text-[9px] font-bold tracking-wide text-accent-deep uppercase">
                {t('recurring.luxury')}
              </span>
              {t('recurring.luxuryNote', {
                period: money(summary.luxuryCents),
                year: money(view === 'year' ? summary.luxuryCents : summary.luxuryCents * 12),
              })}
            </div>
          )}
        </div>

        {/* detected patterns */}
        {suggestions.length > 0 && (
          <>
            <div className="m-cap mt-5 mb-1 px-1">
              {t('recurring.detected')} · {suggestions.length}
            </div>
            <div className="overflow-hidden rounded-card border border-accent bg-accent-soft/40" data-testid="recurring-suggestions">
              {suggestions.map((s) => (
                <div key={s.merchantKey} className="flex items-center gap-3 border-b border-line-2 px-4 py-3 last:border-0">
                  <span className="flex h-9 w-9 shrink-0 items-center justify-center rounded-xl bg-surface">
                    <Icon name="autorenew" size={17} color="var(--m-accent-deep)" />
                  </span>
                  <span className="min-w-0 flex-1">
                    <span className="block truncate text-[14px] font-medium text-ink">{s.name}</span>
                    <span className="block text-[11px] text-ink-3">
                      {t(s.every === 'year' ? 'recurring.patternYearly' : 'recurring.patternMonthly')} ·{' '}
                      {t('recurring.seen', { n: s.count })} · {s.confidence}%
                    </span>
                  </span>
                  <span className="font-mono text-[13px] font-semibold text-ink">{money(s.amountCents)}</span>
                  <button
                    aria-label={t('friends.accept')}
                    data-testid={`recurring-accept-${s.merchantKey}`}
                    onClick={() => { setConfirmDelete(false); setForm(formFromSuggestion(s)); }}
                    className="m-tap flex h-8 w-8 items-center justify-center rounded-lg border-none bg-accent text-white"
                  >
                    <Icon name="check" size={14} />
                  </button>
                  <button
                    aria-label={t('friends.decline')}
                    data-testid={`recurring-dismiss-${s.merchantKey}`}
                    onClick={() => void ops.dismissSuggestion(s.merchantKey)}
                    className="m-tap flex h-8 w-8 items-center justify-center rounded-lg border border-line bg-surface text-ink-3"
                  >
                    <Icon name="close" size={14} />
                  </button>
                </div>
              ))}
            </div>
          </>
        )}

        {section('recurring.fixed', fixed)}
        {section('recurring.subs', subs)}
        {section('recurring.inactive', inactive)}

        {empty && (
          <div className="flex flex-col items-center gap-2 px-6 pt-16 text-center" data-testid="recurring-empty">
            <Icon name="autorenew" size={34} color="var(--m-ink-4)" />
            <p className="text-[14px] font-medium text-ink-2">{t('recurring.emptyTitle')}</p>
            <p className="text-[12px] text-ink-4">{t('recurring.emptyBody')}</p>
          </div>
        )}
      </div>

      {/* create / edit sheet */}
      <Sheet
        open={form !== null}
        onOpenChange={(open) => !open && setForm(null)}
        title={form?.id ? t('recurring.edit') : t('recurring.add')}
        size="tall"
      >
        {form && (
          <div className="flex flex-col gap-3 pt-1">
            <input
              data-testid="recform-name"
              value={form.name}
              onChange={(e) => setForm({ ...form, name: e.target.value })}
              placeholder={t('recurring.name')}
              className="h-12 w-full rounded-input border border-line bg-surface px-4 text-[15px] text-ink outline-none placeholder:text-ink-4"
            />
            <div className="flex gap-2">
              <Chip testId="recform-kind-fixed" selected={form.kind === 'fixed'} onClick={() => setForm({ ...form, kind: 'fixed' })}>
                {t('recurring.kindFixed')}
              </Chip>
              <Chip testId="recform-kind-subscription" selected={form.kind === 'subscription'} onClick={() => setForm({ ...form, kind: 'subscription' })}>
                {t('recurring.kindSub')}
              </Chip>
            </div>

            <div className="m-cap px-1">{t('recurring.amount')}</div>
            <input
              data-testid="recform-amount"
              type="number"
              inputMode="decimal"
              step="0.01"
              min="0"
              value={form.amount}
              onChange={(e) => setForm({ ...form, amount: e.target.value })}
              placeholder="0.00"
              className="h-12 w-full rounded-input border border-line bg-surface px-4 font-mono text-[15px] text-ink outline-none placeholder:text-ink-4"
            />

            <div className="m-cap px-1">{t('recurring.category')}</div>
            <button
              data-testid="recform-cat-open"
              onClick={() => setCatPickerOpen(true)}
              className="m-tap flex h-12 w-full items-center gap-3 rounded-input border border-line bg-surface px-4 text-left text-[14px]"
            >
              {form.catId ? (
                <>
                  <Icon name={cats.byId(form.catId).icon} size={18} color={cats.byId(cats.byId(form.catId).parentId)?.color ?? cats.byId(form.catId).color} />
                  <span className="min-w-0 flex-1 truncate text-ink">{catName(cats.byId(form.catId), t)}</span>
                </>
              ) : (
                <span className="min-w-0 flex-1 truncate text-ink-3">{t('recurring.pickCategory')}</span>
              )}
              <Icon name="chevron-down" size={17} color="var(--m-ink-4)" />
            </button>

            <div className="m-cap px-1">{t('space.periodTitle')}</div>
            <div className="flex flex-wrap items-center gap-2">
              <Chip testId="recform-every-month" selected={form.every === 'month'} onClick={() => setForm({ ...form, every: 'month' })}>
                {t('recurring.everyMonth')}
              </Chip>
              <Chip testId="recform-every-year" selected={form.every === 'year'} onClick={() => setForm({ ...form, every: 'year' })}>
                {t('recurring.everyYear')}
              </Chip>
            </div>
            <label className="flex items-center gap-3 text-[13px] text-ink-2">
              {t('recurring.dueDay')}
              <input
                data-testid="recform-dueday"
                type="number"
                min={1}
                max={31}
                value={form.dueDay}
                onChange={(e) => setForm({ ...form, dueDay: Math.min(31, Math.max(1, Number(e.target.value) || 1)) })}
                className="h-10 w-20 rounded-input border border-line bg-surface px-3 text-[14px] text-ink outline-none"
              />
              {form.every === 'year' && (
                <>
                  {t('recurring.dueMonth')}
                  <select
                    data-testid="recform-duemonth"
                    value={form.dueMonth}
                    onChange={(e) => setForm({ ...form, dueMonth: Number(e.target.value) })}
                    className="h-10 rounded-input border border-line bg-surface px-2 text-[13px] text-ink"
                  >
                    {Array.from({ length: 12 }, (_, i) => (
                      <option key={i + 1} value={i + 1}>
                        {new Date(2026, i, 1).toLocaleDateString(LOCALES[lang], { month: 'short' })}
                      </option>
                    ))}
                  </select>
                </>
              )}
            </label>

            <button
              data-testid="recform-luxury"
              onClick={() => setForm({ ...form, luxury: !form.luxury })}
              className="m-tap flex w-full items-center gap-3 rounded-card border border-line bg-surface px-4 py-3 text-left"
            >
              <span className="min-w-0 flex-1">
                <span className="block text-[14px] text-ink">{t('recurring.luxury')}</span>
                <span className="block text-[11px] text-ink-4">{t('recurring.luxuryHint')}</span>
              </span>
              <span
                className={`flex h-6 w-10 items-center rounded-full p-0.5 transition-colors ${form.luxury ? 'justify-end bg-accent' : 'justify-start bg-bg-2'}`}
              >
                <span className="h-5 w-5 rounded-full bg-surface shadow" />
              </span>
            </button>

            <div className="m-cap px-1">{t('recurring.notify')}</div>
            <div className="flex flex-wrap gap-2">
              {NOTIFY_CHOICES.map((n) => (
                <Chip key={n} testId={`recform-notify-${n}`} selected={form.notify === n} onClick={() => setForm({ ...form, notify: n })}>
                  {n === 0 ? t('recurring.notifyOff') : t('recurring.notifyDays', { n })}
                </Chip>
              ))}
            </div>

            {form.id && (
              <button
                data-testid="recform-active"
                onClick={() => setForm({ ...form, active: !form.active })}
                className="m-tap flex w-full items-center gap-3 rounded-card border border-line bg-surface px-4 py-3 text-left"
              >
                <span className="min-w-0 flex-1 text-[14px] text-ink">{t('recurring.activeLabel')}</span>
                <span
                  className={`flex h-6 w-10 items-center rounded-full p-0.5 transition-colors ${form.active ? 'justify-end bg-accent' : 'justify-start bg-bg-2'}`}
                >
                  <span className="h-5 w-5 rounded-full bg-surface shadow" />
                </span>
              </button>
            )}

            <Button data-testid="recform-save" onClick={() => void save()} disabled={!form.name.trim() || !form.amount}>
              {form.id ? t('action.save') : t('action.add')}
            </Button>
            {form.id && (
              <Button variant="danger" data-testid="recform-delete" onClick={() => void removeCurrent()}>
                {confirmDelete ? t('action.confirm') : t('action.delete')}
              </Button>
            )}
          </div>
        )}
      </Sheet>

      <CategoryPicker
        open={catPickerOpen}
        onOpenChange={setCatPickerOpen}
        selectedId={form?.catId}
        direction="debit"
        onPick={(catId) => {
          if (form) setForm({ ...form, catId });
          setCatPickerOpen(false);
        }}
      />
    </div>
  );
}
