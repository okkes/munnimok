/**
 * #195: primary buttons stay ENABLED; an invalid click surfaces this red
 * blocker line near the button instead of a silently disabled control.
 */
export function FormBlockerNote({
  show,
  text,
  testId,
  className = '',
}: {
  readonly show: boolean;
  readonly text: string;
  readonly testId: string;
  readonly className?: string;
}) {
  if (!show || !text) return null;
  return (
    <p className={`text-[12px] text-negative ${className}`.trim()} data-testid={testId}>
      {text}
    </p>
  );
}

/** Ring classes for the offending field while the blocker note is up. */
export const blockerRing = (bad: boolean): string => (bad ? ' ring-1 ring-negative' : '');
