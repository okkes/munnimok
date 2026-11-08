import { useNavigate } from '@tanstack/react-router';
import { useLang } from '@/i18n';
import { useSession } from '@/app/session';
import type { SpaceRow } from '@/db/types';
import { Icon } from '@/ui/Icon';
import { NAV_FEATURES, homeShortcuts, navUsableFor, resolveNavTabs } from './navFeatures';
import type { NavFeatureId } from './navFeatures';
import { onMainNav } from './NavBars';
import { useSideNavShown } from './useNavTabs';

/**
 * #577: the features whose only door was the bar (transactions, planning,
 * portfolio) that this space took out of it — Home keeps a door to each.
 * None where the side panel lists everything.
 */
export function useHomeShortcuts(space: SpaceRow | undefined): NavFeatureId[] {
  const identity = useSession((s) => s.identity);
  const sideNav = useSideNavShown();
  if (!space || sideNav) return [];
  return homeShortcuts(resolveNavTabs(space.navTabs, navUsableFor(identity?.kind)));
}

/** Home's Shortcuts block: one tile per door, side by side */
export function NavShortcutsBlock({ ids }: Readonly<{ ids: readonly NavFeatureId[] }>) {
  const { t } = useLang();
  const navigate = useNavigate();
  return (
    <div className="mt-5" data-testid="home-shortcuts">
      <div className="m-cap mb-1 px-1">{t('home.shortcutsTitle')}</div>
      <div className="flex gap-2">
        {ids.map((id) => {
          const item = NAV_FEATURES[id];
          return (
            <button
              key={id}
              data-testid={`home-shortcut-${id}`}
              onClick={() => {
                onMainNav(item.to);
                void navigate({ to: item.to });
              }}
              className="m-tap flex min-w-0 flex-1 flex-col items-center gap-1 rounded-card border border-line bg-surface px-2 py-3"
            >
              <Icon name={item.icon} size={22} color="var(--m-accent-deep)" />
              <span className="max-w-full truncate text-[12px] font-medium text-ink">{t(item.labelKey)}</span>
            </button>
          );
        })}
      </div>
    </div>
  );
}
