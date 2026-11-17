import { useEffect, useState } from 'react';
import { Outlet, useRouterState } from '@tanstack/react-router';
import { DisplayMoneyProvider } from '@/features/currency/useDisplayMoney';
import { useLang } from '@/i18n';
import { DataProvider, useData } from './data';
import { OfflineBanner } from './OfflineBanner';
import { useSession } from './session';
import { HelpProvider } from '@/features/help/HelpContext';
import { useRecurringReminders } from '@/application/recurring';
import { useConnectionKeepAlive } from '@/application/connections';
import { useReviewSuggestionTriggers } from '@/application/reviewSuggestions';
import { collectBudgetAlerts } from '@/sync/swBudgets';
import { osNotifyAllowed } from '@/application/spaceNotifications';
import { NotificationSpaceSwitch } from './notificationSpace';
import { hapticNotify } from '@/lib/platform';
import { EdgeSwipeBack } from '@/ui/EdgeSwipeBack';
import { padScrollportForKeyboard, restoreScrollportPad, revealInScroller } from '@/lib/viewport';
import { wheelToHorizontal } from '@/lib/wheelScroll';
import { SHEET_OWNS_KEYBOARD, Sheet } from '@/ui/Sheet';
import { Button } from '@/ui/Button';
import { useEvicted } from './evicted';
import { UnsavedNotice } from './UnsavedNotice';
import { MinaTutorial } from '@/features/mina/MinaTutorial';
import { Icon } from '@/ui/Icon';
import { Logo } from '@/ui/Logo';
import { PlanAttention } from '@/features/planning/PlanAttention';
import { MobileTabBar, SideNav } from '@/features/navigation/NavBars';

/** input types that summon no on-screen keyboard: focusing one must not hide the tab bar (#162) */
const KEYBOARDLESS_INPUTS = new Set(['checkbox', 'radio', 'range', 'button', 'submit', 'reset', 'file', 'color']);

const isEditable = (el: EventTarget | null): el is HTMLElement =>
  el instanceof HTMLElement &&
  ((el.tagName === 'INPUT' && !KEYBOARDLESS_INPUTS.has((el as HTMLInputElement).type)) ||
    el.tagName === 'TEXTAREA' ||
    el.isContentEditable);


// the viewport resizes for the keyboard on Android + native shells: the tab bar hides while an editable has focus
/** one scroll once the visualViewport has settled: fixed-delay passes re-corrected mid-tap and moved fields under fingers */
function scheduleKeyboardReveal(el: HTMLElement): () => void {
  const vv = window.visualViewport;
  let cancelled = false;
  let done = false;
  const fire = () => {
    if (cancelled || done) return;
    done = true;
    if (document.activeElement === el) {
      padScrollportForKeyboard(el); // creates the slack the reveal needs
      revealInScroller(el);
    }
  };
  if (!vv) {
    const timer = setTimeout(fire, 300);
    return () => {
      cancelled = true;
      clearTimeout(timer);
    };
  }
  let last = vv.height;
  let quiet = 0;
  const interval = setInterval(() => {
    if (vv.height === last) {
      quiet += 1;
      if (quiet >= 2) {
        clearInterval(interval);
        fire(); // ~120ms of stillness — the resize (if any) has landed
      }
    } else {
      quiet = 0;
      last = vv.height;
    }
  }, 60);
  const cap = setTimeout(() => {
    clearInterval(interval);
    fire();
  }, 900);
  return () => {
    cancelled = true;
    clearInterval(interval);
    clearTimeout(cap);
  };
}

function useKeyboardOpen(): boolean {
  const [open, setOpen] = useState(false);
  useEffect(() => {
    let cancelReveal: (() => void) | null = null;
    // #312: a keyboard closing mid-scroll relaid out under the finger; while a touch is down the close waits for lift-off
    let touchDown = false;
    let pendingClose = false;
    const settleClose = () => {
      pendingClose = false;
      if (!isEditable(document.activeElement)) {
        setOpen(false);
        restoreScrollportPad();
      }
    };
    const onTouchStart = () => {
      touchDown = true;
    };
    const onTouchEnd = () => {
      touchDown = false;
      // a beat after lift-off — the momentum handoff stays smooth
      if (pendingClose) setTimeout(settleClose, 60);
    };
    const onFocusIn = (e: FocusEvent) => {
      if (!isEditable(e.target)) return;
      pendingClose = false;
      setOpen(true);
      cancelReveal?.();
      // where the sheet library owns the keyboard (non-iOS, non-resizing viewports) a second reveal fought it;
      // on iOS it stands down (#134)
      if (SHEET_OWNS_KEYBOARD && e.target.closest('.react-modal-sheet-container')) return;
      cancelReveal = scheduleKeyboardReveal(e.target);
    };
    const onFocusOut = () => {
      // focus often hops field-to-field — only a settled blur closes
      setTimeout(() => {
        if (isEditable(document.activeElement)) return;
        if (touchDown) {
          pendingClose = true; // the scroll owns the screen right now
          return;
        }
        settleClose();
      }, 100);
    };
    window.addEventListener('touchstart', onTouchStart, { passive: true });
    window.addEventListener('touchend', onTouchEnd, { passive: true });
    window.addEventListener('touchcancel', onTouchEnd, { passive: true });
    window.addEventListener('focusin', onFocusIn);
    window.addEventListener('focusout', onFocusOut);
    return () => {
      cancelReveal?.();
      window.removeEventListener('touchstart', onTouchStart);
      window.removeEventListener('touchend', onTouchEnd);
      window.removeEventListener('touchcancel', onTouchEnd);
      window.removeEventListener('focusin', onFocusIn);
      window.removeEventListener('focusout', onFocusOut);
    };
  }, []);
  return open;
}

