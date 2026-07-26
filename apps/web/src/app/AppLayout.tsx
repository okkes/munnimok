import { useEffect, useState } from 'react';
import { Link, Outlet, useRouterState } from '@tanstack/react-router';
import { DisplayMoneyProvider } from '@/features/currency/useDisplayMoney';
import { useLang } from '@/i18n';
import type { TranslationKey } from '@/i18n';
import { DataProvider, useData } from './data';
import { OfflineBanner } from './OfflineBanner';
import { useSession } from './session';
import { HelpProvider } from '@/features/help/HelpContext';
import { useRecurringReminders } from '@/application/recurring';
import { useStoreKeepAlive } from '@/application/stores';
import { collectBudgetAlerts } from '@/sync/swBudgets';
import { hapticNotify } from '@/lib/platform';
import { EdgeSwipeBack } from '@/ui/EdgeSwipeBack';
import { MinaTutorial } from '@/features/mina/MinaTutorial';
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
  { to: '/recurring', labelKey: 'tab.recurring', icon: 'autorenew', iconActive: 'autorenew', testId: 'tab-recurring' },
  // portfolio left the Home landing zone for its own tab (user ruling)
  { to: '/portfolio', labelKey: 'tab.portfolio', icon: 'chart-timeline-variant', iconActive: 'chart-timeline-variant', testId: 'tab-portfolio' },
  { to: '/settings', labelKey: 'tab.settings', icon: 'cog-outline', iconActive: 'cog', testId: 'tab-settings' },
];

const isEditable = (el: EventTarget | null): el is HTMLElement =>
  el instanceof HTMLElement && (el.tagName === 'INPUT' || el.tagName === 'TEXTAREA' || el.isContentEditable);

/**
 * On-screen keyboard awareness (user report 2026-07-24): the viewport
 * RESIZES for the keyboard on Android + the native shells, which pushed
 * the tab bar right on top of it — hide the bar while an editable has
 * focus. The focused field also scrolls itself into view once the
 * resized layout has settled (fields near the bottom stayed hidden).
 */
/** two passes: the iOS native-resize webview settles LATER than 300ms,
 *  so a single early scroll measured a stale viewport and fields near
 *  the bottom stayed under the keyboard (user ss). The second pass
 *  re-centers once the resize has genuinely landed. */
function scheduleKeyboardScrolls(el: HTMLElement): ReturnType<typeof setTimeout>[] {
  const center = () => {
    if (document.activeElement === el) el.scrollIntoView({ block: 'center', behavior: 'smooth' });
  };
  return [300, 750].map((ms) => setTimeout(center, ms));
}

function useKeyboardOpen(): boolean {
  const [open, setOpen] = useState(false);
  useEffect(() => {
    let scrollTimers: ReturnType<typeof setTimeout>[] = [];
    const onFocusIn = (e: FocusEvent) => {
      if (!isEditable(e.target)) return;
      setOpen(true);
      scrollTimers.forEach(clearTimeout);
      scrollTimers = scheduleKeyboardScrolls(e.target);
    };
    const onFocusOut = () => {
      // focus often hops field-to-field — only a settled blur closes
      setTimeout(() => {
        if (!isEditable(document.activeElement)) setOpen(false);
      }, 100);
    };
    window.addEventListener('focusin', onFocusIn);
    window.addEventListener('focusout', onFocusOut);
    return () => {
      scrollTimers.forEach(clearTimeout);
      window.removeEventListener('focusin', onFocusIn);
      window.removeEventListener('focusout', onFocusOut);
    };
  }, []);
  return open;
}

/** headless: fires due-soon reminders once per app open (needs DataProvider) */
function RecurringReminders() {
  useRecurringReminders();
  return null;
}

/** headless: store-connection keep-alive + receipt pull (signed-in only) */
function StoreKeepAlive() {
  useStoreKeepAlive();
  return null;
}

/** headless: manually typed spending crosses a budget threshold while
 *  the app is open — same once-per-period markers as the worker path,
 *  so the two can never double-fire (budgets design P4) */
