import { useRef, useState } from 'react';
import type { CSSProperties, PointerEvent as ReactPointerEvent } from 'react';

/**
 * Pointer-driven row reorder for the customize sheets, v2 (user: "the
 * ghost popup thing and animation too"): the pressed row turns faint, a
 * floating GHOST follows the finger, and the other rows slide out of
 * the way with a transform transition. The move commits ONCE on
 * release. Rows register their elements; the hovered index derives
 * from row midpoints.
 */
interface DragState {
  from: number;
  over: number;
  /** pointer Y in viewport coords — drives the ghost */
  y: number;
  height: number;
  left: number;
  width: number;
}

export interface DragReorder {
  drag: { from: number; over: number } | null;
  /** viewport rect for the floating clone of the dragged row */
  ghost: { top: number; left: number; width: number; height: number } | null;
  setRowRef: (index: number) => (el: HTMLElement | null) => void;
  /** slide/fade styling for row `index` while a drag is live */
  rowStyle: (index: number) => CSSProperties;
  /** spread onto the drag handle of row `index` */
  handleProps: (index: number) => {
    onPointerDown: (e: ReactPointerEvent<HTMLElement>) => void;
    onPointerMove: (e: ReactPointerEvent<HTMLElement>) => void;
    onPointerUp: () => void;
    onPointerCancel: () => void;
    style: { touchAction: 'none' };
  };
}

/** keep long lists draggable end-to-end: nudge the nearest scrollable
 *  ancestor while the pointer rides the viewport edges */
function findScrollParent(anchor: HTMLElement | null): HTMLElement | null {
  let node: HTMLElement | null = anchor;
  while (node && node !== document.body) {
    const canScroll = node.scrollHeight > node.clientHeight + 4;
    if (canScroll && /(auto|scroll)/.test(getComputedStyle(node).overflowY)) return node;
    node = node.parentElement;
  }
  return null;
}

function autoScroll(anchor: HTMLElement | null, pointerY: number): void {
  const EDGE = 56;
  const STEP = 14;
  const node = findScrollParent(anchor);
  const top = node ? node.getBoundingClientRect().top : 0;
  const bottom = node ? node.getBoundingClientRect().bottom : window.innerHeight;
  let delta = 0;
  if (pointerY < top + EDGE) delta = -STEP;
  else if (pointerY > bottom - EDGE) delta = STEP;
  if (!delta) return;
  if (node) node.scrollTop += delta;
  else window.scrollBy(0, delta);
}

export function useDragReorder(count: number, onMove: (from: number, to: number) => void): DragReorder {
  const rowRefs = useRef<(HTMLElement | null)[]>([]);
  const dragRef = useRef<DragState | null>(null);
  const [drag, setDrag] = useState<DragState | null>(null);

  const setRowRef = (index: number) => (el: HTMLElement | null) => {
    rowRefs.current[index] = el;
  };

  const indexAt = (y: number): number => {
    for (let i = 0; i < count; i += 1) {
      const el = rowRefs.current[i];
      if (!el) continue;
      const rect = el.getBoundingClientRect();
      if (y < rect.top + rect.height / 2) return i;
    }
    return count - 1;
  };

  const update = (next: DragState | null) => {
    dragRef.current = next;
    setDrag(next);
  };

  const handleProps = (index: number) => ({
    onPointerDown: (e: ReactPointerEvent<HTMLElement>) => {
      // capture so the whole gesture stays on the handle, wherever the
      // finger wanders (also suppresses the sheet's drag-to-dismiss)
      e.currentTarget.setPointerCapture?.(e.pointerId);
      const rect = rowRefs.current[index]?.getBoundingClientRect();
      update({
        from: index,
        over: index,
        y: e.clientY,
        height: rect?.height ?? 44,
        left: rect?.left ?? 0,
        width: rect?.width ?? 0,
      });
    },
    onPointerMove: (e: ReactPointerEvent<HTMLElement>) => {
      const current = dragRef.current;
      if (!current) return;
      autoScroll(rowRefs.current[current.from], e.clientY);
      update({ ...current, y: e.clientY, over: indexAt(e.clientY) });
    },
    onPointerUp: () => {
      const current = dragRef.current;
      if (current && current.over !== current.from) onMove(current.from, current.over);
      update(null);
    },
    onPointerCancel: () => update(null),
    style: { touchAction: 'none' as const },
  });

  const ghost = drag
    ? { top: drag.y - drag.height / 2, left: drag.left, width: drag.width, height: drag.height }
    : null;

  // rows between the origin and the hovered slot slide one row-height
  // toward the hole; the origin row stays put but fades (the ghost is
  // the thing that moves)
  const rowStyle = (index: number): CSSProperties => {
    if (!drag) return { transition: 'transform 160ms ease' };
    const base: CSSProperties = { transition: 'transform 160ms ease' };
    if (index === drag.from) return { ...base, opacity: 0.3 };
    if (drag.from < drag.over && index > drag.from && index <= drag.over) {
      return { ...base, transform: `translateY(-${drag.height}px)` };
    }
    if (drag.from > drag.over && index >= drag.over && index < drag.from) {
      return { ...base, transform: `translateY(${drag.height}px)` };
    }
    return base;
  };

  return { drag, ghost, setRowRef, rowStyle, handleProps };
}

