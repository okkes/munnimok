import { stillOwnFill } from './autoFill';
import { REIMBURSED_ID, UNCATEGORIZED_ID } from './categories';
import { merchantKey } from './merchantKey';
import type { TxSplitCat } from '@/db/types';

// only human-confirmed rows count (needsReview 0, a real category): keyword guesses must not masquerade as history
// votes are recency-decayed (half-life ~6 months): one dinner out never beats a habit, a real shift flips it (#161)

/** recency half-life in days — one occurrence six months old counts half */
const HALF_LIFE_DAYS = 180;
const DAY_MS = 86_400_000;

const decayedWeight = (date: string, today: string): number => {
  const age = (Date.parse(today) - Date.parse(date)) / DAY_MS;
  if (!Number.isFinite(age) || age <= 0) return 1;
  return 0.5 ** (age / HALF_LIFE_DAYS);
};

export interface MerchantStats {
  catId: string;
  /** money direction this stat was learned from (refunds ≠ purchases) */
  sign: 1 | -1;
  /** #564: stamp of a savings/loan/brokerage ledger, whose rows never teach an ordinary account; absent = ordinary */
  ledger?: string;
  count: number;
  /** recency-decayed vote mass (#161) — the winner has the most */
  weight: number;
  lastDate: string;
  /** recent absolute amounts (minor units) — powers the same-amount boost */
  amounts: number[];
  /** #161: occurrences that were a percentage SPREAD, and the latest one — predicted when spreads dominate */
  spreadCount: number;
  lastSpread?: { catId: string; pct: number }[];
  eventVotes: Map<string, number>;
}

export type MerchantMemory = Map<string, MerchantStats[]>;

export interface MemoryInput {
  merchant: string;
  catId?: string;
  needsReview: 0 | 1;
  date: string;
  amountCents: number;
  /** the row's category spread — only complete pct partitions teach */
  cats?: TxSplitCat[];
  eventId?: string;
  ledger?: string;
  /** #565: a reserved charge is out of the review, yet what munni filled on it is no habit of the person's */
  pending?: 0 | 1;
  autoFill?: string;
  linkedAccountId?: string;
  recurringId?: string;
}

/** a spread teaches only when EVERY entry is percentage-based — absolute
 *  euro slices never generalize to a different amount */
const teachableSpread = (cats: TxSplitCat[] | undefined): { catId: string; pct: number }[] | undefined => {
  if (!cats || cats.length < 2) return undefined;
  if (!cats.every((c) => c.pct != null)) return undefined;
  return cats.map((c) => ({ catId: c.catId, pct: c.pct! }));
};

function absorbRow(entry: MerchantStats, row: MemoryInput, weight: number): void {
  entry.count += 1;
  entry.weight += weight;
  if (row.date >= entry.lastDate) entry.lastDate = row.date;
  if (entry.amounts.length < 8) entry.amounts.push(Math.abs(row.amountCents));
  const spread = teachableSpread(row.cats);
  if (spread) {
    entry.spreadCount += 1;
    if (!entry.lastSpread || row.date >= entry.lastDate) entry.lastSpread = spread;
  }
  if (row.eventId) entry.eventVotes.set(row.eventId, (entry.eventVotes.get(row.eventId) ?? 0) + weight);
}

export function buildMerchantMemory(rows: readonly MemoryInput[], today?: string): MerchantMemory {
  const now = today ?? rows.reduce((max, r) => (r.date > max ? r.date : max), '1970-01-01');
  const memory: MerchantMemory = new Map();
  for (const row of rows) {
    if (row.needsReview === 1 || !row.catId || row.catId === UNCATEGORIZED_ID) continue;
    // munni must not learn from its own guess: a reserved charge it filled reads as reviewed (it never is)
    if (row.pending === 1 && stillOwnFill(row)) continue;
    // a credit filed Reimbursed is settlement bookkeeping a link wrote, never a habit: the category only arrives through a link
    if (row.catId === REIMBURSED_ID) continue;
    const key = merchantKey(row.merchant);
    if (!key) continue;
    const sign: 1 | -1 = row.amountCents >= 0 ? 1 : -1;
    const stats = memory.get(key) ?? [];
    let entry = stats.find((s) => s.catId === row.catId && s.sign === sign && s.ledger === row.ledger);
    if (!entry) {
      entry = {
        catId: row.catId,
        sign,
        ...(row.ledger ? { ledger: row.ledger } : {}),
        count: 0,
        weight: 0,
        lastDate: row.date,
        amounts: [],
        spreadCount: 0,
        eventVotes: new Map(),
      };
      stats.push(entry);
    }
    absorbRow(entry, row, decayedWeight(row.date, now));
    memory.set(key, stats);
  }
  return memory;
}

/** within 10% (or 50 cents for small amounts) counts as "the same amount" */
const closeAmounts = (a: number, b: number): boolean => Math.abs(a - b) <= Math.max(50, a * 0.1);

export interface MemoryHit {
  catId: string;
  evidence: number;
  /** an earlier occurrence had ~this exact amount (subscription-like) */
  amountMatch: boolean;
  cats?: { catId: string; pct: number }[];
  /** #161: the event the recent charges joined (own-space memory only) */
  eventId?: string;
}

function hitFrom(stat: MerchantStats, amountMatch: boolean): MemoryHit {
  // a spread predicts only when most confirmations were spreads: an occasional split must not fragment future charges
  const cats = stat.lastSpread && stat.spreadCount * 2 > stat.count ? stat.lastSpread : undefined;
  let eventId: string | undefined;
  let best = 0;
  for (const [id, votes] of stat.eventVotes) {
    if (votes > best) {
      best = votes;
      eventId = id;
    }
  }
  // one long-ago event link is noise; ~two recent ones are a habit
  if (best < 1.2) eventId = undefined;
  return { catId: stat.catId, evidence: stat.count, amountMatch, cats, eventId };
}

export function predictFromMemory(memory: MerchantMemory, merchant: string, amountCents: number, ledger?: string): MemoryHit | null {
  const stats = memory.get(merchantKey(merchant));
  if (!stats?.length) return null;
  const sign: 1 | -1 = amountCents >= 0 ? 1 : -1;
  const sameSide = stats.filter((s) => s.sign === sign && s.ledger === ledger);
  if (sameSide.length === 0) return null;

  const abs = Math.abs(amountCents);
  const amountHits = sameSide.filter((s) => s.amounts.some((a) => closeAmounts(a, abs)));
  if (amountHits.length > 0) {
    const best = amountHits.reduce((a, b) => (b.weight > a.weight ? b : a), amountHits[0]);
    return hitFrom(best, true);
  }

  // the heaviest recency-decayed habit wins: one dinner never beats years of groceries
  const best = [...sameSide].sort((a, b) => b.weight - a.weight || b.lastDate.localeCompare(a.lastDate))[0];
  return hitFrom(best, false);
}
