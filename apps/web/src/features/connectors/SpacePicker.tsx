import { useReadOnlySpaceIds } from '@/app/useCanEdit';
import { useLang } from '@/i18n';
import { Icon } from '@/ui/Icon';

/**
 * The spaces a connection is available in, as a checkbox list — the same
 * rows on the step after a connect and on the card's manage sheet (user
 * ruling 2026-10-02: a connection is global and the person picks its
 * spaces afterwards, like a bank account). #505: a space the person only
 * reads stays as it is.
 */
export function SpacePicker({
  spaces,
  selected,
  disabled,
  onToggle,
  testId,
}: Readonly<{
  spaces: readonly { id: string; name: string }[];
  selected: readonly string[];
  disabled?: boolean;
  onToggle: (spaceId: string) => void;
  testId: string;
}>) {
  const { t } = useLang();
  const readOnly = useReadOnlySpaceIds();
  return (
    <div className="overflow-hidden rounded-card border border-line bg-surface" data-testid={testId}>
      {spaces.map((entry) => {
        const included = selected.includes(entry.id);
        const locked = readOnly.has(entry.id);
        return (
          <button
            key={entry.id}
            data-testid={`conn-space-${entry.id}`}
            disabled={disabled || locked}
            onClick={() => onToggle(entry.id)}
            className={`m-tap flex w-full items-center gap-3 border-b border-line-2 bg-transparent px-4 py-3 text-left last:border-0${locked ? ' opacity-60' : ''}`}
          >
            <Icon name={included ? 'checkbox-marked' : 'checkbox-blank-outline'} size={20} color={included ? 'var(--m-accent)' : 'var(--m-ink-4)'} />
            <span className="min-w-0 flex-1 truncate text-[14px] text-ink">{entry.name}</span>
            {locked && <span className="shrink-0 text-[11px] text-ink-4">{t('space.sharedReadOnly')}</span>}
          </button>
        );
      })}
    </div>
  );
}
