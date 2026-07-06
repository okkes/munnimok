import { createContext, useContext, useEffect, useMemo, useState } from 'react';
import type { ReactNode } from 'react';
import { MunniDB, identityDbName } from '@/db/schema';
import { Repo } from '@/db/repo';
import { getClock } from '@/db/device';
import { seedDemoIfNeeded, DEMO_SPACE_ID } from '@/db/seed';
import { identityKey, useSession } from './session';
import type { Identity } from './session';

interface DataContextValue {
  db: MunniDB;
  repo: Repo;
  /** the currently active space (demo has exactly one) */
  spaceId: string;
}

const DataContext = createContext<DataContextValue | null>(null);

function openFor(identity: Identity): DataContextValue {
  const db = new MunniDB(identityDbName(identityKey(identity)));
  // demo/offline identities never sync — no outbox
  const repo = new Repo(db, getClock(), { trackOutbox: false });
  return { db, repo, spaceId: DEMO_SPACE_ID };
}

/**
 * Opens the identity's database (seeding demo data on first use) and provides
 * db/repo to the screens. Renders nothing until the seed is in place so
 * screens never flash empty state.
 */
export function DataProvider({ children }: { children: ReactNode }) {
  const identity = useSession((s) => s.identity);
  const [value, setValue] = useState<DataContextValue | null>(null);

  useEffect(() => {
    if (!identity) {
      setValue(null);
      return;
    }
    let cancelled = false;
    const ctx = openFor(identity);
    void (async () => {
      if (identity.kind === 'demo') await seedDemoIfNeeded(ctx.repo);
      if (!cancelled) setValue(ctx);
    })().catch((err) => {
      // StrictMode double-mount closes the first db mid-seed — expected
      if (!cancelled) throw err;
    });
    return () => {
      cancelled = true;
      ctx.db.close();
    };
  }, [identity]);

  const memo = useMemo(() => value, [value]);
  if (!identity) return null;
  if (!memo) {
    return <div className="flex h-full items-center justify-center text-ink-3" data-testid="data-loading" />;
  }
  return <DataContext.Provider value={memo}>{children}</DataContext.Provider>;
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
