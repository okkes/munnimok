/**
 * #502: the row of a list nearest to a day — the closest date on either
 * side (4 July or 8 July for 7 July, whichever is closer); between two
 * rows equally far the one listed first wins. -1 for an empty list.
 */
export function nearestDateIndex(rows: readonly { date: string }[], day: string): number {
  const target = Date.parse(day);
  let best = -1;
  let bestGap = Number.POSITIVE_INFINITY;
  rows.forEach((row, index) => {
    const gap = Math.abs(Date.parse(row.date) - target);
    if (gap < bestGap) {
      best = index;
      bestGap = gap;
    }
  });
  return best;
}
