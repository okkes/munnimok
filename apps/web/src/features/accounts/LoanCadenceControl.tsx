import { useState } from 'react';
import { useLang } from '@/i18n';
import type { RecurringEvery } from '@/db/types';
import { Chip } from '@/ui/primitives';

export interface LoanCadence {
  every: RecurringEvery;
  everyN: number;
}

export const isCustomCadence = (every: RecurringEvery | undefined, everyN: number | undefined): boolean =>
  every === 'week' || (everyN ?? 1) > 1;

export const parsedDueDay = (raw: string): number | undefined => {
  const n = Number.parseInt(raw, 10);
  return Number.isFinite(n) && n >= 1 && n <= 31 ? n : undefined;
};

/** no anchor date: the payoff projection only needs payments-per-year */
export function LoanCadenceControl({
  value,
  custom,
  onChange,
  dueDay,
  onDueDay,
  testIdPrefix,
}: Readonly<{
  value: LoanCadence;
  custom: boolean;
  onChange: (next: LoanCadence, custom: boolean) => void;
  /** #377: the due day is asked AFTER the rhythm, like the recurring form — weekly plans have none */
  dueDay: string;
  onDueDay: (raw: string) => void;
  testIdPrefix: string;
}>) {
  const { t } = useLang();
  const [nText, setNText] = useState(String(value.everyN));
  return (
    <div className="flex flex-col gap-2">
      <div className="flex flex-wrap items-center gap-1.5">
        <Chip
          testId={`${testIdPrefix}-every-month`}
          selected={!custom && value.every === 'month'}
          onClick={() => onChange({ every: 'month', everyN: 1 }, false)}
        >
          {t('recurring.everyMonth')}
        </Chip>
        <Chip
          testId={`${testIdPrefix}-every-year`}
          selected={!custom && value.every === 'year'}
          onClick={() => onChange({ every: 'year', everyN: 1 }, false)}
        >
          {t('recurring.everyYear')}
        </Chip>
        <Chip testId={`${testIdPrefix}-every-custom`} selected={custom} onClick={() => onChange(value, true)}>
          {t('recurring.everyCustom')}
        </Chip>
      </div>
      {custom && (
        <label className="flex items-center gap-2 text-[13px] text-ink-2">
          {t('recurring.everyLabel')}
          <input
            data-testid={`${testIdPrefix}-everyn`}
            type="number"
            inputMode="numeric"
            min={1}
            max={99}
            value={nText}
            onChange={(e) => setNText(e.target.value)}
            onBlur={() => {
              const clamped = Math.min(99, Math.max(1, Math.round(Number(nText)) || 1));
              setNText(String(clamped));
              onChange({ ...value, everyN: clamped }, true);
            }}
            className="h-10 w-16 rounded-input border border-line bg-surface px-3 text-center text-[14px] text-ink outline-none"
          />
          <select
            data-testid={`${testIdPrefix}-every-unit`}
            value={value.every}
            onChange={(e) => onChange({ ...value, every: e.target.value as RecurringEvery }, true)}
            className="h-10 rounded-input border border-line bg-surface px-2 text-[13px] text-ink"
          >
            <option value="week">{t('recurring.unitWeeks')}</option>
            <option value="month">{t('recurring.unitMonths')}</option>
            <option value="year">{t('recurring.unitYears')}</option>
          </select>
        </label>
      )}
      {value.every !== 'week' && (
        <label className="flex items-center gap-3 text-[13px] text-ink-2">
          {t('recurring.dueDay')}
          <input
            data-testid={`${testIdPrefix}-payday`}
            type="number"
            inputMode="numeric"
            min={1}
            max={31}
            value={dueDay}
            onChange={(e) => onDueDay(e.target.value)}
            placeholder="—"
            className="h-10 w-20 rounded-input border border-line bg-surface px-3 text-[14px] text-ink outline-none placeholder:text-ink-4"
          />
        </label>
      )}
    </div>
  );
}
