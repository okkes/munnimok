import { hrefOf } from '../../app/router';
import { ago, snake, when } from '../../lib/format';
import type { ProviderHealth as Health } from '../../types';

const WINDOWS = ['24h', '7d', '30d'] as const;

/** `provider_changed: 3 · agent_unavailable: 1`, the wire codes as the logs spell them */
export const codeLine = (codes: Readonly<Record<string, number>>): string =>
  Object.entries(codes)
    .sort((a, b) => b[1] - a[1])
    .map(([code, n]) => `${snake(code)}: ${n}`)
    .join(' · ') || '—';

/** a party's health over the last day, week and month (#441 L1): outcomes, codes, who asked, the people behind the failures, the canary, the reports */
export function ProviderHealthCard({ id, health }: Readonly<{ id: string; health: Health | null | undefined }>) {
  if (!health) {
    return (
      <section className="card" data-testid="provider-health-card">
        <h2>Health</h2>
        <p className="hint">No health report for this party yet.</p>
      </section>
    );
  }
  const day = health.windows['24h'];
  return (
    <section className="card" data-testid="provider-health-card">
      <div className="card-head">
        <h2>Health</h2>
        <span className="sub">
          <a href={hrefOf(`jobs?provider=${encodeURIComponent(id)}`)} data-testid="provider-jobs-link">
            every run →
          </a>
        </span>
      </div>
      <table data-testid="provider-health">
        <thead>
          <tr>
            <th>Window</th>
            <th>Runs</th>
            <th>Succeeded</th>
            <th>Failed</th>
            <th>Open</th>
            <th>People affected</th>
            <th>Who asked</th>
          </tr>
        </thead>
        <tbody>
          {WINDOWS.map((key) => {
            const w = health.windows[key];
            if (!w) return null;
            return (
              <tr key={key} data-testid={`provider-health-${key}`} className={w.failed + w.expired > 0 ? 'stale' : ''}>
                <td>{key}</td>
                <td>{w.total}</td>
                <td>{w.succeeded}</td>
                <td className={w.failed + w.expired > 0 ? 'warn' : ''}>{w.failed + w.expired}</td>
                <td>{w.open}</td>
                <td>{w.peopleAffected}</td>
                <td className="sub">
                  {Object.entries(w.byTrigger)
                    .map(([trigger, n]) => `${trigger}: ${n}`)
                    .join(' · ') || '—'}
                </td>
              </tr>
            );
          })}
        </tbody>
      </table>
      <div className="facts">
        <div className="fact">
          <span className="fact-label">Failures today, by code</span>
          <span className="fact-value mono" data-testid="provider-health-codes">
            {day ? codeLine(day.byCode) : '—'}
          </span>
        </div>
        <div className="fact">
          <span className="fact-label">Last success</span>
          <span className="fact-value">{health.lastSuccessAt ? `${ago(health.lastSuccessAt)} (${when(health.lastSuccessAt)})` : 'none this month'}</span>
        </div>
        <div className="fact">
          <span className="fact-label">Last failure</span>
          <span className="fact-value">
            {health.lastFailure ? (
              <a href={hrefOf(`jobs/${encodeURIComponent(health.lastFailure.jobId)}`)} data-testid="provider-health-last-failure">
                {snake(health.lastFailure.code)} · {ago(health.lastFailure.at)}
              </a>
            ) : (
              'none this month'
            )}
          </span>
        </div>
        <div className="fact">
          <span className="fact-label">Sessions</span>
          <span className="fact-value" data-testid="provider-health-sessions">
            {Object.entries(health.sessions)
              .map(([state, n]) => `${snake(state)}: ${n}`)
              .join(' · ') || 'none'}
          </span>
        </div>
        <div className="fact">
          <span className="fact-label">Failure reports</span>
          <span className="fact-value" data-testid="provider-health-reports">
            {health.reports} to read · {health.pendingReports} awaiting the person
          </span>
        </div>
      </div>
    </section>
  );
}
