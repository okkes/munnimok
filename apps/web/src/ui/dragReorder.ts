import { useRef, useState } from 'react';
import type { PointerEvent as ReactPointerEvent } from 'react';

/**
 * Pointer-driven row reorder for the customize sheets (user request:
 * the up/down arrows stay for accessibility, a handle drags). Rows
 * register their elements; while dragging, the hovered index derives
 * from row midpoints and the move commits ONCE on release.
 */
export interface DragReorder {
  /** live drag state for render highlights (null = not dragging) */
  drag: { from: number; over: number } | null;
  setRowRef: (index: number) => (el: HTMLElement | null) => void;
  /** spread onto the drag handle of row `index` */
  handleProps: (index: number) => {
    onPointerDown: (e: ReactPointerEvent<HTMLElement>) => void;
    onPointerMove: (e: ReactPointerEvent<HTMLElement>) => void;
    onPointerUp: () => void;
    onPointerCancel: () => void;
    style: { touchAction: 'none' };
  };
}

export function useDragReorder(count: number, onMove: (from: number, to: number) => void): DragReorder {
  const rowRefs = useRef<(HTMLElement | null)[]>([]);
  const dragRef = useRef<{ from: number; over: number } | null>(null);
  const [drag, setDrag] = useState<{ from: number; over: number } | null>(null);

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

  const update = (next: { from: number; over: number } | null) => {
    dragRef.current = next;
    setDrag(next);
  };

  const handleProps = (index: number) => ({
    onPointerDown: (e: ReactPointerEvent<HTMLElement>) => {
      // capture so the whole gesture stays on the handle, wherever the
      // finger wanders (also suppresses the sheet's own drag-to-dismiss)
      e.currentTarget.setPointerCapture?.(e.pointerId);
      update({ from: index, over: index });
    },
    onPointerMove: (e: ReactPointerEvent<HTMLElement>) => {
      if (dragRef.current) update({ ...dragRef.current, over: indexAt(e.clientY) });
    },
    onPointerUp: () => {
      const current = dragRef.current;
      if (current && current.over !== current.from) onMove(current.from, current.over);
      update(null);
    },
    onPointerCancel: () => update(null),
    style: { touchAction: 'none' as const },
  });

  return { drag, setRowRef, handleProps };
}
