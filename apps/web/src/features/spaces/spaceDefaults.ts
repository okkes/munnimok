/** every new space starts seeing this much bank history (user default) */
export const DEFAULT_HISTORY_MONTHS = 3;

/** local-date ISO string `months` months back — for history-start defaults */
export const isoMonthsAgo = (months: number): string => {
  const d = new Date();
  d.setMonth(d.getMonth() - months);
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
};
