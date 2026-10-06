import { useCallback, useEffect, useState } from 'react';
import { getJson } from '../../app/api';
import type { ScreenProps } from '../../app/LabApp';
import { hrefOf } from '../../app/router';
import { minutes, tierOf, when } from '../../lib/format';
import type { Canary, ProviderEntry, RemoteConsent } from '../../types';
import { KillSwitch } from './KillSwitch';
import { agentLine, allFields, quotaLine, sessionLine } from './providerFacts';
import { StateChip } from './StateChip';

type Inventory = 'closed' | 'loading' | 'none' | RemoteConsent[];

/** one party in full: what the manifest promises, the status with its switch, the inventory, the canary */
export function ProviderScreen({ id, call, busy, act }: Readonly<{ id: string } & ScreenProps>) {
  const [entry, setEntry] = useState<ProviderEntry | null | 'unreachable' | 'loading'>('loading');
  const [canaries, setCanaries] = useState<Canary[]>([]);
  const [inventory, setInventory] = useState<Inventory>('closed');

  const load = useCallback(async () => {
    const [e, c] = await Promise.all([getJson<ProviderEntry>(call, `/lab/providers/${encodeURIComponent(id)}`), getJson<{ canaries: Canary[] }>(call, '/lab/canaries')]);
    setEntry(e);
    setCanaries(c && c !== 'unreachable' ? c.canaries.filter((x) => x.providerId === id) : []);
  }, [call, id]);
  useEffect(() => {
    void load();
  }, [load]);

  const openInventory = async () => {
    setInventory('loading');
    const res = await call(`/lab/providers/${encodeURIComponent(id)}/remote-consents`).catch(() => null);
    if (!res?.ok) {
      setInventory('none');
      return;
    }
    setInventory(((await res.json()) as { consents: RemoteConsent[] }).consents);
  };

  const revokeConsent = async (consent: RemoteConsent) => {
    // revoking a consent ends someone's bank access — possibly another environment's; the origin says whose
    const whose = consent.origin ? `started from ${consent.origin}` : 'of unknown origin';
    if (!globalThis.confirm(`Revoke consent ${consent.id.slice(0, 13)}… (${whose}) at ${id}? Its accounts stop fetching wherever it is used.`)) return;
    const ok = await act(() => call(`/lab/providers/${encodeURIComponent(id)}/remote-consents/${encodeURIComponent(consent.id)}`, { method: 'DELETE' }));
    if (ok) await openInventory();
  };

  if (entry === 'loading') return <p className="hint">loading…</p>;
  if (entry === null || entry === 'unreachable') {
    return (
      <>
        <p>
          <a href={hrefOf('providers')}>← Providers</a>
        </p>
        <section className="card" data-testid="provider-missing">
          <p className="hint">{entry === null ? `No party named ${id} on this control plane.` : 'The control plane did not answer.'}</p>
        </section>
      </>
    );
  }

  const p = entry;
  const status = p.status;
  const fields = allFields(p);
  const kindLine = p.country ? `${p.kind} · ${p.country}` : p.kind;

  return (
    <>
      <p>
        <a href={hrefOf('providers')}>← Providers</a>
      </p>
      <div className="head-row">
        <h1 data-testid="provider-title">{p.name}</h1>
        <StateChip state={status?.state} testId="provider-state" />
        <span className="sub mono">{p.id}</span>
        <span className="spacer" />
      </div>

      <section className="card" data-testid="provider-status-card">
        <div className="card-head">
          <h2>Status</h2>
          <span className="sub">
            {status?.since ? `since ${when(status.since)}` : ''}
            {status?.reasonKey ? ` · ${status.reasonKey}` : ''}
          </span>
        </div>
        <div className="row">
          <KillSwitch providerId={p.id} state={status?.state} busy={busy} act={act} call={call} onChanged={load} />
        </div>
        {status?.quota && (
          <p className="hint" data-testid="provider-quota">
            Budget {quotaLine(status.quota)}
          </p>
        )}
      </section>

      <section className="card" data-testid="provider-facts">
        <h2>What the manifest promises</h2>
        <div className="facts">
          <Fact label="Kind" value={kindLine} />
          <Fact label="Runtime" value={tierOf(p.runtime)} />
          <Fact label="Runs on" value={agentLine(p)} />
          <Fact label="Secret custody" value={p.secretCustody ?? '—'} />
          <Fact label="Unattended fetch" value={p.unattendedFetch ? 'yes — syncs by itself' : 'no — a person is present'} />
          <Fact label="Web support" value={p.webSupport ?? '—'} />
          <Fact label="Logout" value={p.logout ?? '—'} />
          <Fact label="Credential store" value={p.offersCredentialStore ? 'offered' : 'no'} />
          <Fact label="Auth flow" value={p.auth?.flow ?? '—'} />
          <Fact label="Session" value={sessionLine(p)} />
          <Fact label="Challenges it may raise" value={(p.auth?.challenges ?? []).join(', ') || 'none'} />
          <Fact label="Login origins" value={(p.auth?.loginOrigins ?? []).join(', ') || 'the page it lands on'} />
          <Fact label="Manifest version" value={String(p.manifestVersion ?? '—')} />
          <Fact
            label="Limits"
            value={[
              p.limits?.minIntervalSeconds != null ? `every ${minutes(Math.round(p.limits.minIntervalSeconds / 60))}` : null,
              p.limits?.maxHistoryDays != null ? `${p.limits.maxHistoryDays} d history` : null,
              p.limits?.minRequestGapMs != null ? `${p.limits.minRequestGapMs} ms between requests` : null,
              p.limits?.preferredFetchHourLocal != null ? `fetch at ${p.limits.preferredFetchHourLocal}:00 local` : null,
            ]
              .filter(Boolean)
              .join(' · ') || '—'}
          />
        </div>

        <h3>Sign-in fields</h3>
        <table data-testid="provider-fields">
          <thead>
            <tr>
              <th>Step</th>
              <th>Field</th>
              <th>Type</th>
              <th>Secret</th>
              <th>Required</th>
            </tr>
          </thead>
          <tbody>
            {fields.map((f) => (
              <tr key={`${f.step}:${f.key}`}>
                <td>{f.step}</td>
                <td className="mono">{f.key}</td>
                <td>{f.type}</td>
                <td>{f.secret ? 'yes' : ''}</td>
                <td>{f.required ? 'yes' : ''}</td>
              </tr>
            ))}
            {fields.length === 0 && (
              <tr>
                <td colSpan={5} className="empty">
                  No typed fields — the party signs the person in on its own page.
                </td>
              </tr>
            )}
          </tbody>
        </table>

        <h3>Resources</h3>
        <table data-testid="provider-resources">
          <thead>
            <tr>
              <th>Resource</th>
              <th>Returns</th>
              <th>Params</th>
              <th>History</th>
              <th>Typical</th>
              <th>Per fetch</th>
            </tr>
          </thead>
          <tbody>
            {(p.resources ?? []).map((r) => (
              <tr key={r.id}>
                <td className="mono">{r.id}</td>
                <td>{r.returns}</td>
                <td className="sub">{(r.params ?? []).filter((x) => !x.internal).map((x) => `${x.key}${x.required ? '*' : ''}`).join(', ') || '—'}</td>
                <td>{r.maxHistoryDays != null ? `${r.maxHistoryDays} d` : '—'}</td>
                <td>{r.typicalDurationSeconds != null ? `${r.typicalDurationSeconds} s` : '—'}</td>
                <td>{r.maxRecordsPerFetch ?? '—'}</td>
              </tr>
            ))}
          </tbody>
        </table>
      </section>

      <section className="card" data-testid="provider-inventory-card">
        <div className="card-head">
          <h2>Inventory</h2>
          {inventory === 'closed' && (
            <button data-testid="provider-inventory-open" onClick={() => void openInventory()}>
              load
            </button>
          )}
          {inventory !== 'closed' && (
            <button data-testid="provider-inventory-close" onClick={() => setInventory('closed')}>
              close
            </button>
          )}
        </div>
        <p className="hint">
          What the operator&apos;s account at the party holds: every consent, attributed by the environment it was started from (its return
          origin). Revoking one ends that consent&apos;s bank access wherever it is used — meant for leftovers of removed environments.
          Parties without an account at an aggregator keep no inventory.
        </p>
        {inventory === 'loading' && <p className="hint">loading…</p>}
        {inventory === 'none' && (
          <p className="hint" data-testid="provider-inventory-none">
            This party keeps no inventory (or the control plane did not answer).
          </p>
        )}
        {Array.isArray(inventory) && (
          <table data-testid="provider-inventory">
            <thead>
              <tr>
                <th>Consent</th>
                <th>Institution</th>
                <th>Status</th>
                <th>Accounts</th>
                <th>Environment</th>
                <th />
              </tr>
            </thead>
            <tbody>
              {inventory.map((c) => (
                <tr key={c.id} data-testid={`remote-consent-${c.id}`}>
                  <td>
                    <div className="cell-title">{c.id.slice(0, 13)}…</div>
                    <div className="cell-sub">{c.createdAt ? new Date(c.createdAt).toLocaleDateString() : '—'}</div>
                  </td>
                  <td>{c.institutionId ?? '—'}</td>
                  <td>{c.status}</td>
                  <td>{c.accountCount} acct</td>
                  <td>{c.origin ?? 'unattributed'}</td>
                  <td className="cell-actions">
                    <button data-testid={`remote-consent-revoke-${c.id}`} className="btn danger" disabled={busy} onClick={() => void revokeConsent(c)}>
                      revoke
                    </button>
                  </td>
                </tr>
              ))}
              {inventory.length === 0 && (
                <tr>
                  <td colSpan={6} className="empty">
                    No consents on the party&apos;s account.
                  </td>
                </tr>
              )}
            </tbody>
          </table>
        )}
      </section>

      <section className="card" data-testid="provider-canary-card">
        <h2>Canary</h2>
        {canaries.length === 0 && <p className="hint">No canary proves this party yet.</p>}
        {canaries.map((c) => (
          <p key={`${c.providerId}:${c.resource}`} data-testid="provider-canary">
            <span className="mono">{c.resource}</span> every {minutes(c.intervalMinutes)} · last run {when(c.lastRunAt)} ·{' '}
            {c.intact == null ? <span className="sub">not run yet</span> : <span className={`chip ${c.intact ? 'ok-chip' : 'danger-chip'}`}>{c.intact ? 'intact' : (c.verdict ?? 'broken')}</span>}
          </p>
        ))}
      </section>
    </>
  );
}

function Fact({ label, value }: Readonly<{ label: string; value: string }>) {
  return (
    <div className="fact">
      <span className="fact-label">{label}</span>
      <span className="fact-value">{value}</span>
    </div>
  );
}
