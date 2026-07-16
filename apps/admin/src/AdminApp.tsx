import { useCallback, useEffect, useMemo, useState } from 'react';
import type { AdminConfig } from './main';

interface AdminUser {
  id: string;
  sub: string;
  displayName: string | null;
  email: string | null;
  createdAt: string;
  spaceCount: number;
  isAdmin: boolean;
  bootstrap: boolean;
}
interface AdminRequisition {
  requisitionId: string;
  status: string;
  institutionId: string;
  created: string | null;
  accountCount: number;
  stale: boolean;
  ownerSub: string | null;
}
interface ProviderQuota {
  provider: string;
  scope: string;
  limit: number | null;
  remaining: number | null;
  resetAtUtc: string | null;
  capturedAtUtc: string;
}
interface HealthInfo {
  build?: string;
  capabilities?: Record<string, unknown>;
}

const STATUS_LABEL: Record<string, string> = {
  CR: 'created', LN: 'linked', EX: 'expired', RJ: 'rejected', SU: 'suspended',
  GA: 'authorizing', UA: 'authorizing', GC: 'consenting', SA: 'selecting',
};

const PROVIDER_LABEL: Record<string, string> = {
  gocardless: 'GoCardless (Bank Account Data)',
  enablebanking: 'Enable Banking',
};

interface BankProviderState {
  active: string;
  configured: string[];
}

type Screen = 'overview' | 'users' | 'connections';

/** GC consents run ~90 days; flag the ones inside the final 14 */
const expiresSoon = (r: AdminRequisition): boolean =>
  r.status === 'LN' && !!r.created && Date.now() - new Date(r.created).getTime() > 76 * 86_400_000;

interface AdminAppProps {
  config: AdminConfig;
  /** null = test-auth mode (X-User-Sub header from the sub box) */
  getToken: (() => Promise<string | undefined>) | null;
}

/**
 * munni admin console (admin-redesign): a desktop-first operator tool —
 * overview, user management incl. admin grants, and bank-connection
 * upkeep. Talks to the same API (/admin/* gated server-side); it
 * deliberately shares no code with the member app.
 */
