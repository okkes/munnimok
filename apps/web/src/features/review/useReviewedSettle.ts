import { useEffect, useRef } from 'react';
import { useData } from '@/app/data';
import { settleReviewed } from '@/application/deliveredResolve';

/** #614: once the last transaction is reviewed, the phone lets go of "N new transactions arrived" */
export function useReviewedSettle(waiting: number | undefined): void {
  const { store } = useData();
  const before = useRef<number | undefined>(undefined);
  useEffect(() => {
    // only the step from some to none: a list still loading, or one the sync has not filled yet, reads as none too
    if (waiting === 0 && (before.current ?? 0) > 0) void settleReviewed(store).catch(() => undefined);
    before.current = waiting;
  }, [waiting, store]);
}
