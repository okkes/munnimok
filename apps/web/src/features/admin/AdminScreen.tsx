import { useCallback, useEffect, useState } from 'react';
import { useLang } from '@/i18n';
import { apiFetch } from '@/lib/api';
import { AppBar, IconButton } from '@/ui/AppBar';
import { Button } from '@/ui/Button';
import { Icon } from '@/ui/Icon';

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

const STATUS_LABEL: Record<string, string> = { CR: 'created', LN: 'linked', EX: 'expired', RJ: 'rejected', SU: 'suspended', GA: 'authorizing', UA: 'authorizing', GC: 'consenting', SA: 'selecting' };

/**
 * Admin area (Admin:Subs on the server decides who sees this): user
 * overview + GoCardless requisition cleanup — select stale connections
 * and delete them to free the free-tier quota.
 */
export function AdminScreen() {
  const { t } = useLang();
  const [users, setUsers] = useState<AdminUser[]>([]);
  const [requisitions, setRequisitions] = useState<AdminRequisition[] | null>(null);
  const [selected, setSelected] = useState<Set<string>>(new Set());
  const [busy, setBusy] = useState(false);

  const reload = useCallback(async () => {
    const [usersRes, reqRes] = await Promise.all([
      apiFetch('/admin/users').catch(() => null),
      apiFetch('/admin/gocardless/requisitions').catch(() => null),
    ]);
    if (usersRes?.ok) setUsers((await usersRes.json()) as AdminUser[]);
    if (reqRes?.ok) setRequisitions((await reqRes.json()) as AdminRequisition[]);
  }, []);
  useEffect(() => void reload(), [reload]);

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
      await apiFetch(`/admin/gocardless/requisitions/${id}`, { method: 'DELETE' }).catch(() => undefined);
    }
    setSelected(new Set());
    await reload();
    setBusy(false);
  };

  return (
    <div className="m-fade flex h-full flex-col" data-testid="screen-admin">
      <AppBar
        title={t('admin.title')}
        leading={
          <IconButton label={t('action.back')} testId="admin-back" onClick={() => window.history.back()}>
            <Icon name="chevron-left" size={24} />
          </IconButton>
        }
      />
      <div className="min-h-0 flex-1 overflow-y-auto px-5 pb-6">
        {/* requisitions with selectable deletion */}
        <div className="m-cap mt-2 mb-1 px-1">{t('admin.requisitions')}</div>
        <div className="overflow-hidden rounded-card border border-line bg-surface" data-testid="admin-requisitions">
          {(requisitions ?? []).map((r) => (
            <label
              key={r.requisitionId}
              className="m-tap flex cursor-pointer items-center gap-3 border-b border-line-2 px-4 py-3 last:border-0"
            >
              <input
                type="checkbox"
                data-testid={`admin-req-check-${r.requisitionId}`}
                checked={selected.has(r.requisitionId)}
                onChange={() => toggle(r.requisitionId)}
                className="h-4 w-4 accent-[var(--m-brand)]"
              />
              <span className="min-w-0 flex-1">
                <span className="block truncate text-[13px] font-medium text-ink">
                  {r.institutionId}
                  {r.stale && (
                    <span className="ml-1.5 rounded bg-warning-soft px-1 py-px text-[10px] font-semibold text-warning">
                      {t('admin.stale')}
                    </span>
                  )}
                </span>
                <span className="block truncate font-mono text-[11px] text-ink-4">
                  {r.requisitionId.slice(0, 13)}… · {r.created ? new Date(r.created).toLocaleDateString() : '—'}
                  {r.ownerSub ? ` · ${r.ownerSub.slice(0, 10)}` : ''}
                </span>
              </span>
              <span className={`rounded px-1.5 py-0.5 text-[10px] font-semibold ${r.status === 'LN' ? 'bg-accent-soft text-accent-deep' : 'bg-bg-2 text-ink-3'}`}>
                {STATUS_LABEL[r.status] ?? r.status}
              </span>
            </label>
          ))}
          {requisitions?.length === 0 && <div className="px-4 py-5 text-center text-[13px] text-ink-3">—</div>}
        </div>
        {selected.size > 0 && (
          <Button variant="danger" className="mt-3 w-full" data-testid="admin-delete-selected" disabled={busy} onClick={() => void deleteSelected()}>
            {t('admin.deleteSelected', { n: selected.size })}
          </Button>
        )}

        {/* users */}
        <div className="m-cap mt-6 mb-1 px-1">{t('admin.users')}</div>
        <div className="overflow-hidden rounded-card border border-line bg-surface" data-testid="admin-users">
          {users.map((u) => (
            <div key={u.id} className="flex items-center gap-3 border-b border-line-2 px-4 py-3 last:border-0">
              <Icon name="account-outline" size={18} color="var(--m-ink-3)" />
              <span className="min-w-0 flex-1">
                <span className="block truncate text-[13px] font-medium text-ink">{u.displayName ?? u.sub}</span>
                <span className="block truncate font-mono text-[11px] text-ink-4">
                  {u.sub} · {new Date(u.createdAt).toLocaleDateString()}
                </span>
              </span>
              <span className="text-[11px] text-ink-3">{t('admin.spaces', { n: u.spaceCount })}</span>
            </div>
          ))}
        </div>
      </div>
    </div>
  );
}
