import { merchantKey } from './merchantKey';

/**
 * #533: the booked row a reserved (pending) charge became. The bank links
 * the two by nothing — the reserved row's reference is not the booked
 * one's — so the twin is the booked row on the same account that looks
 * like the same payment: the same merchant and direction, a day from a few
 * before the reservation to two weeks after it (a fuel or hotel hold often
 * books for a different sum).
 */
export interface TwinFacts {
  id: string;
  date: string;
  amountCents: number;
  merchant: string;
}

const DAY_MS = 86_400_000;
/** how many days before the reservation a booking may carry */
export const TWIN_DAYS_BEFORE = 3;
/** how many days after it */
export const TWIN_DAYS_AFTER = 14;

function scoreOf(reserved: TwinFacts, booked: TwinFacts, reservedKey: string, bookedKey: string): number | null {
  if (reserved.amountCents === 0 || Math.sign(reserved.amountCents) !== Math.sign(booked.amountCents)) return null;
  // the amount alone names nothing: a stranger of the same sum would take the reservation's story
  if (reservedKey === '' || reservedKey !== bookedKey) return null;
  const days = (Date.parse(booked.date) - Date.parse(reserved.date)) / DAY_MS;
  if (Number.isNaN(days) || days < -TWIN_DAYS_BEFORE || days > TWIN_DAYS_AFTER) return null;
  const ratio = Math.abs(booked.amountCents) / Math.abs(reserved.amountCents);
  if (ratio < 0.25 || ratio > 4) return null;
  return (reserved.amountCents === booked.amountCents ? 4 : 0) - Math.abs(days) / 4 - Math.abs(Math.log(ratio));
}

/** how alike two rows are as reserved → booked, or null when they cannot be the same payment */
export function twinScore(reserved: TwinFacts, booked: TwinFacts): number | null {
  return scoreOf(reserved, booked, merchantKey(reserved.merchant), merchantKey(booked.merchant));
}

/** each reserved row's booked twin (reserved id → booked id), one booked row
 *  per reservation: the older reservation chooses first and takes its closest
 *  booking left — two identical payments on following days stay in order */
export function pairReservedWithBooked(reserved: readonly TwinFacts[], booked: readonly TwinFacts[]): Map<string, string> {
  const taken = new Set<string>();
  const pairs = new Map<string, string>();
  const byAge = [...reserved].sort((a, b) => a.date.localeCompare(b.date) || a.id.localeCompare(b.id));
  const bookedKeys = booked.map((b) => merchantKey(b.merchant));
  for (const r of byAge) {
    const key = merchantKey(r.merchant);
    let best: { id: string; score: number } | null = null;
    for (const [i, b] of booked.entries()) {
      if (taken.has(b.id)) continue;
      const score = scoreOf(r, b, key, bookedKeys[i]);
      if (score !== null && (!best || score > best.score)) best = { id: b.id, score };
    }
    if (best) {
      pairs.set(r.id, best.id);
      taken.add(best.id);
    }
  }
  return pairs;
}