export function AdminApp({ config, getToken }: Readonly<AdminAppProps>) {
  const [screen, setScreen] = useState<Screen>('overview');
  const [sub, setSub] = useState(() => localStorage.getItem('munni_admin_sub') ?? '');
  const [users, setUsers] = useState<AdminUser[]>([]);
  const [requisitions, setRequisitions] = useState<AdminRequisition[] | null>(null);
  const [provider, setProvider] = useState<BankProviderState | null>(null);
  const [quota, setQuota] = useState<ProviderQuota[]>([]);
  const [health, setHealth] = useState<HealthInfo | null>(null);
  const [selected, setSelected] = useState<Set<string>>(new Set());
  const [denied, setDenied] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const call = useCallback(
    async (path: string, init: RequestInit = {}) => {
      const headers = new Headers(init.headers);
      headers.set('Content-Type', 'application/json');
      if (getToken) {
        const token = await getToken();
        if (token) headers.set('Authorization', `Bearer ${token}`);
      } else if (sub) {
        headers.set('X-User-Sub', sub);
      }
      return fetch(`${config.apiUrl}${path}`, { ...init, headers });
    },
    [config.apiUrl, getToken, sub],
  );

  const reload = useCallback(async () => {
    const ping = await call('/admin/ping').catch(() => null);
    setDenied(!ping?.ok);
    if (!ping?.ok) return;
    const [usersRes, reqRes, providerRes, quotaRes, healthRes] = await Promise.all([
      call('/admin/users'),
      call('/admin/gocardless/requisitions'),
      call('/admin/bank-provider'),
      call('/admin/quota'),
      fetch(`${config.apiUrl}/health`).catch(() => null),
    ]);
    if (usersRes.ok) setUsers((await usersRes.json()) as AdminUser[]);
    if (reqRes.ok) setRequisitions((await reqRes.json()) as AdminRequisition[]);
    if (providerRes.ok) setProvider((await providerRes.json()) as BankProviderState);
    if (quotaRes.ok) setQuota((await quotaRes.json()) as ProviderQuota[]);
    if (healthRes?.ok) setHealth((await healthRes.json()) as HealthInfo);
  }, [call, config.apiUrl]);

  useEffect(() => {
    if (getToken || sub) void reload();
  }, [reload, getToken, sub]);

  const act = async (fn: () => Promise<Response>) => {
    setBusy(true);
    setError(null);
    const res = await fn().catch(() => null);
    if (!res?.ok) {
      const body = (await res?.json().catch(() => null)) as { error?: string } | null;
      setError(body?.error ?? 'request failed');
    }
    await reload();
    setBusy(false);
  };

  const pickProvider = (id: string) => act(() => call('/admin/bank-provider', { method: 'PUT', body: JSON.stringify({ provider: id }) }));
  const promote = (userSub: string) => act(() => call(`/admin/admins/${encodeURIComponent(userSub)}`, { method: 'POST' }));
  const demote = (userSub: string) => act(() => call(`/admin/admins/${encodeURIComponent(userSub)}`, { method: 'DELETE' }));

  const deleteSelected = async () => {
    setBusy(true);
    for (const id of selected) {
      await call(`/admin/gocardless/requisitions/${id}`, { method: 'DELETE' }).catch(() => undefined);
    }
    setSelected(new Set());
    await reload();
    setBusy(false);
  };

  return (
    <div className="shell">
      <aside className="sidebar">
        <div className="brand">
          munni<span className="dot">.</span> <span className="brand-sub">admin</span>
        </div>
        <nav>
          {(
            [
              ['overview', 'Overview'],
              ['users', 'Users'],
              ['connections', 'Bank connections'],
            ] as [Screen, string][]
          ).map(([id, label]) => (
            <button
              key={id}
              data-testid={`nav-${id}`}
              className={screen === id ? 'active' : ''}
              onClick={() => setScreen(id)}
            >
              {label}
            </button>
          ))}
        </nav>
        <div className="sidebar-foot">
          {!getToken && (
            <input
              data-testid="admin-sub"
              value={sub}
              placeholder="test subject (X-User-Sub)"
              onChange={(e) => {
                setSub(e.target.value);
                localStorage.setItem('munni_admin_sub', e.target.value);
              }}
            />
          )}
        </div>
      </aside>

      <main className="content">
        {denied && <p className="denied">This account is not on the admin list.</p>}
        {error && (
          <p className="error" data-testid="admin-error">
            {error}
          </p>
        )}
        {!denied && screen === 'overview' && (
          <OverviewScreen
            users={users}
            requisitions={requisitions}
            quota={quota}
            health={health}
            provider={provider}
            busy={busy}
            onPickProvider={pickProvider}
          />
        )}
        {!denied && screen === 'users' && (
          <UsersScreen users={users} busy={busy} onPromote={promote} onDemote={demote} />
        )}
        {!denied && screen === 'connections' && (
          <ConnectionsScreen
            requisitions={requisitions}
            selected={selected}
            busy={busy}
            onToggle={(id) =>
              setSelected((prev) => {
                const next = new Set(prev);
                if (next.has(id)) next.delete(id);
                else next.add(id);
                return next;
              })
            }
            onDeleteSelected={() => void deleteSelected()}
          />
        )}
      </main>
    </div>
  );
}

