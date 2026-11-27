import { UNCATEGORIZED_ID } from './categories';
import type { TxSplitCat } from '@/db/types';

// #565 (user 2026-11-26): what munni works out about a transaction is written into it the moment it lands — it does
// not wait for the review. A filled row says so (`autoFill`): which parts munni wrote, and a fingerprint of the row's
// opinion right after. While the fingerprint still fits, nobody touched the row since, and a better answer may replace
// munni's own; the moment anything else changes it — a person, another rule — the row is left alone.

/** what a space thinks a transaction is: the parts a fill may write */
export interface Opinion {
  catId?: string;
  cats?: TxSplitCat[];
  linkedAccountId?: string;
  recurringId?: string;
  eventId?: string;
}

/** c = the category (and its spread), l = the counterparty account, r = the recurring cost, e = the event */
export type FillPart = 'c' | 'l' | 'r' | 'e';
const PARTS: readonly FillPart[] = ['c', 'l', 'r', 'e'];

type Opinionated = { [K in keyof Opinion]?: Opinion[K] | null };

const text = (value: string | null | undefined): string => (value && value !== UNCATEGORIZED_ID ? value : '');

export const opinionOf = (tx: Opinionated): Opinion => ({
  catId: text(tx.catId) || undefined,
  cats: tx.cats?.length ? tx.cats : undefined,
  linkedAccountId: tx.linkedAccountId || undefined,
  recurringId: tx.recurringId || undefined,
  eventId: tx.eventId || undefined,
});

const partText = (opinion: Opinion, part: FillPart): string => {
  if (part === 'c') return JSON.stringify([opinion.catId ?? '', (opinion.cats ?? []).map((c) => [c.catId, c.amountCents, c.pct ?? null])]);
  if (part === 'l') return opinion.linkedAccountId ?? '';
  return (part === 'r' ? opinion.recurringId : opinion.eventId) ?? '';
};

function hash32(value: string): string {
  let hash = 0x811c9dc5;
  for (let i = 0; i < value.length; i++) {
    hash ^= value.codePointAt(i) ?? 0;
    hash = Math.imul(hash, 0x01000193);
  }
  return (hash >>> 0).toString(36);
}

export const opinionHash = (opinion: Opinion): string => hash32(PARTS.map((part) => partText(opinion, part)).join('|'));

export interface FillMark {
  parts: FillPart[];
  hash: string;
}

export function readMark(mark: string | null | undefined): FillMark | null {
  const at = mark?.indexOf(':') ?? -1;
  if (!mark || at < 0) return null;
  return { parts: PARTS.filter((part) => mark.slice(0, at).includes(part)), hash: mark.slice(at + 1) };
}

export const writeMark = (parts: readonly FillPart[], opinion: Opinion): string => `${PARTS.filter((part) => parts.includes(part)).join('')}:${opinionHash(opinion)}`;

/** munni filled the row and nothing changed it since */
export const stillOwnFill = (tx: Opinionated & { autoFill?: string | null }): boolean => readMark(tx.autoFill)?.hash === opinionHash(opinionOf(tx));

const without = (opinion: Opinion, parts: readonly FillPart[]): Opinion => ({
  catId: parts.includes('c') ? undefined : opinion.catId,
  cats: parts.includes('c') ? undefined : opinion.cats,
  linkedAccountId: parts.includes('l') ? undefined : opinion.linkedAccountId,
  recurringId: parts.includes('r') ? undefined : opinion.recurringId,
  eventId: parts.includes('e') ? undefined : opinion.eventId,
});

/** the opinion a fresh suggestion starts from: the row's own, less what munni filled while that still stands — so a
 *  better answer is not held back by munni's earlier one */
export function opinionBeforeFill(tx: Opinionated & { autoFill?: string | null }): Opinion {
  const own = opinionOf(tx);
  const mark = readMark(tx.autoFill);
  return mark && mark.hash === opinionHash(own) ? without(own, mark.parts) : own;
}

export interface FillPlan {
  /** the parts to write, a part to clear as null */
  fields: { catId?: string | null; cats?: TxSplitCat[] | null; linkedAccountId?: string | null; recurringId?: string | null; eventId?: string | null; autoFill: string | null };
  /** the opinion the row holds afterwards */
  after: Opinion;
}

/** what to write so the row holds `suggested` — the suggestion composed on `opinionBeforeFill(tx)`, so everything the
 *  row held itself is in it. Null where there is nothing to write, and where the row was changed since munni filled
 *  it: that row is somebody's own now */
export function fillPlan(tx: Opinionated & { autoFill?: string | null }, suggested: Opinion): FillPlan | null {
  const own = opinionOf(tx);
  const mark = readMark(tx.autoFill);
  if (mark && mark.hash !== opinionHash(own)) return null;
  const before = opinionBeforeFill(tx);
  // the category and the counterparty are the suggestion's own: it was composed on what the row held, by the rules a
  // Confirm follows (a category a person chose stays, a counterparty may re-file a bare movement). A recurring cost or
  // an event the row names already is never replaced
  const after: Opinion = {
    catId: suggested.catId,
    cats: suggested.cats,
    linkedAccountId: suggested.linkedAccountId,
    recurringId: before.recurringId ?? suggested.recurringId,
    eventId: before.eventId ?? suggested.eventId,
  };
  if (opinionHash(after) === opinionHash(own)) return null;
  const filled = PARTS.filter((part) => partText(after, part) !== partText(before, part));
  const fields: FillPlan['fields'] = { autoFill: filled.length > 0 ? writeMark(filled, after) : null };
  if (partText(after, 'c') !== partText(own, 'c')) {
    fields.catId = after.catId ?? null;
    fields.cats = after.cats ?? null;
  }
  if (after.linkedAccountId !== own.linkedAccountId) fields.linkedAccountId = after.linkedAccountId ?? null;
  if (after.recurringId !== own.recurringId) fields.recurringId = after.recurringId ?? null;
  if (after.eventId !== own.eventId) fields.eventId = after.eventId ?? null;
  return { fields, after };
}
