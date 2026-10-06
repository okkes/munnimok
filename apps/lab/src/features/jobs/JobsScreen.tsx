import { useCallback, useEffect, useState } from 'react';
import { getJson } from '../../app/api';
import type { ScreenProps } from '../../app/LabApp';
import { hrefOf, navigate, useRouteQuery } from '../../app/router';
import { ago, shortId } from '../../lib/format';
import type { JobList } from '../../types';
import { AbsentCard } from '../dashboard/DashboardScreen';
import { artifactsLine, jobsQuery, outcomeLine, stateChip, triggerWord, whoLine } from './jobFacts';

const STATES = ['', 'queued', 'leased', 'running', 'awaiting_input', 'succeeded', 'failed', 'expired'];
const TRIGGERS = ['', 'user', 'schedule', 'lab', 'canary', 'none'];
const KINDS = ['', 'login', 'fetch'];

type Filters = { provider: string; state: string; kind: string; trigger: string; code: string; user: string; limit: string };

/** the filter form's values from the hash query (`#/jobs?provider=ah&state=failed`), so a link from a party's page lands narrowed */
function filtersFrom(query: URLSearchParams): Filters {
  return {
    provider: query.get('provider') ?? '',
    state: query.get('state') ?? '',
    kind: query.get('kind') ?? '',
    trigger: query.get('trigger') ?? '',
    code: query.get('code') ?? '',
    user: query.get('user') ?? '',
    limit: query.get('limit') ?? '',
  };
}

/**
 * The job history (#441 L1): every run the control plane made, newest
 * first — who asked, which party, how it ended, what it left behind.
 * Never what was typed: the control plane's view has no field for inputs
 * or material. Narrowed by the form; the filters live in the hash so a
 * narrowed list is a link.
 */
export function JobsScreen({ call }: Readonly<ScreenProps>) {
  const query = useRouteQuery();
  const [filters, setFilters] = useState<Filters>(() => filtersFrom(query));
  const [list, setList] = useState<JobList | null | 'unreachable' | 'loading'>('loading');

  const load = useCallback(async (f: Filters) => {
    setList('loading');
    setList(await getJson<JobList>(call, `/lab/jobs${jobsQuery(f)}`));
  }, [call]);

  // the hash is the source of truth: typing in the form rewrites it, and the list follows the hash
  useEffect(() => {
    const next = filtersFrom(query);
    setFilters(next);
    void load(next);
  }, [query, load]);

  const apply = (patch: Partial<Filters>) => {
    const next = { ...filters, ...patch };
    setFilters(next);
    navigate(`jobs${jobsQuery(next)}`);
  };

  if (list === null) {
    return (
      <>
        <h1>Jobs</h1>
        <AbsentCard />
      </>
    );
  }

  return (
    <>
      <div className="head-row">
        <h1>Jobs</h1>
        <span className="spacer" />
        <button className="btn" data-testid="jobs-refresh" onClick={() => void load(filters)}>
          refresh
        </button>
      </div>
      <p className="hint">
        Every run the control plane made, newest first: who asked (a person by name, the schedule, the lab, a canary), the party, how it
        ended and what it left behind. A failed run&apos;s picture is readable only once the person reported it — or at once for the lab&apos;s
        own runs. What was typed is on no view.
      </p>
      <section className="card">
        <div className="row" data-testid="jobs-filters">
          <input data-testid="jobs-filter-provider" placeholder="party id" value={filters.provider} onChange={(e) => apply({ provider: e.target.value })} />
          <select data-testid="jobs-filter-state" value={filters.state} onChange={(e) => apply({ state: e.target.value })}>
            {STATES.map((s) => (
              <option key={s} value={s}>
                {s || 'any state'}
              </option>
            ))}
          </select>
          <select data-testid="jobs-filter-kind" value={filters.kind} onChange={(e) => apply({ kind: e.target.value })}>
            {KINDS.map((k) => (
              <option key={k} value={k}>
                {k || 'any kind'}
              </option>
            ))}
          </select>
          <select data-testid="jobs-filter-trigger" value={filters.trigger} onChange={(e) => apply({ trigger: e.target.value })}>
            {TRIGGERS.map((tr) => (
              <option key={tr} value={tr}>
                {tr || 'asked by anyone'}
              </option>
            ))}
          </select>
          <input data-testid="jobs-filter-code" placeholder="error code" value={filters.code} onChange={(e) => apply({ code: e.target.value })} />
          <input data-testid="jobs-filter-user" placeholder="user sub" value={filters.user} onChange={(e) => apply({ user: e.target.value })} />
        </div>
        {list === 'loading' && <p className="hint">loading…</p>}
        {list === 'unreachable' && (
          <p className="hint" data-testid="lab-status-unreachable">
            The control plane did not answer.
          </p>
        )}
        {list !== 'loading' && list !== 'unreachable' && (
          <>
            <table data-testid="jobs-table">
              <thead>
                <tr>
                  <th>When</th>
                  <th>Party</th>
                  <th>Run</th>
                  <th>Who</th>
                  <th>State</th>
                  <th>Outcome</th>
                  <th>Left behind</th>
                </tr>
              </thead>
              <tbody>
                {list.jobs.map((job) => (
                  <tr
                    key={job.jobId}
                    data-testid={`job-${job.jobId}`}
                    className={`clickable ${job.state === 'failed' || job.state === 'expired' ? 'stale' : ''}`}
                    onClick={() => navigate(`jobs/${encodeURIComponent(job.jobId)}`)}
                  >
                    <td>
                      <div className="cell-title">{ago(job.createdAt)}</div>
                      <div className="cell-sub mono">{shortId(job.jobId)}</div>
                    </td>
                    <td>
                      <a href={hrefOf(`providers/${encodeURIComponent(job.providerId)}`)} onClick={(e) => e.stopPropagation()}>
                        {job.providerId}
                      </a>
                    </td>
                    <td>
                      <div className="cell-title">
                        {job.kind}
                        {job.resource ? ` · ${job.resource}` : ''}
                      </div>
                      <div className="cell-sub">{triggerWord(job.trigger)}</div>
                    </td>
                    <td className="mono">{whoLine(job)}</td>
                    <td>
                      <span className={`chip ${stateChip(job.state)}`} data-testid={`job-state-${job.jobId}`}>
                        {job.state}
                      </span>
                    </td>
                    <td className={job.error ? 'mono' : ''}>{outcomeLine(job)}</td>
                    <td>{artifactsLine(job)}</td>
                  </tr>
                ))}
                {list.jobs.length === 0 && (
                  <tr>
                    <td colSpan={7} className="empty">
                      No runs match.
                    </td>
                  </tr>
                )}
              </tbody>
            </table>
            {list.truncated && (
              <p className="hint" data-testid="jobs-truncated">
                The list was cut at the limit — narrow the filters.
              </p>
            )}
          </>
        )}
      </section>
    </>
  );
}
