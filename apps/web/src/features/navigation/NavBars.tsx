import { useLayoutEffect, useRef, useState } from 'react';
import type { CSSProperties, RefObject } from 'react';
import { Link } from '@tanstack/react-router';
import { useLang } from '@/i18n';
import { useSession } from '@/app/session';
import { Icon } from '@/ui/Icon';
import { usePlanDot } from '@/features/planning/PlanAttention';
import { clearTxFilters } from '@/features/transactions/txFilters';
import { clearOverviewPeriods } from '@/features/overview/periodMemory';
import { HOME_NAV, NAV_FEATURES, SIDE_NAV_GROUPS, labelsFit, navUsableFor } from './navFeatures';
import type { NavItem } from './navFeatures';
import { useNavTabs } from './useNavTabs';

/** a main destination was chosen: #140 the tx lens resets (unless it is the list itself), #454 the overviews forget their period */
export function onMainNav(to: string): void {
  if (to !== '/transactions') clearTxFilters();
  clearOverviewPeriods();
}

/** a nav icon, with the attention dot when the entry asks for one */
function NavFace({ item, active, size }: Readonly<{ item: NavItem; active: boolean; size: number }>) {
  const dot = usePlanDot((s) => s.dot);
  return (
    <span className="relative inline-flex">
      <Icon name={active ? item.iconActive : item.icon} size={size} />
      {item.dot && dot && <span data-testid={`tab-${item.id}-dot`} className="absolute -top-0.5 -right-1 h-2 w-2 rounded-full bg-negative" />}
    </span>
  );
}

/** room each label keeps from its slot's edges */
const LABEL_GUTTER = 4;

/**
 * Names while every one fits its slot, icons only once one does not — a
 * measurement, not a breakpoint (#577): the labels are measured in a
 * hidden copy, so icon mode can still tell when the room comes back.
 * Unmeasurable (a hidden bar, a test DOM) keeps the last answer.
 */
function useLabelsFit(key: string): { fit: boolean; navRef: RefObject<HTMLElement | null>; measureRef: RefObject<HTMLDivElement | null> } {
  const navRef = useRef<HTMLElement | null>(null);
  const measureRef = useRef<HTMLDivElement | null>(null);
  const [fit, setFit] = useState(true);
  useLayoutEffect(() => {
    const check = () => {
      const nav = navRef.current;
      const labels = measureRef.current ? [...measureRef.current.children] : [];
      if (!nav || nav.clientWidth === 0 || labels.length === 0) return;
      setFit(labelsFit(nav.clientWidth / labels.length, labels.map((el) => (el as HTMLElement).offsetWidth), LABEL_GUTTER));
    };
    check();
    const observer = typeof ResizeObserver === 'undefined' ? undefined : new ResizeObserver(check);
    if (navRef.current) observer?.observe(navRef.current);
    // the web font's metrics differ from the fallback's
    const fonts = document.fonts as FontFaceSet | undefined;
    void fonts?.ready?.then(check).catch(() => undefined);
    return () => observer?.disconnect();
  }, [key]);
  return { fit, navRef, measureRef };
}

/**
 * The phone's bottom bar (#577): Home first, then the active space's picks.
 * It lives inside the data provider — the picks are the space's.
 */
export function MobileTabBar({ pathname, hidden }: Readonly<{ pathname: string; hidden: boolean }>) {
  const { t } = useLang();
  const tabs = useNavTabs();
  const items: NavItem[] = [HOME_NAV, ...tabs.map((id) => NAV_FEATURES[id])];
  const labels = items.map((item) => t(item.labelKey));
  const { fit, navRef, measureRef } = useLabelsFit(labels.join('\n'));

  return (
    // clamp: Android 3-button navigation reports up to ~48px inset, iOS
    // home indicator 34px — honor them fully; the 56px ceiling guards
    // against Safari's minimized-toolbar env() inflation
    <nav
      ref={navRef}
      data-testid="tab-bar"
      data-labels={fit ? 'shown' : 'icons'}
      className={`relative shrink-0 items-stretch border-t border-line bg-bg pb-[clamp(0px,env(safe-area-inset-bottom),56px)] md:hidden ${hidden ? 'hidden' : 'flex'}`}
    >
      <div ref={measureRef} aria-hidden data-testid="tab-bar-measure" className="pointer-events-none invisible absolute top-0 left-0 flex h-0 w-max overflow-hidden text-[10px] font-medium whitespace-nowrap">
        {labels.map((label, i) => (
          <span key={items[i].id} className="shrink-0">
            {label}
          </span>
        ))}
      </div>
      {items.map((item, i) => {
        const active = pathname.startsWith(item.to);
        return (
          <Link
            key={item.id}
            to={item.to}
            data-testid={`tab-${item.id}`}
            aria-label={fit ? undefined : labels[i]}
            onClick={() => onMainNav(item.to)}
            className={`m-tap flex h-[54px] min-w-0 flex-1 flex-col items-center justify-center gap-0.5 text-[10px] font-medium ${
              active ? 'text-brand' : 'text-ink-4'
            }`}
          >
            <NavFace item={item} active={active} size={23} />
            {fit && <span className="max-w-full truncate px-1">{labels[i]}</span>}
          </Link>
        );
      })}
    </nav>
  );
}

