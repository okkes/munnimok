import { useParams, useRouter } from '@tanstack/react-router';
import { useLang } from '@/i18n';
import { useData } from '@/app/data';
import { useSession } from '@/app/session';
import { useQuery } from '@/db/useQuery';
import { useMyRole } from '@/features/spaces/SpaceSharing';
import { ReadOnlyNote } from '@/features/spaces/ReadOnlyNote';
import { HelpButton } from '@/features/help/HelpButton';
import { BlockListEditor } from '@/features/customize/BlockListEditor';
import { AppBar, IconButton } from '@/ui/AppBar';
import { Button } from '@/ui/Button';
import { Icon } from '@/ui/Icon';
import { HOME_NAV, MAX_NAV_ITEMS, MAX_NAV_PICKS, NAV_FEATURE_IDS, NAV_FEATURES, navUsableFor, resolveNavTabs } from './navFeatures';
import { useNavOps } from './useNavTabs';

/**
 * The space's phone bar (#577): Home always first, up to seven picks after
 * it, in the order they are dragged to. Every change applies at once (LWW
 * on the space row) — the bar below is the preview. Readers look only.
 */
export function NavigationSettingsScreen() {
  const { t } = useLang();
  const { store } = useData();
  const identity = useSession((s) => s.identity);
  const { spaceId } = useParams({ strict: false }) as { spaceId: string };
  const router = useRouter();

  const space = useQuery(store, async () => store.get('space', spaceId), [spaceId]);
  const readOnly = useMyRole(spaceId, identity?.kind === 'user') === 'reader';
  const ops = useNavOps(spaceId, readOnly);
  const usable = navUsableFor(identity?.kind);
  const picks = resolveNavTabs(space?.navTabs, usable);
  const others = NAV_FEATURE_IDS.filter((id) => usable(id) && !picks.includes(id));
  const full = picks.length >= MAX_NAV_PICKS;

  return (
    <div className="m-fade flex h-full flex-col" data-testid="screen-nav-settings">
      <AppBar
        title={t('nav.title')}
        leading={
          <IconButton label={t('action.back')} testId="nav-settings-back" onClick={() => router.history.back()}>
            <Icon name="chevron-left" size={24} />
          </IconButton>
        }
        trailing={<HelpButton tourId="navigation" />}
      />
      <div className="min-h-0 flex-1 overflow-y-auto px-5 pb-8">
        {/* nothing to press before the row loads — a fast tap must never edit the defaults of an unloaded row */}
        {space && (
          <div className="flex flex-col pt-1">
            <p className="px-1 pb-3 text-[12px] leading-relaxed text-ink-3">{t('nav.sub', { max: MAX_NAV_PICKS })}</p>
            <ReadOnlyNote spaceId={spaceId} className="mb-3" testId="nav-reader-note" />
            <div className={readOnly ? 'pointer-events-none opacity-60' : ''}>
              <div className="m-cap mb-1 flex items-baseline justify-between px-1">
                <span>{t('nav.inBar')}</span>
                <span className="normal-case" data-testid="nav-count">
                  {t('nav.count', { n: picks.length + 1, max: MAX_NAV_ITEMS })}
                </span>
              </div>
              <div className="rounded-card border border-line bg-surface px-4" data-testid="nav-edit-bar">
                <div className="flex items-center gap-2.5 border-b border-line-2 py-2 last:border-0" data-testid="nav-row-home">
                  <Icon name={HOME_NAV.iconActive} size={19} color="var(--m-accent-deep)" />
                  <span className="min-w-0 flex-1 truncate text-[14px] text-ink">{t(HOME_NAV.labelKey)}</span>
                  <span className="shrink-0 text-[11px] text-ink-4">{t('nav.homeFixed')}</span>
                  <span className="flex h-9 w-9 shrink-0 items-center justify-center">
                    <Icon name="lock-outline" size={16} color="var(--m-ink-4)" />
                  </span>
                </div>
                <BlockListEditor
                  rows={picks.map((id) => ({ id, label: t(NAV_FEATURES[id].labelKey), icon: NAV_FEATURES[id].icon, hidden: false }))}
                  testPrefix="nav-tab"
                  onToggle={(index) => void ops.remove(picks[index])}
                  onReorder={(from, to) => void ops.move(picks[from], to)}
                />
              </div>

              <div className="m-cap mt-5 mb-1 px-1">{t('nav.more')}</div>
              {full && (
                <p className="px-1 pb-1.5 text-[12px] text-warning" data-testid="nav-full">
                  {t('nav.full')}
                </p>
              )}
              {others.length > 0 && (
                <div className="rounded-card border border-line bg-surface px-4" data-testid="nav-edit-more">
                  {others.map((id) => (
                    <div key={id} className="flex items-center gap-2.5 border-b border-line-2 py-2 last:border-0" data-testid={`nav-more-row-${id}`}>
                      <Icon name={NAV_FEATURES[id].icon} size={19} color="var(--m-ink-4)" />
                      <span className="min-w-0 flex-1 truncate text-[14px] text-ink-4">{t(NAV_FEATURES[id].labelKey)}</span>
                      <button
                        aria-label={t('nav.add')}
                        data-testid={`nav-add-${id}`}
                        disabled={full}
                        onClick={() => void ops.add(id)}
                        className="m-tap flex h-9 w-9 shrink-0 items-center justify-center rounded-full border-none bg-transparent disabled:opacity-40"
                      >
                        <Icon name="eye-off-outline" size={18} color="var(--m-ink-4)" />
                      </button>
                    </div>
                  ))}
                </div>
              )}
              {/* the space menu always keeps a Settings door, so the bar may drop it */}
              {!picks.includes('settings') && (
                <p className="px-1 pt-2 text-[12px] text-ink-3" data-testid="nav-settings-note">
                  {t('nav.settingsNote')}
                </p>
              )}
              {space.navTabs != null && (
                <Button variant="outline" size="sm" className="mt-5 w-full" data-testid="nav-reset" onClick={() => void ops.reset()}>
                  {t('nav.reset')}
                </Button>
              )}
            </div>
          </div>
        )}
      </div>
    </div>
  );
}
