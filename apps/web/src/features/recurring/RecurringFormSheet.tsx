import { useEffect, useState } from 'react';
import { LOCALES, useLang } from '@/i18n';
import { useRecurringOps } from '@/application/recurring';
import type { RecurringSuggestion } from '@/domain/detectRecurring';
import type { RecurringEvery, RecurringKind, RecurringRow } from '@/db/types';
import { BrandIconPicker } from './BrandIconPicker';
import { KIND_ICON } from './RecurringVisual';
import { Button } from '@/ui/Button';
import { Icon } from '@/ui/Icon';
import { Chip } from '@/ui/primitives';
import { Sheet } from '@/ui/Sheet';

const NOTIFY_CHOICES = [0, 1, 3, 7];

export interface FormState {
  id: string | null;
  name: string;
  kind: RecurringKind;
  amount: string; // major units as typed
  logo?: string;
  every: RecurringEvery;
  /** custom cadence: repeat every N units, anchored on firstDue */
  everyN: number;
  custom: boolean;
  firstDue: string; // ISO date, '' until picked
  dueDay: number;
  dueMonth: number;
  luxury: boolean;
  notify: number;
  active: boolean;
  merchantKey?: string;
}

export const emptyForm = (): FormState => ({
  id: null,
  name: '',
  kind: 'subscription',
  amount: '',
  every: 'month',
  everyN: 1,
  custom: false,
  firstDue: '',
  dueDay: 1,
  dueMonth: 1,
  luxury: false,
  notify: 0,
  active: true,
});

export const formFromRec = (rec: RecurringRow): FormState => ({
  id: rec.id,
  name: rec.name,
  kind: rec.kind,
  amount: (rec.amountCents / 100).toFixed(2),
  logo: rec.logo || undefined,
  every: rec.every,
  everyN: Math.max(1, rec.everyN ?? 1),
  custom: rec.every === 'week' || (rec.everyN ?? 1) > 1,
  firstDue: rec.since ?? '',
  dueDay: rec.dueDay,
  dueMonth: rec.dueMonth ?? 1,
  luxury: rec.luxury === 1,
  notify: rec.notifyDaysBefore ?? 0,
  active: rec.active === 1,
  merchantKey: rec.merchantKey,
});

export const formFromSuggestion = (s: RecurringSuggestion): FormState => ({
  ...emptyForm(),
  name: s.name,
  kind: s.every === 'year' ? 'fixed' : 'subscription',
  amount: (s.amountCents / 100).toFixed(2),
  every: s.every,
  dueDay: s.dueDay,
  merchantKey: s.merchantKey,
});

interface RecurringFormSheetProps {
  /** non-null opens the sheet with this draft; the sheet owns edits from there */
  initial: FormState | null;
  onClose: () => void;
  /** e.g. the detail screen leaves after its record was deleted */
  onDeleted?: () => void;
}

/**
 * The one create/edit form for recurring costs, shared by the recurring
 * tab (add), the detail screen (edit) and the suggestions screen
 * (accept). Owns its pickers and persistence.
 */
