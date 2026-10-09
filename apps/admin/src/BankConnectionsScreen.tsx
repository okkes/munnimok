import { useMemo, useState } from 'react';
import { ConfirmButton, SessionsTable, partyLabel } from './sessionBits';
import type { SessionRow } from './sessionBits';

/** a session on the dashboard: the shared row with the person it belongs to */
export interface BankConnectionRow extends SessionRow {
  userSub: string;
  userName: string;
}

/** GET /admin/bank-connections: the rows, whether every party was asked for, and whether the list was cut */
export interface BankConnectionsDoc {
  all: boolean;
  total: number;
  capped: boolean;
  connections: BankConnectionRow[];
}

const matches = (row: BankConnectionRow, q: string): boolean =>
  [row.userName, row.userSub, row.provider, partyLabel(row.provider), row.connectionId, row.label ?? ''].some((field) =>
    field.toLowerCase().includes(q),
  );

const plural = (n: number, word: string): string => `${n} ${word}${n === 1 ? '' : 's'}`;

function Stat({ label, value, warn = false }: Readonly<{ label: string; value: number; warn?: boolean }>) {
  return (
    <div className={`tile ${warn ? 'tile-warn' : ''}`}>
      <div className="tile-value">{value}</div>
      <div className="tile-label">{label}</div>
    </div>
  );
}

/**
 * Bank connections (user 2026-10-09: "I can't find any more where I could
 * see all the connections made so far with Enable Banking and GoCardless
 * … build it for Enable Banking too so we can disconnect those"): every
 * open-banking consent the connector platform binds, across users,
 * grouped per person — the rows the nightly sync runs on — with a
 * Disconnect per row and a clean-up of a person's stale ones.
 */
export function BankConnectionsScreen({
  doc,
  busy,
  onToggleAll,
  onDisconnect,
  onCleanUp,
}: Readonly<{
  /** the list as last loaded — a string is the one line that says why it could not be listed; null = not in yet */
  doc: BankConnectionsDoc | string | null;
  busy: boolean;
  onToggleAll: (all: boolean) => void;
  onDisconnect: (row: BankConnectionRow) => void;
  /** every stale row of one person, after one confirm */
  onCleanUp: (rows: BankConnectionRow[]) => void;
}>) {
  const [query, setQuery] = useState('');
  const loaded = typeof doc === 'string' ? null : doc;
  const rows = useMemo(() => loaded?.connections ?? [], [loaded]);
  const groups = useMemo(() => {
    const q = query.trim().toLowerCase();
    const bySub = new Map<string, BankConnectionRow[]>();
    for (const row of rows) {
      if (q && !matches(row, q)) continue;
      bySub.set(row.userSub, [...(bySub.get(row.userSub) ?? []), row]);
    }
    return [...bySub.entries()];
  }, [rows, query]);
  const stale = rows.filter((row) => row.stale);

  return (
    <div data-testid="bank-connections-screen">
      <div className="page-head">
        <div>
          <h1>Bank connections</h1>
          <p className="sub">
            Every open-banking consent (GoCardless, Enable Banking) the connector platform binds, across all users — the rows the nightly
            sync runs on. Stale rows are consents nothing fetches any more. Disconnecting ends the consent at the party and forgets it here;
            the accounts and their history stay in the app, and a reconnect lands on them again. The person finds the same door under
            Settings → Connections in the app. The bank feeds counted on the Users page are the accounts&apos; histories, not these consents —
            they stay until the person deletes the account.
          </p>
        </div>
      </div>

      <div className="tiles" data-testid="bank-connections-tiles">
        <Stat label="Connections" value={rows.length} />
        <Stat label="Stale" value={stale.length} warn={stale.length > 0} />
        <Stat label="Users" value={new Set(rows.map((row) => row.userSub)).size} />
      </div>

      <section className="card">
        <div className="card-head">
          <h2>Connections</h2>
          <span className="card-tools">
            <input
              data-testid="bank-connections-search"
              className="search"
              placeholder="filter by user, party, connection…"
              value={query}
              onChange={(e) => setQuery(e.target.value)}
            />
            <label className="sub">
              <input
                type="checkbox"
                data-testid="bank-connections-all"
                checked={loaded?.all ?? false}
                disabled={busy}
                onChange={(e) => onToggleAll(e.target.checked)}
              />{' '}
              every party (shops and registries too)
            </label>
          </span>
        </div>
        {doc === null && <span className="sub">loading…</span>}
        {typeof doc === 'string' && (
          <p className="error" data-testid="bank-connections-unavailable">
            The connections could not be listed: {doc}
          </p>
        )}
        {loaded?.capped && (
          <p className="hint">
            Showing the first {loaded.connections.length} of {loaded.total} — narrow it down with the filter.
          </p>
        )}
        {loaded && groups.length === 0 && (
          <p className="sub" data-testid="bank-connections-empty">
            {query ? 'No connection matches the filter.' : 'No connections — nobody has an open-banking consent on this environment.'}
          </p>
        )}
        {groups.map(([sub, userRows]) => {
          const staleRows = userRows.filter((row) => row.stale);
          const name = userRows[0].userName;
          return (
            <div key={sub} className="user-group" data-testid={`bank-connections-user-${sub}`}>
              <div className="card-head">
                <div>
                  <span className="cell-title">{name}</span>{' '}
                  <span className="cell-sub">
                    {sub} · {plural(userRows.length, 'connection')}
                    {staleRows.length > 0 ? ` · ${staleRows.length} stale` : ''}
                  </span>
                </div>
                {staleRows.length > 0 && (
                  <ConfirmButton
                    label={`Clean up stale (${staleRows.length})`}
                    question={`Disconnect the ${plural(staleRows.length, 'stale connection')} of ${name}?`}
                    yes="Yes, clean up"
                    testId={`bank-connections-cleanup-${sub}`}
                    disabled={busy}
                    onConfirm={() => onCleanUp(staleRows)}
                  />
                )}
              </div>
              <SessionsTable rows={userRows} busy={busy} testId={`bank-connections-table-${sub}`} onDisconnect={(row) => onDisconnect(row as BankConnectionRow)} />
            </div>
          );
        })}
      </section>
    </div>
  );
}
