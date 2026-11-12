import type { SplitEntry, SplitSummary } from '@/application/splitsApi';
import type { StorageBackend } from '@/db/backend';
import { visibleTransactions } from '@/db/joined';
import type { SpaceTx } from '@/db/joined';
import type { Repo } from '@/db/repo';
import type { EventRow } from '@/db/types';

/**
 * #538 (user): a split is bound to one or more REGULAR events. The bond is
 * the event's own fact (`splitId`), so it lives in the event's space —
 * whoever shares that space and is in the split shares it — and several
 * events, in several spaces, can name the same split. Nothing moves by
 * itself: munni points out payments that are in one and not in the other,
 * the person adds them or says "ignore", and what was ignored stays away.
 */

/** the events of every space on this device that name the split, by name */
export async function boundEvents(store: StorageBackend, splitId: string): Promise<EventRow[]> {
  return (await store.allRows('event')).filter((event) => event.deleted === 0 && event.splitId === splitId).sort((a, b) => a.name.localeCompare(b.name));
}

export interface EventSuggestion {
  event: EventRow;
  tx: SpaceTx;
}

export interface EventSuggestions {
  /** payments the person put in the split from an event's space that sit in no event yet */
  toEvent: EventSuggestion[];
  /** payments of a bound event that are not in the split */
  toSplit: EventSuggestion[];
}

export async function eventSuggestions(store: StorageBackend, splitId: string, events: readonly EventRow[], entries: readonly SplitEntry[]): Promise<EventSuggestions> {
  const mine = new Set(entries.map((entry) => entry.sourceTxId).filter((id): id is string => !!id));
  const out: EventSuggestions = { toEvent: [], toSplit: [] };
  const spacesSeen = new Set<string>();
  for (const event of events) {
    const skipped = new Set(event.splitSkips ?? []);
    const asked = (await visibleTransactions(store, event.spaceId)).filter((tx) => !skipped.has(tx.id));
    // one event per space is asked about a payment that sits in none: two bound events must not both claim it
    if (!spacesSeen.has(event.spaceId)) {
      spacesSeen.add(event.spaceId);
      out.toEvent.push(...asked.filter((tx) => mine.has(tx.id) && !tx.eventId).map((tx) => ({ event, tx })));
    }
    const missing = asked.filter((tx) => tx.eventId === event.id && tx.amountCents < 0 && !mine.has(tx.id) && tx.splitRef?.splitId !== splitId);
    out.toSplit.push(...missing.map((tx) => ({ event, tx })));
  }
  return out;
}

/** "ignore": that payment is never brought up for this event and its split again */
export async function skipSuggestion(repo: Repo, event: EventRow, txId: string): Promise<void> {
  await repo.upsert('event', event.spaceId, event.id, { splitSkips: [...new Set([...(event.splitSkips ?? []), txId])] });
}

/**
 * Until 5.21 a member's link to ONE event was kept with their membership on
 * the server. It is the event's own fact now: a link the server still
 * names is written onto its event once, where the event is on this device.
 */
export async function adoptEventLinks(store: StorageBackend, repo: Repo, splits: readonly Pick<SplitSummary, 'id' | 'attachedEventId'>[]): Promise<void> {
  for (const split of splits) {
    if (!split.attachedEventId) continue;
    const event = await store.get('event', split.attachedEventId);
    // a follow-up, not the person's edit: a space they only read keeps its rows
    if (event?.deleted === 0 && event.splitId === undefined) await repo.upkeep().upsert('event', event.spaceId, event.id, { splitId: split.id });
  }
}