export interface DragToTargets {
  /** id of the row being dragged, null when idle */
  dragId: string | null;
  /** viewport rect for the floating clone */
  ghost: { top: number; left: number; width: number; height: number } | null;
  /** target currently under the pointer */
  hoveredTarget: string | null;
  rowRef: (id: string) => (el: HTMLElement | null) => void;
  targetRef: (id: string) => (el: HTMLElement | null) => void;
  handleProps: (id: string) => {
    onPointerDown: (e: ReactPointerEvent<HTMLElement>) => void;
    onPointerMove: (e: ReactPointerEvent<HTMLElement>) => void;
    onPointerUp: () => void;
    onPointerCancel: () => void;
    style: { touchAction: 'none' };
  };
}

/**
 * Drag a row onto one of several drop TARGETS (restored category
 * drag-to-move, user request): same ghost visual as the reorder hook,
 * targets highlight while hovered, the drop commits once on release.
 */
export function useDragToTargets(onDrop: (dragId: string, targetId: string) => void): DragToTargets {
  const rowEls = useRef(new Map<string, HTMLElement>());
  const targetEls = useRef(new Map<string, HTMLElement>());
  const stateRef = useRef<{ id: string; y: number; rect: { left: number; width: number; height: number }; over: string | null } | null>(null);
  const [state, setState] = useState<typeof stateRef.current>(null);

  const update = (next: typeof stateRef.current) => {
    stateRef.current = next;
    setState(next);
  };

  const targetAt = (x: number, y: number): string | null => {
    for (const [id, el] of targetEls.current) {
      const r = el.getBoundingClientRect();
      if (x >= r.left && x <= r.right && y >= r.top && y <= r.bottom) return id;
    }
    return null;
  };

  const rowRef = (id: string) => (el: HTMLElement | null) => {
    if (el) rowEls.current.set(id, el);
    else rowEls.current.delete(id);
  };
  const targetRef = (id: string) => (el: HTMLElement | null) => {
    if (el) targetEls.current.set(id, el);
    else targetEls.current.delete(id);
  };

  const handleProps = (id: string) => ({
    onPointerDown: (e: ReactPointerEvent<HTMLElement>) => {
      e.currentTarget.setPointerCapture?.(e.pointerId);
      const rect = rowEls.current.get(id)?.getBoundingClientRect();
      update({ id, y: e.clientY, rect: { left: rect?.left ?? 0, width: rect?.width ?? 0, height: rect?.height ?? 44 }, over: null });
    },
    onPointerMove: (e: ReactPointerEvent<HTMLElement>) => {
      const current = stateRef.current;
      if (!current) return;
      autoScroll(rowEls.current.get(current.id) ?? null, e.clientY);
      update({ ...current, y: e.clientY, over: targetAt(e.clientX, e.clientY) });
    },
    onPointerUp: () => {
      const current = stateRef.current;
      if (current?.over) onDrop(current.id, current.over);
      update(null);
    },
    onPointerCancel: () => update(null),
    style: { touchAction: 'none' as const },
  });

  return {
    dragId: state?.id ?? null,
    ghost: state ? { top: state.y - state.rect.height / 2, left: state.rect.left, width: state.rect.width, height: state.rect.height } : null,
    hoveredTarget: state?.over ?? null,
    rowRef,
    targetRef,
    handleProps,
  };
}