function OverviewScreen({
  users,
  requisitions,
  quota,
  health,
  provider,
  busy,
  onPickProvider,
}: Readonly<{
  users: AdminUser[];
  requisitions: AdminRequisition[] | null;
  quota: ProviderQuota[];
  health: HealthInfo | null;
  provider: BankProviderState | null;
  busy: boolean;
  onPickProvider: (id: string) => void;
}>) {
  const linked = (requisitions ?? []).filter((r) => r.status === 'LN');
  const expiring = (requisitions ?? []).filter(expiresSoon);
  const createdLast30d = (requisitions ?? []).filter(
    (r) => r.created && Date.now() - new Date(r.created).getTime() < 30 * 86_400_000,
  ).length;
  const caps = Object.entries(health?.capabilities ?? {}).filter(([, v]) => typeof v === 'boolean');

  return (
    <>
      <h1>Overview</h1>
      <div className="tiles" data-testid="overview-tiles">
        <Tile label="Users" value={String(users.length)} />
        <Tile label="Space memberships" value={String(users.reduce((sum, u) => sum + u.spaceCount, 0))} />
        <Tile label="Linked banks" value={String(linked.length)} />
        <Tile label="Expiring ≤14d" value={String(expiring.length)} warn={expiring.length > 0} />
      </div>

      <section className="card">
        <h2>GoCardless quota</h2>
        <p className="hint">
          Captured from the nightly sync traffic — no extra calls. {createdLast30d} connection
          {createdLast30d === 1 ? '' : 's'} created in the last 30 days.
        </p>
        <table data-testid="overview-quota">
          <thead>
            <tr>
              <th>Scope</th>
              <th>Remaining</th>
              <th>Resets</th>
              <th>Seen</th>
            </tr>
          </thead>
          <tbody>
            {quota.map((q) => (
              <tr key={`${q.provider}:${q.scope}`}>
                <td>{q.scope}</td>
                <td className={q.remaining !== null && q.limit !== null && q.remaining <= q.limit / 5 ? 'warn' : ''}>
                  {q.remaining ?? '—'} / {q.limit ?? '—'}
                </td>
                <td>{q.resetAtUtc ? new Date(q.resetAtUtc).toLocaleString() : '—'}</td>
                <td>{new Date(q.capturedAtUtc).toLocaleString()}</td>
              </tr>
            ))}
            {quota.length === 0 && (
              <tr>
                <td colSpan={4}>No snapshots yet — they appear after the next bank sync.</td>
              </tr>
            )}
          </tbody>
        </table>
      </section>

      {provider && (
        <section className="card">
          <h2>Bank-data provider</h2>
          <p className="hint">New bank consents use the selected provider; existing accounts keep the one that created them.</p>
          <div data-testid="admin-bank-provider">
            {provider.configured.map((id) => (
              <label key={id} className="radio">
                <input
                  type="radio"
                  name="bank-provider"
                  data-testid={`admin-provider-${id}`}
                  checked={provider.active === id}
                  disabled={busy}
                  onChange={() => onPickProvider(id)}
                />
                {PROVIDER_LABEL[id] ?? id}
              </label>
            ))}
          </div>
        </section>
      )}

      {health && (
        <section className="card">
          <h2>Server</h2>
          <div className="chips" data-testid="overview-capabilities">
            <span className="chip on">build {health.build ?? '—'}</span>
            {caps.map(([name, on]) => (
              <span key={name} className={`chip ${on ? 'on' : ''}`}>
                {name}
              </span>
            ))}
          </div>
        </section>
      )}
    </>
  );
}

function Tile({ label, value, warn = false }: Readonly<{ label: string; value: string; warn?: boolean }>) {
  return (
    <div className={`tile ${warn ? 'tile-warn' : ''}`}>
      <div className="tile-value">{value}</div>
      <div className="tile-label">{label}</div>
    </div>
  );
}

