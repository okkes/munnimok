import { Icon } from '@/ui/Icon';

/**
 * The spaces a connection is available in, as a checkbox list — the same
 * rows on the step after a connect and on the card's manage sheet (user
 * ruling 2026-10-02: a connection is global and the person picks its
 * spaces afterwards, like a bank account).
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
  return (
    <div className="overflow-hidden rounded-card border border-line bg-surface" data-testid={testId}>
      {spaces.map((entry) => {
        const included = selected.includes(entry.id);
        return (
          <button
            key={entry.id}
            data-testid={`conn-space-${entry.id}`}
            disabled={disabled}
            onClick={() => onToggle(entry.id)}
            className="m-tap flex w-full items-center gap-3 border-b border-line-2 bg-transparent px-4 py-3 text-left last:border-0"
          >
            <Icon name={included ? 'checkbox-marked' : 'checkbox-blank-outline'} size={20} color={included ? 'var(--m-accent)' : 'var(--m-ink-4)'} />
            <span className="min-w-0 flex-1 truncate text-[14px] text-ink">{entry.name}</span>
          </button>
        );
      })}
    </div>
  );
}
