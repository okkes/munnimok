import { useLang } from '@/i18n';
import { Icon } from './Icon';

type SelectionState = 'all' | 'some' | 'none';

const selectionState = (all: boolean, some: boolean): SelectionState => {
  if (all) return 'all';
  if (some) return 'some';
  return 'none';
};

/**
 * #378 (user): ONE way to select or deselect every transaction in a list —
 * a header row with the same square check the rows wear, half-filled
 * while the pick is partial, the count on the right. The row toggles:
 * a partial or empty pick selects all, a full pick clears it.
 */
export function SelectAllRow({
  total,
  selected,
  onChange,
  testId,
  divider = true,
  className = '',
}: Readonly<{
  total: number;
  selected: number;
  /** true = select everything, false = clear the pick */
  onChange: (all: boolean) => void;
  testId: string;
  divider?: boolean;
  className?: string;
}>) {
  const { t } = useLang();
  const all = total > 0 && selected >= total;
  const some = selected > 0 && !all;
  const state = selectionState(all, some);
  return (
    <button
      type="button"
      data-testid={testId}
      data-state={state}
      aria-pressed={all}
      disabled={total === 0}
      onClick={() => onChange(!all)}
      className={`m-tap flex w-full items-center gap-3 bg-transparent px-1 py-2 text-left disabled:opacity-40 ${divider ? 'border-b border-line-2' : 'border-none'} ${className}`.trim()}
    >
      <span
        className={`flex h-5 w-5 shrink-0 items-center justify-center rounded-md border-2 ${
          state === 'none' ? 'border-line bg-surface' : 'border-accent bg-accent text-white'
        }`}
      >
        {state === 'all' && <Icon name="check" size={12} />}
        {state === 'some' && <Icon name="minus" size={12} />}
      </span>
      <span className="min-w-0 flex-1 text-[13px] font-medium text-ink">{all ? t('select.none') : t('select.all')}</span>
      <span className="m-num text-[12px] text-ink-3">{t('select.count', { n: selected, total })}</span>
    </button>
  );
}