export function RecurringFormSheet({ initial, onClose, onDeleted }: Readonly<RecurringFormSheetProps>) {
  const { t, lang } = useLang();
  const ops = useRecurringOps();
  const [form, setForm] = useState<FormState | null>(null);
  const [brandPickerOpen, setBrandPickerOpen] = useState(false);
  const [confirmDelete, setConfirmDelete] = useState(false);
  // free-typed drafts so the '1' can be deleted while editing; clamped on blur
  const [dueDayText, setDueDayText] = useState('1');
  const [everyNText, setEveryNText] = useState('1');

  useEffect(() => {
    setForm(initial);
    setDueDayText(String(initial?.dueDay ?? 1));
    setEveryNText(String(initial?.everyN ?? 1));
    setConfirmDelete(false);
  }, [initial]);

  const save = async () => {
    if (!form?.name.trim()) return;
    if (form.custom && !form.firstDue) return;
    const amountCents = Math.round(Number.parseFloat(form.amount.replace(',', '.')) * 100);
    if (!Number.isFinite(amountCents) || amountCents <= 0) return;
    const fromSuggestion = form.id === null && !!form.merchantKey;
    // custom cadences anchor on the first due date; presets keep the
    // no-auto-`since` rule so a cost added mid-period still counts for
    // the whole current period (and accepted suggestions own their history)
    const cadence = form.custom
      ? {
          every: form.every,
          everyN: Math.min(99, Math.max(1, Math.round(form.everyN) || 1)),
          since: form.firstDue,
          dueDay: Number(form.firstDue.slice(8, 10)),
          dueMonth: Number(form.firstDue.slice(5, 7)),
        }
      : {
          every: form.every,
          everyN: 1, // overwrite a previous custom cadence
          since: '', // '' clears — an absent field would not sync
          dueDay: Math.min(31, Math.max(1, form.dueDay || 1)),
          ...(form.every === 'year' ? { dueMonth: Math.min(12, Math.max(1, form.dueMonth || 1)) } : {}),
        };
    await ops.save(form.id, {
      name: form.name.trim(),
      kind: form.kind,
      luxury: form.luxury ? 1 : 0,
      amountCents,
      icon: KIND_ICON[form.kind],
      logo: form.logo ?? '', // '' clears — an absent field would not sync
      ...cadence,
      active: form.active ? 1 : 0,
      notifyDaysBefore: form.notify || undefined,
      merchantKey: form.merchantKey,
    });
    onClose();
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
    onClose();
    onDeleted?.();
  };

  return (
    <>
      <Sheet
        open={form !== null}
        onOpenChange={(open) => !open && onClose()}
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

            <div className="m-cap px-1">{t('recurring.iconTitle')}</div>
            <button
              data-testid="recform-logo-open"
              onClick={() => setBrandPickerOpen(true)}
              className="m-tap flex h-12 w-full items-center gap-3 rounded-input border border-line bg-surface px-4 text-left text-[14px]"
            >
              {form.logo ? (
                <img src={form.logo} alt="" className="h-6 w-6 object-contain" />
              ) : (
                <Icon name={KIND_ICON[form.kind]} size={18} color="var(--m-ink-3)" />
              )}
              <span className={`min-w-0 flex-1 truncate ${form.logo ? 'text-ink' : 'text-ink-3'}`}>
                {form.logo ? t('recurring.iconChosen') : t('recurring.iconNone')}
              </span>
              <Icon name="chevron-down" size={17} color="var(--m-ink-4)" />
            </button>

            <div className="m-cap px-1">{t('recurring.cadence')}</div>
            <div className="flex flex-wrap items-center gap-2">
              <Chip
                testId="recform-every-month"
                selected={!form.custom && form.every === 'month'}
                onClick={() => setForm({ ...form, custom: false, every: 'month', everyN: 1 })}
              >
                {t('recurring.everyMonth')}
              </Chip>
              <Chip
                testId="recform-every-year"
                selected={!form.custom && form.every === 'year'}
                onClick={() => setForm({ ...form, custom: false, every: 'year', everyN: 1 })}
              >
                {t('recurring.everyYear')}
              </Chip>
              <Chip testId="recform-every-custom" selected={form.custom} onClick={() => setForm({ ...form, custom: true })}>
                {t('recurring.everyCustom')}
              </Chip>
            </div>
            {form.custom ? (
              <div className="flex flex-col gap-2">
                <label className="flex items-center gap-2 text-[13px] text-ink-2">
                  {t('recurring.everyLabel')}
                  <input
                    data-testid="recform-everyn"
                    type="number"
                    inputMode="numeric"
                    min={1}
                    max={99}
                    value={everyNText}
                    onChange={(e) => setEveryNText(e.target.value)}
                    onBlur={() => {
                      const clamped = Math.min(99, Math.max(1, Math.round(Number(everyNText)) || 1));
                      setForm({ ...form, everyN: clamped });
                      setEveryNText(String(clamped));
                    }}
                    className="h-10 w-16 rounded-input border border-line bg-surface px-3 text-center text-[14px] text-ink outline-none"
                  />
                  <select
                    data-testid="recform-every-unit"
                    value={form.every}
                    onChange={(e) => setForm({ ...form, every: e.target.value as RecurringEvery })}
                    className="h-10 rounded-input border border-line bg-surface px-2 text-[13px] text-ink"
                  >
                    <option value="week">{t('recurring.unitWeeks')}</option>
                    <option value="month">{t('recurring.unitMonths')}</option>
                    <option value="year">{t('recurring.unitYears')}</option>
                  </select>
                </label>
                <label className="flex items-center gap-2 text-[13px] text-ink-2">
                  {t('recurring.firstDue')}
                  <input
                    data-testid="recform-firstdue"
                    type="date"
                    value={form.firstDue}
                    onChange={(e) => setForm({ ...form, firstDue: e.target.value })}
                    className="h-10 rounded-input border border-line bg-surface px-3 text-[13px] text-ink outline-none"
                  />
                </label>
              </div>
            ) : (
              <label className="flex items-center gap-3 text-[13px] text-ink-2">
                {t('recurring.dueDay')}
                <input
                  data-testid="recform-dueday"
                  type="number"
                  min={1}
                  max={31}
                  value={dueDayText}
                  onChange={(e) => setDueDayText(e.target.value)}
                  onBlur={() => {
                    const clamped = Math.min(31, Math.max(1, Number(dueDayText) || 1));
                    setForm({ ...form, dueDay: clamped });
                    setDueDayText(String(clamped));
                  }}
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
            )}

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

            <Button
              data-testid="recform-save"
              onClick={() => void save()}
              disabled={!form.name.trim() || !form.amount || (form.custom && !form.firstDue)}
            >
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

      <BrandIconPicker
        open={brandPickerOpen}
        onOpenChange={setBrandPickerOpen}
        initialQuery={form?.name ?? ''}
        onPick={({ logo }) => {
          if (form) setForm({ ...form, logo: logo ?? undefined });
        }}
      />
    </>
  );
}
