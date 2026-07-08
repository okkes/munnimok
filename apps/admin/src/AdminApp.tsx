import { useCallback, useEffect, useState } from 'react';
import type { AdminConfig } from './main';

interface AdminUser {
  id: string;
  sub: string;
  displayName: string | null;
  email: string | null;
  createdAt: string;
  spaceCount: number;
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

const STATUS_LABEL: Record<string, string> = {
  CR: 'created', LN: 'linked', EX: 'expired', RJ: 'rejected', SU: 'suspended',
  GA: 'authorizing', UA: 'authorizing', GC: 'consenting', SA: 'selecting',
};

interface AdminAppProps {
  config: AdminConfig;
  /** null = test-auth mode (X-User-Sub header from the sub box) */
  getToken: (() => Promise<string | undefined>) | null;
}

/**
 * munni admin console: standalone tool for the operator — user overview
 * and GoCardless requisition cleanup. Talks to the same API (everything
 * under /admin/* is gated by Admin:Subs server-side); it deliberately
 * shares no code with the member app.
 */
export function AdminApp({ config, getToken }: AdminAppProps) {
  const [sub, setSub] = useState(() => localStorage.getItem('munni_admin_sub') ?? '');
  const [users, setUsers] = useState<AdminUser[]>([]);
  const [requisitions, setRequisitions] = useState<AdminRequisition[] | null>(null);
  const [selected, setSelected] = useState<Set<string>>(new Set());
  const [denied, setDenied] = useState(false);
  const [busy, setBusy] = useState(false);

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
    const [usersRes, reqRes] = await Promise.all([call('/admin/users'), call('/admin/gocardless/requisitions')]);
    if (usersRes.ok) setUsers((await usersRes.json()) as AdminUser[]);
    if (reqRes.ok) setRequisitions((await reqRes.json()) as AdminRequisition[]);
  }, [call]);

  useEffect(() => {
    if (getToken || sub) void reload();
  }, [reload, getToken, sub]);

  const toggle = (id: string) =>
    setSelected((prev) => {
      const next = new Set(prev);
      if (next.has(id)) next.delete(id);
      else next.add(id);
      return next;
    });

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
    <main className="wrap">
      <header>
        <h1>munni admin</h1>
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
      </header>

      {denied && <p className="denied">This account is not on the admin list (Admin:Subs).</p>}

      <section>
        <h2>Bank connections (GoCardless)</h2>
        <table data-testid="admin-requisitions">
          <tbody>
            {(requisitions ?? []).map((r) => (
              <tr key={r.requisitionId} className={r.stale ? 'stale' : ''}>
                <td>
                  <input
                    type="checkbox"
                    checked={selected.has(r.requisitionId)}
                    onChange={() => toggle(r.requisitionId)}
                  />
                </td>
                <td>
                  {r.institutionId} {r.stale && <em>stale</em>}
                  <small>
                    {r.requisitionId.slice(0, 13)}… · {r.created ? new Date(r.created).toLocaleDateString() : '—'}
                    {r.ownerSub ? ` · ${r.ownerSub.slice(0, 12)}` : ''}
                  </small>
                </td>
                <td>{STATUS_LABEL[r.status] ?? r.status}</td>
                <td>{r.accountCount} acct</td>
              </tr>
            ))}
            {requisitions?.length === 0 && (
              <tr>
                <td colSpan={4}>—</td>
              </tr>
            )}
          </tbody>
        </table>
        {selected.size > 0 && (
          <button className="btn danger" disabled={busy} onClick={() => void deleteSelected()}>
            Delete selected ({selected.size})
          </button>
        )}
      </section>

      <section>
        <h2>Users</h2>
        <table data-testid="admin-users">
          <tbody>
            {users.map((u) => (
              <tr key={u.id}>
                <td>
                  {u.displayName ?? u.sub}
                  <small>
                    {u.sub} · {new Date(u.createdAt).toLocaleDateString()}
                  </small>
                </td>
                <td>{u.spaceCount} spaces</td>
              </tr>
            ))}
          </tbody>
        </table>
      </section>
    </main>
  );
}
