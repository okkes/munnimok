import { useEffect, useState } from 'react';

/**
 * Lock state for a Sheet with a child sheet stacked on top. The parent must
 * stay non-dismissible not only while the child is open but also briefly
 * after it closes — the closing tap would otherwise be processed as an
 * outside-click on the freshly unlocked parent and dismiss it.
 */
export function useSheetStackLock(childOpen: boolean): boolean {
  const [locked, setLocked] = useState(childOpen);
  useEffect(() => {
    if (childOpen) {
      setLocked(true);
      return;
    }
    const timer = setTimeout(() => setLocked(false), 600);
    return () => clearTimeout(timer);
  }, [childOpen]);
  return locked;
}
