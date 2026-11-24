import { useCallback, useEffect, useRef } from 'react';
import { useData } from '@/app/data';
import { connectorsAvailable } from '@/application/connections';
import { categoriseReceipts, handedOverSince, myFetchedReceipts } from '@/application/receiptCategorise';
import type { CategoriseOutcome } from '@/application/receiptCategorise';
import type { ReceiptRow } from '@/db/types';
import { useReadCategories } from './ReceiptAiRead';
import { categoriseLines, receiptAutoCategoriseFrom } from './receiptAi';

/** #648: has the reader suggest a category for the lines of fetched receipts, with this space's categories to choose from */
export function useCategoriser(): (receipts: readonly ReceiptRow[]) => Promise<CategoriseOutcome> {
  const { store, repo } = useData();
  const categories = useReadCategories();
  return useCallback(
    (receipts) => categoriseReceipts(store, repo, receipts, (merchant, names) => categoriseLines(merchant, names, categories)),
    [store, repo, categories],
  );
}

/** the most calls one tap on "categorise what I have" makes: each is one of the day's reads */
export const CATEGORISE_ALL_CALLS = 5;

/** every fetched receipt the person owns, a shop at a time, until nothing is left to ask or the reader says stop */
export function useCategoriseAll(): () => Promise<CategoriseOutcome> {
  const { store } = useData();
  const categorise = useCategoriser();
  return useCallback(async () => {
    let total = 0;
    let outcome: CategoriseOutcome = { state: 'none', receipts: 0, more: false };
    for (let call = 0; call < CATEGORISE_ALL_CALLS; call += 1) {
      outcome = await categorise(await myFetchedReceipts(store));
      total += outcome.receipts;
      if (outcome.state !== 'ok' || !outcome.more) break;
    }
    return { ...outcome, state: total > 0 && outcome.state === 'none' ? 'ok' : outcome.state, receipts: total };
  }, [store, categorise]);
}

const AUTO_CATEGORISE_MS = 10 * 60 * 1000;

// with the standing order on, the receipts a shop handed over since then are categorised after a sync that ended
// cleanly — at most one call per interval, and none when every line name is known already
export function useReceiptAutoCategorise(): void {
  const { store, engine } = useData();
  const categorise = useCategoriser();
  const last = useRef(0);
  useEffect(() => {
    if (!engine || !connectorsAvailable()) return;
    const pass = async (since: string) => categorise(handedOverSince(await myFetchedReceipts(store), since));
    return engine.onStatus((status) => {
      const since = receiptAutoCategoriseFrom();
      if (status !== 'idle' || !since || Date.now() - last.current < AUTO_CATEGORISE_MS) return;
      last.current = Date.now();
      // a closed database or a lost connection: the next clean sync asks again
      void pass(since).catch(() => undefined);
    });
  }, [engine, store, categorise]);
}
