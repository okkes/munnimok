import { useState } from 'react';

/** one connector session as the API details it (AdminConnectorSessionDetailDto) — ids and state, never a bundle */
export interface SessionRow {
  sessionId: string;
  provider: string;
  connectionId: string;
  state: string;
  /** the person's own name for the connection */
  label?: string | null;
  createdAt: string;
  lastSeenAt: string;
  /** the relay keeps a bundle (an open-banking consent, an agent's pointer) and syncs it by itself */
  keptBundle: boolean;
  lastScheduledSyncAt?: string | null;
  lastScheduleError?: string | null;
  scheduleNotBefore?: string | null;
  /** how many accounts the connection reached — a count, never the IBANs */
  accounts: number;
  /** nothing fetches it any more: not active, no bundle kept — the rows to clear */
  stale: boolean;
}

/** DELETE /admin/bank-connections/{id}: the party's side and what was forgotten here */
export interface DisconnectOutcome {
  sessionId: string;
  provider: string;
  connectionId: string;
  party: 'ended' | 'gone' | 'refused' | 'unreachable';
  partyError: string | null;
  accountsForgotten: number;
}

const PARTY_LABELS: Record<string, string> = { gocardless: 'GoCardless', enablebanking: 'Enable Banking' };

/** the open-banking parties by name; any other party reads as its catalogue id */
export const partyLabel = (provider: string): string => PARTY_LABELS[provider] ?? provider;

export const shortId = (id: string, keep = 10): string => (id.length > keep ? `${id.slice(0, keep)}…` : id);

export const whenText = (iso: string | null | undefined): string => (iso ? new Date(iso).toLocaleString() : '—');

const STEPS: readonly (readonly [number, string])[] = [
  [60, 'h'],
  [24, 'd'],
  [30, 'mo'],
  [12, 'y'],
];

/** "3 h ago" (or "in 25 min") beside the absolute moment: a glance says whether a row is alive */
export function relativeText(iso: string | null | undefined, now = Date.now()): string {
  if (!iso) return 'never';
  const ms = Date.parse(iso) - now;
  if (!Number.isFinite(ms)) return '—';
  let value = Math.abs(ms) / 60_000;
  if (value < 1) return 'just now';
  let unit = 'min';
  for (const [limit, next] of STEPS) {
    if (value < limit) break;
    value /= limit;
    unit = next;
  }
  const text = `${Math.round(value)} ${unit}`;
  return ms > 0 ? `in ${text}` : `${text} ago`;
}

/** what a disconnect came to, in one line for the notice strip */
export function outcomeLine(outcome: DisconnectOutcome): string {
  const who = `${partyLabel(outcome.provider)} connection ${shortId(outcome.connectionId)}`;
  const forgotten = outcome.accountsForgotten === 1 ? '1 account reference forgotten' : `${outcome.accountsForgotten} account references forgotten`;
  switch (outcome.party) {
    case 'ended':
      return `${who} disconnected — ended at the party, ${forgotten}.`;
    case 'gone':
      return `${who} disconnected — the party no longer had it, ${forgotten}.`;
    case 'refused':
      return `${who} forgotten here, but the party refused to end it (${outcome.partyError ?? 'no code'}) — ${forgotten}.`;
    default:
      return `${who} forgotten here, but the party could not be reached — ${forgotten}.`;
  }
}

const STATE_CLASS: Record<string, string> = {
  active: 'ok-chip',
  needs_reauth: 'warn-chip',
  awaiting_input: 'warn-chip',
  blocked: 'danger-chip',
  failed: 'danger-chip',
  expired: 'danger-chip',
  disabled: 'danger-chip',
};

/** the state as a colour: alive green, a sign-in wanted amber, the dead ones red, anything else grey */
export function StateBadge({ state }: Readonly<{ state: string }>) {
  return <span className={`chip ${STATE_CLASS[state] ?? ''}`}>{state}</span>;
}

/** an id kept short, the whole of it on hover and one click away in the clipboard */
export function IdChip({ id, testId }: Readonly<{ id: string; testId?: string }>) {
  const [copied, setCopied] = useState(false);
  const copy = async () => {
    try {
      await navigator.clipboard.writeText(id);
      setCopied(true);
      setTimeout(() => setCopied(false), 1500);
    } catch {
      // no clipboard (an insecure origin, a denied permission): the title still carries the whole id
    }
  };
  return (
    <button type="button" className="id-chip" title={`${id} — click to copy`} data-testid={testId} onClick={() => void copy()}>
      <code>{shortId(id)}</code>
      {copied && <span className="sub"> copied</span>}
    </button>
  );
}

