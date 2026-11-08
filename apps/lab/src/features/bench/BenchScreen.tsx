import { useCallback, useEffect, useState } from 'react';
import { getJson } from '../../app/api';
import type { ScreenProps } from '../../app/LabApp';
import { hrefOf, navigate } from '../../app/router';
import { ago, shortId } from '../../lib/format';
import type { Catalogue, LabSessionRow, SessionView } from '../../types';
import { AbsentCard } from '../dashboard/DashboardScreen';
import { stateChip } from '../jobs/jobFacts';
import { SIGNING_IN } from './benchFacts';

/** a lab session's state, in the connector's word, coloured by what it means */
const SESSION_CHIP: Record<string, string> = { active: 'ok-chip', awaiting_input: 'warn-chip', needs_reauth: 'warn-chip', blocked: 'danger-chip', failed: 'danger-chip', expired: 'danger-chip' };
export const sessionChip = (state: string): string => SESSION_CHIP[state] ?? stateChip(state);

/** what a session still signing in waits for, and that opening it picks the run up (#576) */
export function signingInLine(row: Pick<LabSessionRow, 'provider' | 'state'>): string {
  if (row.state !== 'awaiting_input') return 'still signing in — open it to follow the run';
  return row.provider === 'explore' ? 'the live view waits for you — open it to drive the browser' : 'waiting for your answer — open it to answer';
}

/**
 * The relay keeps a session's state as it last read it, and nobody reads a
 * run the operator walked away from — a session still signing in is asked
 * afresh, which also brings the relay's copy up to date.
 */
async function freshStates(call: ScreenProps['call'], rows: LabSessionRow[]): Promise<LabSessionRow[]> {
  return Promise.all(
    rows.map(async (row) => {
      if (!SIGNING_IN.has(row.state)) return row;
      const view = await getJson<SessionView>(call, `/lab/bench/${encodeURIComponent(row.provider)}/login/${encodeURIComponent(row.sessionId)}`);
      return view && view !== 'unreachable' ? { ...row, state: view.state } : row;
    }),
  );
}

/**
 * The test bench (#441 L2): the operator's own connections at the parties,
 * made under the lab subject — sign in, answer what the party asks, fetch
 * and read the records, keep the session for tomorrow, flip it into the
 * party's canary. Nothing here is a person's, nothing is ingested.
 */
export function BenchScreen({ call }: Readonly<ScreenProps>) {
  const [sessions, setSessions] = useState<LabSessionRow[] | null | 'unreachable' | 'loading'>('loading');
  const [catalogue, setCatalogue] = useState<Catalogue | null>(null);
  const [party, setParty] = useState('');
  const [address, setAddress] = useState('');

  const load = useCallback(async () => {
    const [s, c] = await Promise.all([getJson<LabSessionRow[]>(call, '/lab/bench/sessions'), getJson<Catalogue>(call, '/lab/providers')]);
    setSessions(Array.isArray(s) ? await freshStates(call, s) : s);
    setCatalogue(c && c !== 'unreachable' ? c : null);
  }, [call]);
  useEffect(() => {
    void load();
  }, [load]);

  if (sessions === 'loading') {
    return (
      <>
        <h1>Bench</h1>
        <p className="hint">loading…</p>
      </>
    );
  }
  if (sessions === null) {
    return (
      <>
        <h1>Bench</h1>
        <AbsentCard />
      </>
    );
  }
  if (sessions === 'unreachable') {
    return (
      <>
        <h1>Bench</h1>
        <section className="card" data-testid="lab-status-unreachable">
          <p className="hint">The control plane did not answer.</p>
        </section>
      </>
    );
  }

  const parties = [...(catalogue?.providers ?? [])].sort((a, b) => a.name.localeCompare(b.name));
  const nameOf = (id: string) => parties.find((p) => p.id === id)?.name ?? id;

  return (
    <>
      <div className="head-row">
        <h1>Bench</h1>
        <span className="spacer" />
        <select data-testid="bench-party" value={party} onChange={(e) => setParty(e.target.value)}>
          <option value="">connect a party…</option>
          {parties.map((p) => (
            <option key={p.id} value={p.id}>
              {p.name} ({p.id})
            </option>
          ))}
        </select>
        <a className="btn quiet" href={hrefOf('bench/retention')} data-testid="bench-retention-link">
          retention bench →
        </a>
        <button className="btn" data-testid="bench-connect" disabled={!party} onClick={() => navigate(`bench/connect/${encodeURIComponent(party)}`)}>
          connect
        </button>
      </div>
      <div className="row" style={{ marginBottom: 8 }} data-testid="bench-explore">
        <input data-testid="bench-explore-url" value={address} placeholder="https://… explore a site that has no adapter yet" onChange={(e) => setAddress(e.target.value)} />
        <button className="btn quiet" data-testid="bench-explore-go" disabled={!/^https?:\/\/\S+/.test(address.trim())} onClick={() => navigate(`bench/connect/explore?url=${encodeURIComponent(address.trim())}`)}>
          explore
        </button>
      </div>
      <p className="hint">
        Your own connections at the parties, made under the lab subject: sign in the way a person would (codes, pictures, the live browser),
        say where the run happens (the fleet or one agent), fetch a resource and read the records back — nothing is ingested, nothing
        reaches a space. A session stays usable until the party ends it; one tap makes it the party&apos;s canary.
      </p>
      <section className="card">
        <table data-testid="bench-sessions">
          <thead>
            <tr>
              <th>Party</th>
              <th>Label</th>
              <th>State</th>
              <th>Bundle</th>
              <th>Runs on</th>
              <th>Signed in</th>
              <th>Last used</th>
            </tr>
          </thead>
          <tbody>
            {sessions.map((s) => (
              <tr key={s.sessionId} data-testid={`bench-session-${s.sessionId}`} className="clickable" onClick={() => navigate(`bench/sessions/${encodeURIComponent(s.sessionId)}`)}>
                <td>
                  <div className="cell-title">
                    <a href={hrefOf(`bench/sessions/${encodeURIComponent(s.sessionId)}`)} onClick={(e) => e.stopPropagation()}>
                      {s.provider === 'explore' ? 'Explore a site' : nameOf(s.provider)}
                    </a>
                  </div>
                  <div className="cell-sub mono">{shortId(s.sessionId)}</div>
                </td>
                <td>{s.label ?? '—'}</td>
                <td>
                  <span className={`chip ${sessionChip(s.state)}`} data-testid={`bench-state-${s.sessionId}`}>
                    {s.state}
                  </span>
                  {SIGNING_IN.has(s.state) && (
                    <div className="sub" data-testid={`bench-signing-in-${s.sessionId}`}>
                      {signingInLine(s)}
                    </div>
                  )}
                  {s.lastError && <div className="cell-sub mono">{s.lastError}</div>}
                </td>
                <td>{s.hasBundle ? 'kept' : 'none'}</td>
                <td>{s.preferAgent ?? 'no preference'}</td>
                <td>{ago(s.createdAt)}</td>
                <td>{ago(s.lastUsedAt)}</td>
              </tr>
            ))}
            {sessions.length === 0 && (
              <tr>
                <td colSpan={7} className="empty">
                  No lab sessions yet — pick a party above and connect.
                </td>
              </tr>
            )}
          </tbody>
        </table>
      </section>
    </>
  );
}
