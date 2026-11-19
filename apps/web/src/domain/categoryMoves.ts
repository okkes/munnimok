import type { ReceiptItem, ReceiptPick, TxSplit, TxSplitCat } from '@/db/types';
import { en } from '@/i18n/en';
import { nl } from '@/i18n/nl';
import { tr } from '@/i18n/tr';
import { childrenOf } from './categories';

// #653: the catalog gave groceries a main of their own and merged look-alike subs. An id that only moved or was renamed
// is left alone (the rows filed under it resolve as before); what follows names the ids that are gone, and where they went

/** from id → to id */
export type CatMoves = ReadonlyMap<string, string>;

/** built-ins the catalog merged into another: every stored mention follows */
export const MERGED_BUILTINS: CatMoves = new Map([['softDrinks', 'coffee']]);

export const GROCERY_MAIN_ID = 'grocery';
/** the catalog's Other under Groceries: the id every grocery payment was filed under before the main had subs */
export const GROCERY_OTHER_ID = 'groceries';

export const normCatName = (name: string | undefined): string => (name ?? '').trim().toLocaleLowerCase().replace(/\s+/g, ' ');

const DICTS = [en, nl, tr] as const;
const namesOf = (key: string): string[] => DICTS.map((dict) => normCatName((dict as Record<string, string>)[key]));

/** what a person's own main is called when it is the catalog's Groceries */
export const GROCERY_MAIN_NAMES: ReadonlySet<string> = new Set([...namesOf('cat.grocery'), 'grocery']);

/** the names such a tree was built with before the catalog chose its own */
const FORMER_SUB_NAMES: Readonly<Record<string, string>> = {
  alcohol: 'groceryAlcohol',
  'cooking basics': 'groceryCooking',
  'meal kit': 'groceryMealKits',
  'ready-made food': 'groceryReadyMeals',
  'snacks & sweets': 'grocerySnacks',
};

/** a sub of the catalog's Groceries by any of its names (the Other is told by its mark, not by a name every main has) */
export const GROCERY_SUB_BY_NAME: ReadonlyMap<string, string> = new Map([
  ...childrenOf(GROCERY_MAIN_ID)
    .filter((sub) => sub.id !== GROCERY_OTHER_ID)
    .flatMap((sub) => namesOf(sub.nameKey).map((name): [string, string] => [name, sub.id])),
  ...Object.entries(FORMER_SUB_NAMES),
]);

const moved = <T extends { catId: string }>(entries: readonly T[], moves: CatMoves): T[] =>
  entries.map((entry) => (moves.has(entry.catId) ? { ...entry, catId: moves.get(entry.catId)! } : entry));

const mentions = (entries: readonly { catId?: string }[] | undefined, moves: CatMoves): boolean =>
  (entries ?? []).some((entry) => !!entry.catId && moves.has(entry.catId));

export interface CatStory {
  catId?: string;
  cats?: TxSplitCat[];
  splits?: TxSplit[];
}

/** the story fields that name a moved category, rewritten (amounts untouched); null when none does */
export function movedStory(story: CatStory, moves: CatMoves): CatStory | null {
  const patch: CatStory = {};
  if (story.catId && moves.has(story.catId)) patch.catId = moves.get(story.catId);
  if (mentions(story.cats, moves)) patch.cats = moved(story.cats!, moves);
  if ((story.splits ?? []).some((part) => moves.has(part.catId) || mentions(part.cats, moves))) {
    patch.splits = story.splits!.map((part) => ({
      ...part,
      ...(moves.has(part.catId) ? { catId: moves.get(part.catId)! } : {}),
      ...(mentions(part.cats, moves) ? { cats: moved(part.cats!, moves) } : {}),
    }));
  }
  return Object.keys(patch).length > 0 ? patch : null;
}

/** a list of category ids with the moved ones replaced, each id once; null when none moved */
export function movedIds(ids: readonly string[] | undefined, moves: CatMoves): string[] | null {
  if (!(ids ?? []).some((id) => moves.has(id))) return null;
  return [...new Set(ids!.map((id) => moves.get(id) ?? id))];
}

/** a receipt's lines with their suggested categories moved; null when none moved */
export function movedItems(items: readonly ReceiptItem[] | undefined, moves: CatMoves): ReceiptItem[] | null {
  if (!mentions(items, moves)) return null;
  return items!.map((item) => (item.catId && moves.has(item.catId) ? { ...item, catId: moves.get(item.catId) } : item));
}

/** what a receipt's lines were filed as, per transaction, with the moved categories replaced; null when none moved */
export function movedPicks(picks: Readonly<Record<string, ReceiptPick[]>> | undefined, moves: CatMoves): Record<string, ReceiptPick[]> | null {
  if (!Object.values(picks ?? {}).some((list) => mentions(list, moves))) return null;
  return Object.fromEntries(Object.entries(picks!).map(([txId, list]) => [txId, moved(list, moves)]));
}