function BudgetAlerts() {
  const { store, spaceId } = useData();
  const { lang } = useLang();
  useEffect(() => {
    void (async () => {
      if (typeof Notification === 'undefined' || Notification.permission !== 'granted') return;
      const registration = await navigator.serviceWorker?.ready.catch(() => undefined);
      if (!registration) return;
      for (const alert of await collectBudgetAlerts(store, spaceId, lang)) {
        hapticNotify('WARNING'); // §5: over-budget deserves a physical nudge
        await registration.showNotification(alert.title, {
          body: alert.body,
          icon: 'icon-192.png',
          badge: 'icon-192.png',
          tag: alert.tag,
          data: { url: alert.url },
        });
      }
    })().catch(() => undefined); // best-effort; a closing db must not throw
  }, [spaceId, lang]);
  return null;
}

/** unmistakable "this is the demo" marker (user request): a pill next to
 *  the desktop brand, and a slim strip above the mobile tab bar */
function DemoBadge() {
  const identity = useSession((s) => s.identity);
  if (identity?.kind !== 'demo') return null;
  return (
    <span
      data-testid="demo-badge"
      className="rounded-md bg-warning-soft px-1.5 py-0.5 font-mono text-[10px] font-bold tracking-wider text-ink-2 uppercase"
    >
      DEMO
    </span>
  );
}

function DemoBanner() {
  const { t } = useLang();
  const identity = useSession((s) => s.identity);
  if (identity?.kind !== 'demo') return null;
  return (
    <div
      data-testid="demo-banner"
      className="flex shrink-0 items-center justify-center gap-2 border-t border-line bg-warning-soft px-4 py-1.5 md:hidden"
    >
      <Icon name="test-tube" size={13} color="var(--m-warning)" />
      <span className="text-[11px] font-medium text-ink-2">{t('demo.banner')}</span>
    </div>
  );
}

export function AppLayout() {
  const { t } = useLang();
  const pathname = useRouterState({ select: (s) => s.location.pathname });
  // onboarding is a focused flow — no navigation chrome (user request)
  const hideNav = pathname.startsWith('/onboarding');
  // the mobile tab bar makes no sense floating on top of the keyboard
  const keyboardOpen = useKeyboardOpen();

  return (
    <div className="flex h-full flex-row bg-bg text-ink">
      {/* Desktop sidebar */}
      <nav className={`w-60 shrink-0 flex-col border-r border-line bg-bg-2 px-4 pt-6 pb-4 ${hideNav ? 'hidden' : 'hidden md:flex'}`}>
        <div className="flex items-center gap-2 px-2 pb-8">
          <Logo size={26} />
          <DemoBadge />
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
        <div className="flex min-h-0 flex-1 flex-col overflow-hidden pt-[env(safe-area-inset-top)]">
          <DataProvider>
            {/* one shared display-currency lens for every screen and row —
                per-row hooks melted sync-time performance (useDisplayMoney) */}
            <DisplayMoneyProvider>
            <HelpProvider>
              {/* desktop content ceiling (redesign §4.1): the single column
                  stops feeling lost past ~1080px; gutters stay the screens' */}
              <div className="min-h-0 w-full flex-1 overflow-hidden md:mx-auto md:max-w-[1080px]">
                <Outlet />
              </div>
            </HelpProvider>
            <DemoBanner />
            <OfflineBanner />
            <RecurringReminders />
            <StoreKeepAlive />
            <BudgetAlerts />
            <EdgeSwipeBack />
            <MinaTutorial />
            </DisplayMoneyProvider>
          </DataProvider>
        </div>

        {/* Mobile bottom tab bar */}
        {/* clamp: Android 3-button navigation reports up to ~48px inset,
            iOS home indicator 34px — honor them fully; the 56px ceiling
            guards against Safari's minimized-toolbar env() inflation */}
        <nav className={`shrink-0 items-stretch justify-around border-t border-line bg-bg pb-[clamp(0px,env(safe-area-inset-bottom),56px)] md:hidden ${hideNav || keyboardOpen ? 'hidden' : 'flex'}`}>
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