/** #153: wheel-only mice reach sideways strips */
function useWheelToHorizontal(): void {
  useEffect(() => {
    document.addEventListener('wheel', wheelToHorizontal, { passive: false });
    return () => document.removeEventListener('wheel', wheelToHorizontal);
  }, []);
}

function RecurringReminders() {
  useRecurringReminders();
  return null;
}

function StoreKeepAlive() {
  useConnectionKeepAlive();
  return null;
}

/** headless (#565): the review's suggestions are prepared as rows land — every identity */
function ReviewSuggestionsPrep() {
  useReviewSuggestionTriggers();
  return null;
}

/** headless: shares the worker path's once-per-period markers, so the two never double-fire */
function BudgetAlerts() {
  const { store, spaceId } = useData();
  const { lang } = useLang();
  useEffect(() => {
    void (async () => {
      // #549: only where this space's notifications are on
      if (!(await osNotifyAllowed(store, spaceId))) return;
      const registration = await navigator.serviceWorker?.ready.catch(() => undefined);
      if (!registration) return;
      for (const alert of await collectBudgetAlerts(store, spaceId, lang)) {
        hapticNotify('WARNING');
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

/** #173: the takeover sheet says what happened and where the app landed; not-active evictions get the phone push only */
function EvictedNotice() {
  const { t } = useLang();
  const evicted = useEvicted((s) => s.evicted);
  const clear = useEvicted((s) => s.clear);
  return (
    <Sheet open={evicted !== null} onOpenChange={(next) => !next && clear()} title={t(evicted?.deleted ? 'space.goneTitle' : 'space.kickedTitle')} size="compact">
      {evicted && (
        <div className="flex flex-col gap-3 pt-1" data-testid="space-kicked-sheet">
          <p className="text-[14px] leading-relaxed text-ink-2">
            {t(evicted.deleted ? 'space.goneBody' : 'space.kickedBody', { space: evicted.spaceName })}
            {evicted.switchedToName ? ` ${t('space.kickedSwitched', { to: evicted.switchedToName })}` : ''}
          </p>
          <Button data-testid="space-kicked-ok" onClick={clear}>
            {t('action.done')}
          </Button>
        </div>
      )}
    </Sheet>
  );
}

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
  const pathname = useRouterState({ select: (s) => s.location.pathname });
  // onboarding is a focused flow — no navigation chrome (user request)
  const hideNav = pathname.startsWith('/onboarding');
  const keyboardOpen = useKeyboardOpen();
  useWheelToHorizontal(); // #153: wheel-only mice reach sideways strips

  return (
    // #409: on a wide monitor the shell is one centred frame, navigation beside the content
    <div className="flex h-full flex-row justify-center bg-bg-2 text-ink">
      {/* data-app-frame: #558 the tour's step card spans this frame, not the window */}
      <div data-app-frame className="flex h-full w-full flex-row bg-bg md:max-w-[1400px] md:border-x md:border-line">
      <nav className={`w-60 shrink-0 flex-col border-r border-line bg-bg-2 px-4 pt-6 pb-4 ${hideNav ? 'hidden' : 'hidden md:flex'}`}>
        <div className="flex items-center gap-2 px-2 pb-8">
          <Logo size={26} />
          <DemoBadge />
        </div>
        <SideNav pathname={pathname} />
      </nav>

      <main className="flex min-w-0 flex-1 flex-col overflow-hidden">
        <div className="flex min-h-0 flex-1 flex-col overflow-hidden pt-[env(safe-area-inset-top)]">
          <DataProvider>
            {/* one shared display-currency lens: per-row hooks melted sync-time performance (useDisplayMoney) */}
            <DisplayMoneyProvider>
            <HelpProvider>
              {/* desktop content ceiling (redesign §4.1): a single column feels lost past ~1080px */}
              <div className="min-h-0 w-full flex-1 overflow-hidden md:mx-auto md:max-w-[1080px]">
                <Outlet />
              </div>
            </HelpProvider>
            <DemoBanner />
            <OfflineBanner />
            {/* #577: inside the provider — the bar is the active space's */}
            <MobileTabBar pathname={pathname} hidden={hideNav || keyboardOpen} />
            <EvictedNotice />
            <UnsavedNotice />
            <RecurringReminders />
            <StoreKeepAlive />
            <ReviewSuggestionsPrep />
            <BudgetAlerts />
            <PlanAttention />
            <NotificationSpaceSwitch />
            <EdgeSwipeBack />
            <MinaTutorial />
            </DisplayMoneyProvider>
          </DataProvider>
        </div>
      </main>
      </div>
    </div>
  );
}
