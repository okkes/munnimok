import { useEffect, useMemo, useState } from 'react';
import { useLang } from '@/i18n';
import { Icon } from '@/ui/Icon';
import { connectorApi } from './api';
import type { LookupOption } from './types';

/**
 * A `lookup` field (§15): the values the party lists at connect time — an
 * aggregator's institutions — searched as the person types, with the logo
 * the control plane vendors. The other values of the step ride along as
 * context (the country picks the list).
 */
const INPUT = 'h-12 w-full rounded-input border border-line bg-surface px-4 text-[15px] text-ink outline-none placeholder:text-ink-4';
const DEBOUNCE_MS = 250;

export function LookupField({
  provider,
  field,
  value,
  context,
  invalid,
  onChange,
}: Readonly<{
  provider: string;
  field: string;
  value: string;
  /** the step's other values, the party's context for the list */
  context: Readonly<Record<string, string>>;
  invalid: boolean;
  onChange: (value: string, label: string) => void;
}>) {
  const { t } = useLang();
  const [query, setQuery] = useState('');
  const [options, setOptions] = useState<LookupOption[] | null>(null);
  const [failed, setFailed] = useState(false);
  const [picked, setPicked] = useState<LookupOption | null>(null);
  const contextKey = useMemo(() => JSON.stringify(context), [context]);

  useEffect(() => {
    let alive = true;
    const timer = setTimeout(() => {
      setFailed(false);
      connectorApi
        .options(provider, field, query, JSON.parse(contextKey) as Record<string, string>)
        .then((list) => {
          if (!alive) return;
          setOptions(list);
        })
        .catch(() => {
          if (!alive) return;
          setOptions([]);
          setFailed(true);
        });
    }, DEBOUNCE_MS);
    return () => {
      alive = false;
      clearTimeout(timer);
    };
  }, [provider, field, query, contextKey]);

  const pick = (option: LookupOption) => {
    setPicked(option);
    onChange(option.value, option.label);
  };

  if (value && picked) {
    return (
      <button
        type="button"
        data-testid={`connect-lookup-${field}-picked`}
        onClick={() => {
          setPicked(null);
          onChange('', '');
        }}
        className="m-tap flex h-12 w-full items-center gap-3 rounded-input border border-line bg-surface px-4 text-left text-[15px] text-ink"
      >
        {picked.hasLogo && <img src={connectorApi.optionLogoUrl(provider, field, picked.value)} alt="" className="h-6 w-6 rounded-full object-contain" />}
        <span className="min-w-0 flex-1 truncate">{picked.label}</span>
        <Icon name="close" size={16} color="var(--m-ink-4)" />
      </button>
    );
  }

  return (
    <div className="flex flex-col gap-2" data-testid={`connect-lookup-${field}`}>
      <input
        data-testid={`connect-field-${field}`}
        value={query}
        onChange={(e) => setQuery(e.target.value)}
        placeholder={t('connect.lookup.search')}
        aria-invalid={invalid}
        autoComplete="off"
        className={INPUT}
      />
      {options === null && !failed && (
        <p className="px-1 text-[12px] text-ink-4" data-testid={`connect-lookup-${field}-loading`}>
          {t('connect.lookup.loading')}
        </p>
      )}
      {failed && (
        <p className="px-1 text-[12px] text-negative" data-testid={`connect-lookup-${field}-failed`}>
          {t('connect.lookup.failed')}
        </p>
      )}
      {options !== null && !failed && options.length === 0 && (
        <p className="px-1 text-[12px] text-ink-4" data-testid={`connect-lookup-${field}-none`}>
          {t('connect.lookup.none')}
        </p>
      )}
      {options !== null && options.length > 0 && (
        // the list owns its touches (data-sheet-no-drag): a nested scroller at
        // its top would otherwise hand the first move to the sheet's drag and
        // never scroll on a phone
        <div
          className="max-h-[280px] overflow-y-auto rounded-card border border-line bg-surface"
          data-testid={`connect-lookup-${field}-options`}
          data-sheet-no-drag
        >
          {options.map((option) => (
            <button
              key={option.value}
              type="button"
              data-testid={`connect-lookup-${field}-${option.value}`}
              onClick={() => pick(option)}
              className="m-tap flex w-full items-center gap-3 border-b border-line-2 bg-transparent px-4 py-3 text-left last:border-0"
            >
              {option.hasLogo ? (
                <img src={connectorApi.optionLogoUrl(provider, field, option.value)} alt="" loading="lazy" className="h-7 w-7 rounded-full object-contain" />
              ) : (
                <span className="flex h-7 w-7 items-center justify-center rounded-full bg-bg-2">
                  <Icon name="bank-outline" size={16} color="var(--m-ink-4)" />
                </span>
              )}
              <span className="min-w-0 flex-1 truncate text-[14px] text-ink">{option.label}</span>
            </button>
          ))}
        </div>
      )}
    </div>
  );
}