function SideLink({ item, pathname }: Readonly<{ item: NavItem; pathname: string }>) {
  const { t } = useLang();
  const active = pathname.startsWith(item.to);
  return (
    <Link
      to={item.to}
      data-testid={`side-tab-${item.id}`}
      onClick={() => onMainNav(item.to)}
      // #271: hover tints in the accent language — bg-surface (white on
      // light bg-2 / gray on dark) read as stale gray blocks whenever hover
      // state lingered
      className={`m-tap flex items-center gap-3 rounded-xl px-3 py-2 text-[14px] font-medium ${
        active ? 'bg-accent-soft text-accent-deep' : 'text-ink-2 hover:bg-accent-soft/40'
      }`}
    >
      <NavFace item={item} active={active} size={20} />
      <span className="min-w-0 truncate">{t(item.labelKey)}</span>
    </Link>
  );
}

const FADE = 28;

/** scrollbars are hidden app-wide: a list that hides more above or below fades that edge, like the sideways strips */
function useEdgeFade(): { ref: RefObject<HTMLDivElement | null>; style: CSSProperties | undefined } {
  const ref = useRef<HTMLDivElement | null>(null);
  const [edges, setEdges] = useState({ top: false, bottom: false });
  useLayoutEffect(() => {
    const el = ref.current;
    if (!el) return;
    const check = () => {
      const top = el.scrollTop > 1;
      const bottom = el.scrollTop + el.clientHeight < el.scrollHeight - 1;
      setEdges((prev) => (prev.top === top && prev.bottom === bottom ? prev : { top, bottom }));
    };
    check();
    el.addEventListener('scroll', check, { passive: true });
    const observer = typeof ResizeObserver === 'undefined' ? undefined : new ResizeObserver(check);
    observer?.observe(el);
    return () => {
      el.removeEventListener('scroll', check);
      observer?.disconnect();
    };
  }, []);
  if (!edges.top && !edges.bottom) return { ref, style: undefined };
  const head = edges.top ? `transparent, black ${FADE}px` : 'black';
  const tail = edges.bottom ? `black calc(100% - ${FADE}px), transparent` : 'black';
  const mask = `linear-gradient(to bottom, ${head}, ${tail})`;
  return { ref, style: { maskImage: mask, WebkitMaskImage: mask } };
}

/**
 * The desktop and tablet side panel (#523): there is room for every
 * feature, so it lists them all — the default bar first, the rest by
 * intent — whatever a space picked for its phone bar.
 */
export function SideNav({ pathname }: Readonly<{ pathname: string }>) {
  const { t } = useLang();
  const identity = useSession((s) => s.identity);
  const usable = navUsableFor(identity?.kind);
  const fade = useEdgeFade();
  return (
    <>
      <div ref={fade.ref} style={fade.style} className="flex min-h-0 flex-1 flex-col gap-0.5 overflow-y-auto" data-testid="side-nav">
        <SideLink item={HOME_NAV} pathname={pathname} />
        {SIDE_NAV_GROUPS.map((group) => {
          const ids = group.ids.filter(usable);
          if (ids.length === 0) return null;
          return (
            <div key={group.capKey ?? 'main'} className="flex flex-col gap-0.5">
              {group.capKey && <p className="px-3 pt-4 pb-1 text-[10px] font-semibold tracking-wide text-ink-4 uppercase">{t(group.capKey)}</p>}
              {ids.map((id) => (
                <SideLink key={id} item={NAV_FEATURES[id]} pathname={pathname} />
              ))}
            </div>
          );
        })}
      </div>
      <div className="shrink-0 border-t border-line pt-2">
        <SideLink item={NAV_FEATURES.settings} pathname={pathname} />
      </div>
    </>
  );
}
