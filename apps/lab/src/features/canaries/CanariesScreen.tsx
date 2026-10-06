import { useCallback, useEffect, useState } from 'react';
import { getJson } from '../../app/api';
import type { ScreenProps } from '../../app/LabApp';
import { hrefOf } from '../../app/router';
import { minutes, when } from '../../lib/format';
import type { Canary } from '../../types';
import { AbsentCard } from '../dashboard/DashboardScreen';

/** the operator's own connections that prove a party still works, fetched on their interval */
export function CanariesScreen({ call, busy, act }: Readonly<ScreenProps>) {
  const [canaries, setCanaries] = useState<Canary[] | null | 'unreachable' | 'loading'>('loading');

  const load = useCallback(async () => {
    const res = await getJson<{ canaries: Canary[] }>(call, '/lab/canaries');
    setCanaries(res === null || res === 'unreachable' ? res : res.canaries);
  }, [call]);
  useEffect(() => {
    void load();
  }, [load]);

  const runNow = async (providerId: string) => {
    if (await act(() => call(`/lab/canaries/${encodeURIComponent(providerId)}/run`, { method: 'POST' }))) await load();
  };

  if (canaries === 'loading') {
    return (
      <>
        <h1>Canaries</h1>
        <p className="hint">loading…</p>
      </>
    );
  }
  if (canaries === null) {
    return (
      <>
        <h1>Canaries</h1>
        <AbsentCard />
      </>
    );
  }
  if (canaries === 'unreachable') {
    return (
      <>
        <h1>Canaries</h1>
        <section className="card" data-testid="lab-status-unreachable">
          <p className="hint">The control plane did not answer.</p>
        </section>
      </>
    );
  }

  return (
    <>
      <h1>Canaries</h1>
      <p className="hint">
        A canary is one of the operator&apos;s own connections fetched on an interval: an intact run proves the party still works, a broken
        one is the verdict an adapter author reads first. Canaries become lab sessions you flip into a canary with the test bench.
      </p>
      <section className="card">
        <table data-testid="canaries-table">
          <thead>
            <tr>
              <th>Party</th>
              <th>Resource</th>
              <th>Every</th>
              <th>Last run</th>
              <th>Verdict</th>
              <th />
            </tr>
          </thead>
          <tbody>
            {canaries.map((c) => (
              <tr key={`${c.providerId}:${c.resource}`} data-testid={`canary-${c.providerId}-${c.resource}`} className={c.intact === false ? 'stale' : ''}>
                <td>
                  <a href={hrefOf(`providers/${encodeURIComponent(c.providerId)}`)}>{c.providerId}</a>
                </td>
                <td className="mono">{c.resource}</td>
                <td>{minutes(c.intervalMinutes)}</td>
                <td>{when(c.lastRunAt)}</td>
                <td>
                  {c.intact == null ? (
                    <span className="sub">not run yet</span>
                  ) : (
                    <span className={`chip ${c.intact ? 'ok-chip' : 'danger-chip'}`}>{c.intact ? 'intact' : (c.verdict ?? 'broken')}</span>
                  )}
                  {c.lastJobId && (
                    <>
                      {' '}
                      <a href={hrefOf(`jobs/${encodeURIComponent(c.lastJobId)}`)}>run</a>
                    </>
                  )}
                </td>
                <td className="cell-actions">
                  <button data-testid={`canary-run-${c.providerId}`} className="btn" disabled={busy} onClick={() => void runNow(c.providerId)}>
                    run now
                  </button>
                </td>
              </tr>
            ))}
            {canaries.length === 0 && (
              <tr>
                <td colSpan={6} className="empty">
                  No canaries configured.
                </td>
              </tr>
            )}
          </tbody>
        </table>
      </section>
    </>
  );
}
