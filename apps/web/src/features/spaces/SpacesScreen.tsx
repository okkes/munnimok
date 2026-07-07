import { useState } from 'react';
import { useLiveQuery } from 'dexie-react-hooks';
import { useLang } from '@/i18n';
import { useData } from '@/app/data';
import { useSession } from '@/app/session';
import { SpaceInvitesBanner, SpaceMembersSection } from './SpaceSharing';
import type { SpaceRow } from '@/db/types';
import { AppBar, IconButton } from '@/ui/AppBar';
import { Button } from '@/ui/Button';
import { Icon } from '@/ui/Icon';
import { Sheet } from '@/ui/Sheet';

/**
 * v1 spaces are local-only containers (your own separate bookkeeping
 * areas). Sharing with other people arrives with the sync server in
 * Phase 2 — the data model is already per-space, so nothing changes then.
 */
export function SpacesScreen() {
  const { t } = useLang();
  const { db, repo, spaceId, setActiveSpace } = useData();
  const identity = useSession((s) => s.identity);
  const syncing = identity?.kind === 'user';
  const [createOpen, setCreateOpen] = useState(false);
  const [editing, setEditing] = useState<SpaceRow | null>(null);
  const [name, setName] = useState('');
  const [deleteError, setDeleteError] = useState<string | null>(null);

  const spaces = useLiveQuery(() => db.spaces.filter((s) => s.deleted === 0).toArray(), []);

  const createSpace = () => {
    if (!name.trim()) return;
    const id = repo.newId();
    void repo
      .upsert('space', id, id, {
        name: name.trim(),
        kind: 'personal',
        currency: 'EUR',
        periodType: 'month',
        periodDay: 1,
      })
      .then(() => setActiveSpace(id));
    setCreateOpen(false);
    setName('');
  };

  const saveRename = () => {
    if (!editing || !name.trim()) return;
    void repo.upsert('space', editing.id, editing.id, { name: name.trim() });
    setEditing(null);
  };

  const deleteSpace = () => {
    if (!editing) return;
    if (editing.id === spaceId) {
      setDeleteError(t('space.cannotDeleteActive'));
      return;
    }
    if ((spaces ?? []).length <= 1) {
      setDeleteError(t('space.cannotDeleteOnly'));
      return;
    }
    void repo.remove('space', editing.id, editing.id);
    setEditing(null);
  };

  return (
    <div className="m-fade flex h-full flex-col" data-testid="screen-spaces">
      <AppBar
        large
        title={t('screen.spaces')}
        trailing={
          <IconButton label={t('space.new')} testId="spaces-add" onClick={() => setCreateOpen(true)}>
            <Icon name="plus" size={22} />
          </IconButton>
        }
      />
      <div className="min-h-0 flex-1 overflow-y-auto px-5 pb-6">
        {syncing && <SpaceInvitesBanner />}
        <div className="overflow-hidden rounded-card border border-line bg-surface">
          {(spaces ?? []).map((space, i) => {
            const active = space.id === spaceId;
            return (
              <div key={space.id}>
                {i > 0 && <div className="mx-4 h-px bg-line-2" />}
                <div className="flex items-center">
                  <button
                    data-testid={`space-row-${space.id}`}
                    onClick={() => void setActiveSpace(space.id)}
                    className="m-tap flex min-w-0 flex-1 items-center gap-3 border-none bg-transparent px-4 py-3.5 text-left"
                  >
                    <span
                      className={`flex h-10 w-10 shrink-0 items-center justify-center rounded-full ${
                        active ? 'bg-accent-soft text-accent-deep' : 'bg-bg-2 text-ink-3'
                      }`}
                    >
                      <Icon name={space.kind === 'shared' ? 'account-group-outline' : 'leaf'} size={20} />
                    </span>
                    <span className="min-w-0 flex-1">
                      <span className="block truncate text-[15px] font-medium text-ink">{space.name}</span>
                      {active && <span className="block text-xs text-accent-deep">{t('space.active')}</span>}
                    </span>
                    {active && <Icon name="check" size={18} color="var(--m-accent)" />}
                  </button>
                  <button
                    aria-label={t('action.edit')}
                    data-testid={`space-edit-${space.id}`}
                    onClick={() => {
                      setEditing(space);
                      setName(space.name);
                      setDeleteError(null);
                    }}
                    className="m-tap flex h-9 w-9 shrink-0 items-center justify-center border-none bg-transparent text-ink-4"
                  >
                    <Icon name="pencil-outline" size={18} />
                  </button>
                </div>
              </div>
            );
          })}
        </div>
      </div>

      {/* Create space */}
      <Sheet open={createOpen} onOpenChange={setCreateOpen} title={t('space.new')} height={300}>
        <div className="flex flex-col gap-3 pt-1">
          <input
            data-testid="space-create-name"
            value={name}
            onChange={(e) => setName(e.target.value)}
            placeholder={t('space.nameThisSpace')}
            className="h-12 w-full rounded-input border border-line bg-surface px-4 text-[15px] text-ink outline-none placeholder:text-ink-4"
          />
          <Button data-testid="space-create-save" onClick={createSpace} disabled={!name.trim()}>
            {t('space.create')}
          </Button>
        </div>
      </Sheet>

      {/* Edit space */}
      <Sheet open={!!editing} onOpenChange={(open) => !open && setEditing(null)} title={t('action.edit')} height={syncing ? 600 : 360}>
        <div className="flex flex-col gap-3 pt-1">
          <input
            data-testid="space-edit-name"
            value={name}
            onChange={(e) => setName(e.target.value)}
            className="h-12 w-full rounded-input border border-line bg-surface px-4 text-[15px] text-ink outline-none"
          />
          <Button data-testid="space-edit-save" onClick={saveRename} disabled={!name.trim()}>
            {t('action.save')}
          </Button>
          <Button variant="danger" data-testid="space-edit-delete" onClick={deleteSpace}>
            {t('space.delete')}
          </Button>
          {deleteError && (
            <p className="text-center text-[13px] text-negative" data-testid="space-delete-error">
              {deleteError}
            </p>
          )}
          {syncing && editing && <SpaceMembersSection spaceId={editing.id} spaceName={editing.name} />}
        </div>
      </Sheet>
    </div>
  );
}
