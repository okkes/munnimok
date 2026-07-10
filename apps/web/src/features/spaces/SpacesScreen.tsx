import { useState } from 'react';
import { useLiveQuery } from 'dexie-react-hooks';
import { useNavigate } from '@tanstack/react-router';
import { useLang } from '@/i18n';
import { useData } from '@/app/data';
import { useSession } from '@/app/session';
import { SpaceInvitesBanner } from './SpaceSharing';
import { HelpButton } from '@/features/help/HelpButton';
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
        title={t('screen.spaces')}
        leading={
          <IconButton label={t('action.back')} testId="spaces-back" onClick={() => window.history.back()}>
            <Icon name="arrow-left" size={22} />
          </IconButton>
        }
        trailing={
          <>
            <HelpButton tourId="spaces" />
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
          </>
        }
      />
      <div className="min-h-0 flex-1 overflow-y-auto px-5 pb-6">
        {syncing && <SpaceInvitesBanner />}
        <p className="m-cap mt-1 mb-1 px-1">{t('space.listCaption')}</p>
        <div className="overflow-hidden rounded-card border border-line bg-surface">
          {(spaces ?? []).map((space, i) => {
            const active = space.id === spaceId;
            return (
              <div key={space.id}>
                {i > 0 && <div className="mx-4 h-px bg-line-2" />}
                <div className={`flex items-center ${active ? 'bg-accent-soft/30' : ''}`}>
                  <button
                    data-testid={`space-row-${space.id}`}
                    onClick={() => void setActiveSpace(space.id)}
                    className="m-tap flex min-w-0 flex-1 items-center gap-3 border-none bg-transparent px-4 py-3.5 text-left"
                  >
                    {space.picture ? (
                      <img src={space.picture} alt="" className="h-10 w-10 shrink-0 rounded-full object-cover" />
                    ) : (
                      <span
                        className="flex h-10 w-10 shrink-0 items-center justify-center rounded-full"
                        style={{
                          background: `color-mix(in srgb, ${space.color ?? 'var(--m-accent)'} 16%, transparent)`,
                          color: space.color ?? (active ? 'var(--m-accent-deep)' : 'var(--m-ink-3)'),
                        }}
                      >
                        <Icon name={space.icon ?? (space.kind === 'shared' ? 'account-group-outline' : 'leaf')} size={20} />
                      </span>
                    )}
                    <span className="min-w-0 flex-1">
                      <span className="block truncate text-[15px] font-medium text-ink">{space.name}</span>
                      <span className="block truncate text-xs text-ink-4">
                        {t(space.kind === 'shared' ? 'space.kindShared' : 'space.kindPersonal')}
                        {active && (
                          <>
                            {' · '}
                            <span className="text-accent-deep">{t('space.active')}</span>
                          </>
                        )}
                      </span>
                    </span>
                    {active && <Icon name="check-circle" size={19} color="var(--m-accent)" />}
                  </button>
                  <button
                    aria-label={t('space.settings')}
                    data-testid={`space-edit-${space.id}`}
                    onClick={() => void navigate({ to: '/spaces/$spaceId', params: { spaceId: space.id } })}
                    className="m-tap flex h-11 w-11 shrink-0 items-center justify-center border-none bg-transparent text-ink-4"
                  >
                    <Icon name="cog-outline" size={19} />
                  </button>
                </div>
              </div>
            );
          })}
        </div>
        <p className="mt-2 px-1 text-[11px] leading-snug text-ink-4">{t('space.listHint')}</p>
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
