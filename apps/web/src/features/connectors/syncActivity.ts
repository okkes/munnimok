import { create } from 'zustand';
import type { SyncReport } from './connectorSync';

// a module store, not screen state: the sync outlives the screen that started it
export type SyncPhase = 'fetching' | 'done';

export interface SyncActivity {
  connectionId: string;
  phase: SyncPhase;
  /** records the party's run reported gathering so far; null until it counted anything */
  found: number | null;
  /** #460: the sync went on to older history — the oldest day fetched so far (yyyy-mm-dd) */
  older?: string;
  startedAt: number;
  finishedAt?: number;
  report?: SyncReport;
}

interface SyncActivityStore {
  activity: Record<string, SyncActivity>;
  begin: (connectionId: string) => void;
  found: (connectionId: string, records: number) => void;
  older: (connectionId: string, reached: string) => void;
  end: (connectionId: string, report: SyncReport) => void;
  forget: (connectionId: string) => void;
}

/** how long a finished sync's result stays on the row before the plain state line returns */
export const RESULT_TTL_MS = 10 * 60 * 1000;

export const useSyncActivity = create<SyncActivityStore>((set) => ({
  activity: {},
  begin: (connectionId) =>
    set((s) => ({
      activity: { ...s.activity, [connectionId]: { connectionId, phase: 'fetching', found: null, startedAt: Date.now() } },
    })),
  found: (connectionId, records) =>
    set((s) => {
      const current = s.activity[connectionId];
      if (current?.phase !== 'fetching') return s;
      return { activity: { ...s.activity, [connectionId]: { ...current, found: records } } };
    }),
  older: (connectionId, reached) =>
    set((s) => {
      const current = s.activity[connectionId];
      if (current?.phase !== 'fetching') return s;
      return { activity: { ...s.activity, [connectionId]: { ...current, older: reached } } };
    }),
  end: (connectionId, report) =>
    set((s) => {
      const current = s.activity[connectionId];
      return {
        activity: {
          ...s.activity,
          [connectionId]: {
            connectionId,
            phase: 'done',
            found: current?.found ?? null,
            startedAt: current?.startedAt ?? Date.now(),
            finishedAt: Date.now(),
            report,
          },
        },
      };
    }),
  forget: (connectionId) =>
    set((s) => {
      const rest = { ...s.activity };
      delete rest[connectionId];
      return { activity: rest };
    }),
}));

export const resultStillFresh = (activity: SyncActivity | undefined, now = Date.now()): activity is SyncActivity & { report: SyncReport } => {
  if (activity?.phase !== 'done' || !activity.report) return false;
  return now - (activity.finishedAt ?? 0) < RESULT_TTL_MS;
};
