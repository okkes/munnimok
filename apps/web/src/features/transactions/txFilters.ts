import { EMPTY_FILTERS } from './FilterSheet';
import type { SheetFilters } from './FilterSheet';

/** filters survive a detour into a transaction but reset on a fresh start or another tab: module state (#140) */
export interface TxFilterState {
  query: string;
  uncatOnly: boolean;
  unsettledOnly: boolean;
  counterOnly: boolean;
  /** #148: the home block's "see all" lens — unreviewed rows only */
  newOnly: boolean;
  filters: SheetFilters;
}

export const EMPTY_TX_FILTERS: TxFilterState = {
  query: '',
  uncatOnly: false,
  unsettledOnly: false,
  counterOnly: false,
  newOnly: false,
  filters: EMPTY_FILTERS,
};

let snapshot: TxFilterState = EMPTY_TX_FILTERS;

export const readTxFilters = (): TxFilterState => snapshot;
export const writeTxFilters = (next: TxFilterState): void => {
  snapshot = next;
};
export const clearTxFilters = (): void => {
  snapshot = EMPTY_TX_FILTERS;
};
/** arrive with a lens pre-set (#148: home's "see all" → the new ones) */
export const presetTxFilters = (partial: Partial<TxFilterState>): void => {
  snapshot = { ...EMPTY_TX_FILTERS, ...partial };
};
