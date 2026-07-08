import { useState } from 'react';
import { useLiveQuery } from 'dexie-react-hooks';
import { useNavigate } from '@tanstack/react-router';
import { useLang } from '@/i18n';
import { useData } from '@/app/data';
import { useSession } from '@/app/session';
import { SpaceInvitesBanner } from './SpaceSharing';
import { AppBar, IconButton } from '@/ui/AppBar';
import { Button } from '@/ui/Button';
import { Icon } from '@/ui/Icon';
import { Sheet } from '@/ui/Sheet';

/**
 * Spaces: separate bookkeeping areas, shared with other people or not.
 * The cog opens the space's settings SCREEN (/spaces/$spaceId); only
 * space creation stays a sheet (one decision).
 */
export function SpacesScreen() {
  const { t } = useLang();
  const { db, repo, spaceId, setActiveSpace } = useData();
  const identity = useSession((s) => s.identity);
  const navigate = useNavigate();
  const syncing = identity?.kind === 'user';
  const [createOpen, setCreateOpen] = useState(false);
  const [name, setName] = useState('');

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

  return (
    <div className="m-fade flex h-full flex-col" data-testid="screen-spaces">
      <AppBar
        large
        title={t('screen.spaces')}
        trailing={
          <IconButton
            label={t('space.new')}
            testId="spaces-add"
            onClick={() => {
              setName('');
              setCreateOpen(true);
            }}
          >
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
                      className="flex h-10 w-10 shrink-0 items-center justify-center rounded-full"
                      style={{
                        background: active ? (space.color ?? 'var(--m-accent)') + '22' : 'var(--m-bg-2)',
                        color: space.color ?? (active ? 'var(--m-accent-deep)' : 'var(--m-ink-3)'),
                      }}
                    >
                      <Icon name={space.icon ?? (space.kind === 'shared' ? 'account-group-outline' : 'leaf')} size={20} />
                    </span>
                    <span className="min-w-0 flex-1">
                      <span className="block truncate text-[15px] font-medium text-ink">{space.name}</span>
                      {active && <span className="block text-xs text-accent-deep">{t('space.active')}</span>}
                    </span>
                    {active && <Icon name="check" size={18} color="var(--m-accent)" />}
                  </button>
                  <button
                    aria-label={t('space.settings')}
                    data-testid={`space-edit-${space.id}`}
                    onClick={() => void navigate({ to: '/spaces/$spaceId', params: { spaceId: space.id } })}
                    className="m-tap flex h-9 w-9 shrink-0 items-center justify-center border-none bg-transparent text-ink-4"
                  >
                    <Icon name="cog-outline" size={18} />
                  </button>
                </div>
              </div>
            );
          })}
        </div>
      </div>

      {/* Create space */}
      <Sheet open={createOpen} onOpenChange={setCreateOpen} title={t('space.new')} size="compact">
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
    </div>
  );
}
