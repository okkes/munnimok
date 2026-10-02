import { create } from 'zustand';
import type { SyncReport } from './connectorSync';

/**
 * What every sync is doing right now, whoever started it (user request
 * 2026-10-02: "give the user visuals when the fetching is busy and when
 * it's done … a counter that goes up"). The first sync after a connect,
 * the app-open keep-alive and Sync now all run through `syncConnection`,
 * which reports here; the hub's rows and the fetched-receipts screen read
 * it. A module store rather than screen state, because the sync outlives
 * the screen that started it.
 */
export type SyncPhase = 'fetching' | 'done';

export interface SyncActivity {
  connectionId: string;
  phase: SyncPhase;
  /** records the party's run reported gathering so far; null until it counted anything */
  found: number | null;
  startedAt: number;
  finishedAt?: number;
  /** the outcome, once done */
  report?: SyncReport;
}

interface SyncActivityStore {
  activity: Record<string, SyncActivity>;
  begin: (connectionId: string) => void;
  found: (connectionId: string, records: number) => void;
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
      if (!current || current.phase !== 'fetching') return s;
      return { activity: { ...s.activity, [connectionId]: { ...current, found: records } } };
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

/** a finished sync whose result is still worth showing */
export const resultStillFresh = (activity: SyncActivity | undefined, now = Date.now()): activity is SyncActivity & { report: SyncReport } =>
  activity?.phase === 'done' && !!activity.report && now - (activity.finishedAt ?? 0) < RESULT_TTL_MS;
