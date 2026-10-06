/** the party's state as a chip: the connector's word, coloured by what it means for users */
const STATE_CHIP: Record<string, string> = { healthy: 'ok-chip', degraded: 'warn-chip', paused: 'warn-chip', retired: 'danger-chip' };

export function StateChip({ state, testId }: Readonly<{ state: string | undefined; testId?: string }>) {
  if (!state) return <span className="sub">—</span>;
  return (
    <span className={`chip ${STATE_CHIP[state] ?? ''}`} data-testid={testId}>
      {state}
    </span>
  );
}
