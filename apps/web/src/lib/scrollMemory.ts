import { useLayoutEffect } from 'react';
import type { RefObject } from 'react';

// list screens scroll an INNER container and unmount on navigation (#131): the position is kept per list in sessionStorage;
// restore retries across frames: rows arrive from live queries after first paint,
// and a scrollTop set before the content exists clamps to 0

const KEY_PREFIX = 'munni_scroll_';
/** frames to wait for the content to grow past the stored offset */
const RESTORE_ATTEMPTS = 20;

const active = new Map<string, () => void>();

export function attachScrollMemory(el: HTMLElement | null, id: string): void {
  active.get(id)?.();
  active.delete(id);
  if (!el) return;

  const storageKey = KEY_PREFIX + id;
  const stored = Number(sessionStorage.getItem(storageKey) ?? '0');
  let target: number | null = Number.isFinite(stored) && stored > 0 ? stored : null;

  let raf = 0;
  let attempts = 0;
  const tryRestore = () => {
    if (target === null) return;
    el.scrollTop = target;
    attempts += 1;
    if (Math.abs(el.scrollTop - target) <= 1 || attempts >= RESTORE_ATTEMPTS) {
      target = null;
      return;
    }
    raf = requestAnimationFrame(tryRestore);
  };
  raf = requestAnimationFrame(tryRestore);

  const onScroll = () => {
    // the restore's own scroll events must not overwrite the memory
    if (target === null) sessionStorage.setItem(storageKey, String(Math.round(el.scrollTop)));
  };
  el.addEventListener('scroll', onScroll, { passive: true });
  active.set(id, () => {
    cancelAnimationFrame(raf);
    el.removeEventListener('scroll', onScroll);
  });
}

export function useScrollMemory(ref: RefObject<HTMLElement | null>, id: string): void {
  useLayoutEffect(() => {
    attachScrollMemory(ref.current, id);
    return () => attachScrollMemory(null, id);
    // the id is stable per screen; the element lives for the screen's life
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [id]);
}
