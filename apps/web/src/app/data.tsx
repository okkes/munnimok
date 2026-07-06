import { createContext, useCallback, useContext, useEffect, useMemo, useState } from 'react';
import type { ReactNode } from 'react';
import { MunniDB, identityDbName } from '@/db/schema';
import { Repo } from '@/db/repo';
import { getClock } from '@/db/device';
import { seedDemoIfNeeded } from '@/db/seed';
import { identityKey, useSession } from './session';
import type { Identity } from './session';

const ACTIVE_SPACE_KEY = 'activeSpaceId';

interface DataContextValue {
  db: MunniDB;
  repo: Repo;
  /** the currently active space */
  spaceId: string;
  setActiveSpace: (spaceId: string) => Promise<void>;
}

const DataContext = createContext<DataContextValue | null>(null);

/**
 * Opens the identity's database (seeding demo data on first use), resolves
 * the active space, and provides db/repo to the screens. Renders nothing
 * until ready so screens never flash empty state.
 */
export function DataProvider({ children }: { children: ReactNode }) {
  const identity = useSession((s) => s.identity);
  const [state, setState] = useState<{ db: MunniDB; repo: Repo; spaceId: string } | null>(null);

  useEffect(() => {
    if (!identity) {
      setState(null);
      return;
    }
    let cancelled = false;
    const db = new MunniDB(identityDbName(identityKey(identity)));
    // demo/offline identities never sync — no outbox
    const repo = new Repo(db, getClock(), { trackOutbox: false });
    void (async () => {
      if (identity.kind === 'demo') await seedDemoIfNeeded(repo);
      const stored = (await db.meta.get(ACTIVE_SPACE_KEY))?.value as string | undefined;
      const spaces = await db.spaces.filter((s) => s.deleted === 0).toArray();
      const spaceId = spaces.find((s) => s.id === stored)?.id ?? spaces[0]?.id;
      if (!spaceId) throw new Error('no space available after seed');
      if (!cancelled) setState({ db, repo, spaceId });
    })().catch((err) => {
      // StrictMode double-mount closes the first db mid-seed — expected
      if (!cancelled) throw err;
    });
    return () => {
      cancelled = true;
      db.close();
    };
  }, [identity]);

  const setActiveSpace = useCallback(
    async (spaceId: string) => {
      if (!state) return;
      await state.db.meta.put({ key: ACTIVE_SPACE_KEY, value: spaceId });
      setState((prev) => (prev ? { ...prev, spaceId } : prev));
    },
    [state],
  );

  const value = useMemo(() => (state ? { ...state, setActiveSpace } : null), [state, setActiveSpace]);

  if (!identity) return null;
  if (!value) {
    return <div className="flex h-full items-center justify-center text-ink-3" data-testid="data-loading" />;
  }
  return <DataContext.Provider value={value}>{children}</DataContext.Provider>;
}

export function useData(): DataContextValue {
  const ctx = useContext(DataContext);
  if (!ctx) throw new Error('useData must be used within DataProvider');
  return ctx;
}

/** Demo logout = wipe the database so next login reseeds pristine state. */
export async function destroyIdentityData(identity: Identity): Promise<void> {
  const db = new MunniDB(identityDbName(identityKey(identity)));
  await db.delete();
}
