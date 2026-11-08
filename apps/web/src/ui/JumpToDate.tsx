import { useEffect, useRef, useState } from 'react';
import type { RefObject } from 'react';
import { LOCALES, useLang } from '@/i18n';
import { nearestDateIndex } from '@/domain/dateJump';
import { Icon } from './Icon';

/** #502: the picker's door to the day of the transaction being linked */
export function JumpToDateButton({ date, onJump, testId }: Readonly<{ date: string; onJump: () => void; testId: string }>) {
  const { t, lang } = useLang();
  const day = new Date(date).toLocaleDateString(LOCALES[lang], { day: 'numeric', month: 'short' });
  return (
    <button
      type="button"
      data-testid={testId}
      onClick={onJump}
      className="m-tap ml-auto flex shrink-0 items-center gap-1 border-none bg-transparent p-0 text-[11px] font-semibold text-accent-deep normal-case"
    >
      <Icon name="calendar-arrow-right" size={13} />
      {t('tx.jumpToDate', { date: day })}
    </button>
  );
}

/**
 * #502 (user): a long picker scrolls to the row nearest to a day, so the
 * person scrolls up or down from there. Rows carry `data-jump-id`; the
 * landed row is named by `jumpedId` for a moment so the eye finds it.
 * `ensureShown` widens a paged list until the row is mounted.
 */
export function useJumpToDate(
  rows: readonly { id: string; date: string }[],
  ensureShown?: (index: number) => void,
): {
  scrollerRef: RefObject<HTMLDivElement | null>;
  jump: (day: string) => void;
  jumpedId: string | null;
} {
  const scrollerRef = useRef<HTMLDivElement>(null);
  const [jumpedId, setJumpedId] = useState<string | null>(null);
  const pending = useRef<string | null>(null);
  const jump = (day: string) => {
    const index = nearestDateIndex(rows, day);
    if (index < 0) return;
    ensureShown?.(index);
    pending.current = rows[index].id;
    setJumpedId(rows[index].id);
  };
  // after the render that mounts it: centre the row inside the scroller only
  useEffect(() => {
    const id = pending.current;
    const scroller = scrollerRef.current;
    if (!id || !scroller) return;
    const row = scroller.querySelector<HTMLElement>(`[data-jump-id="${id}"]`);
    if (!row) return;
    pending.current = null;
    const offset = row.getBoundingClientRect().top - scroller.getBoundingClientRect().top;
    scroller.scrollTop += offset - scroller.clientHeight / 2 + row.clientHeight / 2;
  });
  useEffect(() => {
    if (!jumpedId) return;
    const timer = setTimeout(() => setJumpedId(null), 1600);
    return () => clearTimeout(timer);
  }, [jumpedId]);
  return { scrollerRef, jump, jumpedId };
}