function UsersScreen({
  users,
  busy,
  onPromote,
  onDemote,
}: Readonly<{ users: AdminUser[]; busy: boolean; onPromote: (sub: string) => void; onDemote: (sub: string) => void }>) {
  const [query, setQuery] = useState('');
  const filtered = useMemo(() => {
    const q = query.trim().toLowerCase();
    if (!q) return users;
    return users.filter((u) =>
      [u.displayName, u.email, u.sub].some((field) => field?.toLowerCase().includes(q)),
    );
  }, [users, query]);

  return (
    <>
      <h1>Users</h1>
      <input
        data-testid="users-search"
        className="search"
        value={query}
        placeholder="Search name, email or sub…"
        onChange={(e) => setQuery(e.target.value)}
      />
      <section className="card">
        <table data-testid="admin-users">
          <thead>
            <tr>
              <th>User</th>
              <th>Joined</th>
              <th>Spaces</th>
              <th>Role</th>
              <th />
            </tr>
          </thead>
          <tbody>
            {filtered.map((u) => (
              <tr key={u.id}>
                <td>
                  <div className="cell-title">{u.displayName ?? u.sub}</div>
                  <div className="cell-sub">
                    {u.email ? `${u.email} · ` : ''}
                    {u.sub}
                  </div>
                </td>
                <td>{new Date(u.createdAt).toLocaleDateString()}</td>
                <td>{u.spaceCount} spaces</td>
                <td>
                  {u.bootstrap && <span className="chip on">bootstrap admin</span>}
                  {u.isAdmin && !u.bootstrap && <span className="chip on">admin</span>}
                </td>
                <td className="cell-actions">
                  {!u.isAdmin && (
                    <button data-testid={`promote-${u.sub}`} className="btn" disabled={busy} onClick={() => onPromote(u.sub)}>
                      Promote to admin
                    </button>
                  )}
                  {u.isAdmin && !u.bootstrap && (
                    <button data-testid={`demote-${u.sub}`} className="btn danger" disabled={busy} onClick={() => onDemote(u.sub)}>
                      Demote
                    </button>
                  )}
                </td>
              </tr>
            ))}
            {filtered.length === 0 && (
              <tr>
                <td colSpan={5}>—</td>
              </tr>
            )}
          </tbody>
        </table>
      </section>
    </>
  );
}

function ConnectionsScreen({
  requisitions,
  selected,
  busy,
  onToggle,
  onDeleteSelected,
}: Readonly<{
  requisitions: AdminRequisition[] | null;
  selected: Set<string>;
  busy: boolean;
  onToggle: (id: string) => void;
  onDeleteSelected: () => void;
}>) {
  const [onlyExpiring, setOnlyExpiring] = useState(false);
  const rows = (requisitions ?? []).filter((r) => !onlyExpiring || expiresSoon(r));

  return (
    <>
      <h1>Bank connections</h1>
      <div className="toolbar">
        <label className="radio">
          <input
            type="checkbox"
            data-testid="connections-expiring-filter"
            checked={onlyExpiring}
            onChange={(e) => setOnlyExpiring(e.target.checked)}
          />{' '}
          expiring soon only
        </label>
        {selected.size > 0 && (
          <button className="btn danger" disabled={busy} onClick={onDeleteSelected}>
            Delete selected ({selected.size})
          </button>
        )}
      </div>
      <section className="card">
        <table data-testid="admin-requisitions">
          <thead>
            <tr>
              <th />
              <th>Institution</th>
              <th>Status</th>
              <th>Accounts</th>
            </tr>
          </thead>
          <tbody>
            {rows.map((r) => (
              <tr key={r.requisitionId} className={r.stale ? 'stale' : ''}>
                <td>
                  <input type="checkbox" checked={selected.has(r.requisitionId)} onChange={() => onToggle(r.requisitionId)} />
                </td>
                <td>
                  <div className="cell-title">
                    {r.institutionId} {r.stale && <em>stale</em>} {expiresSoon(r) && <span className="chip warn-chip">expiring</span>}
                  </div>
                  <div className="cell-sub">
                    {r.requisitionId.slice(0, 13)}… · {r.created ? new Date(r.created).toLocaleDateString() : '—'}
                    {r.ownerSub ? ` · ${r.ownerSub.slice(0, 12)}` : ''}
                  </div>
                </td>
                <td>{STATUS_LABEL[r.status] ?? r.status}</td>
                <td>{r.accountCount} acct</td>
              </tr>
            ))}
            {rows.length === 0 && (
              <tr>
                <td colSpan={4}>—</td>
              </tr>
            )}
          </tbody>
        </table>
      </section>
    </>
  );
}
