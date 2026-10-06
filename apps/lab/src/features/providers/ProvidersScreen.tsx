import { useCallback, useEffect, useState } from 'react';
import { getJson } from '../../app/api';
import type { ScreenProps } from '../../app/LabApp';
import { hrefOf, navigate } from '../../app/router';
import { tierOf, when } from '../../lib/format';
import type { Catalogue, ProviderEntry } from '../../types';
import { AbsentCard } from '../dashboard/DashboardScreen';
import { KillSwitch } from './KillSwitch';
import { agentLine, quotaLine, quotaLow } from './providerFacts';
import { StateChip } from './StateChip';

const KIND_ORDER: Record<string, number> = { bank: 0, store: 1, registry: 2 };

/** every party the control plane serves, with what it is and the kill switch */
export function ProvidersScreen({ call, busy, act }: Readonly<ScreenProps>) {
  const [catalogue, setCatalogue] = useState<Catalogue | null | 'unreachable' | 'loading'>('loading');
  const [query, setQuery] = useState('');

  const load = useCallback(async () => {
    setCatalogue(await getJson<Catalogue>(call, '/lab/providers'));
  }, [call]);
  useEffect(() => {
    void load();
  }, [load]);

  if (catalogue === 'loading') {
    return (
      <>
        <h1>Providers</h1>
        <p className="hint">loading…</p>
      </>
    );
  }
  if (catalogue === null) {
    return (
      <>
        <h1>Providers</h1>
        <AbsentCard />
      </>
    );
  }
  if (catalogue === 'unreachable') {
    return (
      <>
        <h1>Providers</h1>
        <section className="card" data-testid="lab-status-unreachable">
          <p className="hint">The control plane did not answer.</p>
        </section>
      </>
    );
  }

  const q = query.trim().toLowerCase();
  const rows = [...catalogue.providers]
    .filter((p) => !q || p.id.includes(q) || p.name.toLowerCase().includes(q) || p.kind.includes(q))
    .sort((a, b) => (KIND_ORDER[a.kind] ?? 9) - (KIND_ORDER[b.kind] ?? 9) || a.id.localeCompare(b.id));

  return (
    <>
      <div className="head-row">
        <h1>Providers</h1>
        <span className="spacer" />
        <input data-testid="providers-search" placeholder="filter by id, name or kind" value={query} onChange={(e) => setQuery(e.target.value)} />
      </div>
      <p className="hint">
        The kill switch: pause a party the moment it misbehaves (users see it paused, nothing is fetched), resume it when it is fine
        again, retire it for good — retiring expires every live session. A reason key is optional; the app shows its copy to users
        when it carries one (for example connect.paused.maintenance). Degraded is the platform&apos;s own verdict after a party changed
        its site; mark healthy once the adapter is fixed. Open a party for its facts, its inventory and its canary.
      </p>
      <section className="card">
        <table data-testid="providers-table">
          <thead>
            <tr>
              <th>Party</th>
              <th>Kind</th>
              <th>Runs</th>
              <th>State</th>
              <th>Since</th>
              <th>Budget</th>
              <th />
            </tr>
          </thead>
          <tbody>
            {rows.map((p) => (
              <ProviderRow key={p.id} p={p} busy={busy} act={act} call={call} onChanged={load} />
            ))}
            {rows.length === 0 && (
              <tr>
                <td colSpan={7} className="empty">
                  No party matches.
                </td>
              </tr>
            )}
          </tbody>
        </table>
      </section>
    </>
  );
}

function ProviderRow({ p, busy, act, call, onChanged }: Readonly<{ p: ProviderEntry; onChanged: () => Promise<void> } & ScreenProps>) {
  const status = p.status;
  const accepts = status?.acceptsWork ?? true;
  return (
    <tr data-testid={`provider-${p.id}`} className={`clickable ${accepts ? '' : 'stale'}`} onClick={() => navigate(`providers/${encodeURIComponent(p.id)}`)}>
      <td>
        <div className="cell-title">
          <a href={hrefOf(`providers/${encodeURIComponent(p.id)}`)} onClick={(e) => e.stopPropagation()}>
            {p.name}
          </a>
        </div>
        <div className="cell-sub">{p.id}</div>
      </td>
      <td>{p.kind}</td>
      <td>
        <div>{tierOf(p.runtime)}</div>
        <div className="sub">{agentLine(p)}</div>
      </td>
      <td>
        <StateChip state={status?.state} testId={`provider-state-${p.id}`} />
      </td>
      <td>{when(status?.since)}</td>
      <td className={quotaLow(status?.quota) ? 'warn' : ''} data-testid={`provider-quota-${p.id}`}>
        {quotaLine(status?.quota)}
      </td>
      <td className="cell-actions" onClick={(e) => e.stopPropagation()}>
        <KillSwitch providerId={p.id} state={status?.state} busy={busy} act={act} call={call} onChanged={onChanged} compact />
      </td>
    </tr>
  );
}
