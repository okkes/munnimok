import { Link, Outlet, useRouterState } from '@tanstack/react-router';
import { useLang } from '@/i18n';
import type { TranslationKey } from '@/i18n';
import { DataProvider } from './data';
import { Icon } from '@/ui/Icon';
import { Logo } from '@/ui/Logo';

interface TabDef {
  to: string;
  labelKey: TranslationKey;
  icon: string;
  iconActive: string;
  testId: string;
}

const TABS: TabDef[] = [
  { to: '/home', labelKey: 'tab.home', icon: 'home-variant-outline', iconActive: 'home-variant', testId: 'tab-home' },
  { to: '/transactions', labelKey: 'tab.transactions', icon: 'format-list-bulleted', iconActive: 'format-list-bulleted', testId: 'tab-transactions' },
  { to: '/spaces', labelKey: 'screen.spaces', icon: 'account-group-outline', iconActive: 'account-group', testId: 'tab-spaces' },
  { to: '/settings', labelKey: 'tab.settings', icon: 'cog-outline', iconActive: 'cog', testId: 'tab-settings' },
];

export function AppLayout() {
  const { t } = useLang();
  const pathname = useRouterState({ select: (s) => s.location.pathname });

  return (
    <div className="flex h-full flex-row bg-bg text-ink">
      {/* Desktop sidebar */}
      <nav className="hidden w-60 shrink-0 flex-col border-r border-line bg-bg-2 px-4 pt-6 pb-4 md:flex">
        <div className="px-2 pb-8">
          <Logo size={26} />
        </div>
        <div className="flex flex-col gap-1">
          {TABS.map((tab) => {
            const active = pathname.startsWith(tab.to);
            return (
              <Link
                key={tab.to}
                to={tab.to}
                data-testid={`side-${tab.testId}`}
                className={`m-tap flex items-center gap-3 rounded-xl px-3 py-2.5 text-[14px] font-medium ${
                  active ? 'bg-accent-soft text-accent-deep' : 'text-ink-2 hover:bg-surface'
                }`}
              >
                <Icon name={active ? tab.iconActive : tab.icon} size={20} />
                {t(tab.labelKey)}
              </Link>
            );
          })}
        </div>
      </nav>

      {/* Content */}
      <main className="flex min-w-0 flex-1 flex-col overflow-hidden">
        <div className="min-h-0 flex-1 overflow-hidden pt-[env(safe-area-inset-top)]">
          <DataProvider>
            <Outlet />
          </DataProvider>
        </div>

        {/* Mobile bottom tab bar */}
        {/* clamp: Android 3-button navigation reports up to ~48px inset,
            iOS home indicator 34px — honor them fully; the 56px ceiling
            guards against Safari's minimized-toolbar env() inflation */}
        <nav className="flex shrink-0 items-stretch justify-around border-t border-line bg-bg pb-[clamp(0px,env(safe-area-inset-bottom),56px)] md:hidden">
          {TABS.map((tab) => {
            const active = pathname.startsWith(tab.to);
            return (
              <Link
                key={tab.to}
                to={tab.to}
                data-testid={tab.testId}
                className={`m-tap flex flex-1 flex-col items-center gap-0.5 pt-2 pb-1.5 text-[10px] font-medium ${
                  active ? 'text-brand' : 'text-ink-4'
                }`}
              >
                <Icon name={active ? tab.iconActive : tab.icon} size={23} />
                {t(tab.labelKey)}
              </Link>
            );
          })}
        </nav>
      </main>
    </div>
  );
}
