import { useEffect, useRef } from 'react';
import type { RefObject } from 'react';
import { useLang } from '@/i18n';
import { Icon } from './Icon';

/** how many rows a long list mounts per step (#492) */
export const PAGE_ROWS = 120;

/**
 * The end of a long list while older rows wait (#492): the next page
 * arrives as the end nears the viewport of `rootRef`, and the button
 * serves keyboards and browsers without IntersectionObserver.
 */
export function MoreRows({
  rootRef,
  remaining,
  onMore,
  testId = 'list-more',
}: Readonly<{ rootRef: RefObject<HTMLElement | null>; remaining: number; onMore: () => void; testId?: string }>) {
  const { t } = useLang();
  const ref = useRef<HTMLButtonElement>(null);
  useEffect(() => {
    const el = ref.current;
    if (!el || typeof IntersectionObserver === 'undefined') return;
    // a fresh observer per page reports at once whether the end is still near
    const observer = new IntersectionObserver(
      (entries) => {
        if (entries.some((e) => e.isIntersecting)) onMore();
      },
      { root: rootRef.current, rootMargin: '0px 0px 600px 0px' },
    );
    observer.observe(el);
    return () => observer.disconnect();
  }, [rootRef, onMore, remaining]);
  return (
    <button
      ref={ref}
      data-testid={testId}
      onClick={onMore}
      className="m-tap mt-4 flex w-full items-center justify-center gap-1.5 rounded-card border border-line bg-surface py-3 text-[13px] font-medium text-ink-3"
    >
      <Icon name="chevron-down" size={16} />
      {t('tx.showOlder', { n: remaining })}
    </button>
  );
}