/** a destructive act asks once, inline: the button turns into the question with its yes and no */
export function ConfirmButton({
  label,
  question,
  yes,
  testId,
  disabled,
  onConfirm,
}: Readonly<{ label: string; question: string; yes: string; testId: string; disabled?: boolean; onConfirm: () => void }>) {
  const [armed, setArmed] = useState(false);
  if (!armed) {
    return (
      <button type="button" data-testid={testId} disabled={disabled} onClick={() => setArmed(true)}>
        {label}
      </button>
    );
  }
  return (
    <span className="confirm-inline" data-testid={`${testId}-confirm`}>
      <span className="sub">{question}</span>
      <button
        type="button"
        className="btn danger"
        data-testid={`${testId}-yes`}
        disabled={disabled}
        onClick={() => {
          setArmed(false);
          onConfirm();
        }}
      >
        {yes}
      </button>
      <button type="button" data-testid={`${testId}-no`} onClick={() => setArmed(false)}>
        Cancel
      </button>
    </span>
  );
}

/** the scheduler's last word on a row: when it ran, what it hit, when it may run again */
function ScheduleCell({ row, now }: Readonly<{ row: SessionRow; now: number }>) {
  const paused = row.scheduleNotBefore && Date.parse(row.scheduleNotBefore) > now;
  return (
    <>
      <div>{row.lastScheduledSyncAt ? relativeText(row.lastScheduledSyncAt, now) : 'never'}</div>
      {row.lastScheduledSyncAt && <div className="cell-sub">{whenText(row.lastScheduledSyncAt)}</div>}
      {row.lastScheduleError && (
        <div className="cell-sub error-sub" data-testid={`session-error-${row.sessionId}`}>
          last error: {row.lastScheduleError}
        </div>
      )}
      {paused && <div className="cell-sub">paused until {whenText(row.scheduleNotBefore)}</div>}
    </>
  );
}

/**
 * The sessions table the Users diagnosis and the Bank connections dashboard
 * share: party, state, connection, the moments, the scheduler's word, the
 * bundle, the accounts — and a Disconnect that asks once.
 */
export function SessionsTable({
  rows,
  busy,
  testId,
  onDisconnect,
}: Readonly<{ rows: SessionRow[]; busy: boolean; testId: string; onDisconnect: (row: SessionRow) => void }>) {
  const now = Date.now();
  return (
    <table data-testid={testId}>
      <thead>
        <tr>
          <th>Party</th>
          <th>State</th>
          <th>Connection</th>
          <th>Created</th>
          <th>Last seen</th>
          <th>Scheduled sync</th>
          <th>Bundle kept</th>
          <th>Accounts</th>
          <th />
        </tr>
      </thead>
      <tbody>
        {rows.map((row) => (
          <tr key={row.sessionId} className={row.stale ? 'stale' : ''} data-testid={`session-${row.sessionId}`}>
            <td>
              <div className="cell-title">{partyLabel(row.provider)}</div>
              {row.label && <div className="cell-sub">{row.label}</div>}
            </td>
            <td>
              <StateBadge state={row.state} />
              {row.stale && (
                <span className="chip warn-chip" data-testid={`session-stale-${row.sessionId}`}>
                  stale
                </span>
              )}
            </td>
            <td>
              <IdChip id={row.connectionId} testId={`session-connection-${row.sessionId}`} />
              <div className="cell-sub">
                session <IdChip id={row.sessionId} />
              </div>
            </td>
            <td>
              {relativeText(row.createdAt, now)}
              <div className="cell-sub">{whenText(row.createdAt)}</div>
            </td>
            <td>
              {relativeText(row.lastSeenAt, now)}
              <div className="cell-sub">{whenText(row.lastSeenAt)}</div>
            </td>
            <td>
              <ScheduleCell row={row} now={now} />
            </td>
            <td>{row.keptBundle ? 'yes' : 'no'}</td>
            <td>{row.accounts ?? 0}</td>
            <td className="cell-actions">
              <ConfirmButton
                label="Disconnect"
                question="End it at the party and forget it here?"
                yes="Yes, disconnect"
                testId={`session-disconnect-${row.sessionId}`}
                disabled={busy}
                onConfirm={() => onDisconnect(row)}
              />
            </td>
          </tr>
        ))}
        {rows.length === 0 && (
          <tr>
            <td colSpan={9}>—</td>
          </tr>
        )}
      </tbody>
    </table>
  );
}
