import { createContext, useCallback, useContext, useEffect, useMemo, useState } from 'react';
import type { ReactNode } from 'react';
import { v7 as uuidv7 } from 'uuid';
import { useLang } from '@/i18n';
import { Icon } from '@/ui/Icon';
import { MunniDB, identityDbName } from '@/db/schema';
import { Repo } from '@/db/repo';
import { getClock, getDeviceId } from '@/db/device';
import { seedDemoIfNeeded } from '@/db/seed';
import { ApiSyncBackend } from '@/sync/backend';
import { SyncEngine } from '@/sync/engine';
import { config } from './config';
import { requestOutboxSync } from './pwa';
import { clearSwSession, jwtExpiryMs, mirrorSessionForSw } from '@/lib/swBridge';
import { getAccessToken, waitForAuthReady } from './authToken';
import { identityKey, useSession } from './session';
import type { Identity } from './session';

const ACTIVE_SPACE_KEY = 'activeSpaceId';
/** id of a personal space this device created during bootstrap (self-heal marker) */
const BOOTSTRAP_SPACE_KEY = 'bootstrapSpaceId';

const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

/**
 * First-run bootstrap for syncing identities — FAIL CLOSED: a personal
 * space is only ever created after the server CONFIRMED this account has
 * no spaces. Network/auth failures retry with backoff instead of
 * spawning an empty duplicate space (an early bug that stranded devices
 * on a blank copy). Existing local data always loads without a server.
 */
export async function bootstrapUserSpaces(
  db: MunniDB,
  repo: Repo,
  engine: SyncEngine,
  isCancelled: () => boolean,
  baseRetryMs = 2_000,
  onAttemptFailed?: (attempt: number) => void,
): Promise<void> {
  const hasLocalSpaces = async () => (await db.spaces.filter((s) => s.deleted === 0).count()) > 0;

  for (let attempt = 0; ; attempt++) {
    await engine.syncAll().catch(() => undefined);
    if (engine.getStatus() !== 'error' && engine.getStatus() !== 'offline') break; // server confirmed our spaces
    if (await hasLocalSpaces()) return; // offline but usable — local-first
    // brand-new device with nothing local: keep trying, capped backoff —
    // and tell the UI, so a broken server/proxy is visible, not a spinner
    onAttemptFailed?.(attempt + 1);
    await sleep(Math.min(baseRetryMs * 2 ** attempt, baseRetryMs * 8));
    if (isCancelled()) return;
  }

  if (!(await hasLocalSpaces())) {
    // server confirmed: brand-new user — create the personal space once
    const personalId = uuidv7();
    await repo.upsert('space', personalId, personalId, {
      name: 'Personal',
      kind: 'personal',
      currency: 'EUR',
      periodType: 'month',
      periodDay: 1,
    });
    await db.meta.put({ key: BOOTSTRAP_SPACE_KEY, value: personalId });
    // show the one-time onboarding (this device created the space)
    await db.meta.put({ key: 'needsOnboarding', value: true });
    return;
  }

  // self-heal: if a bootstrap-created space is still empty while the
  // account's real spaces arrived (pre-fix duplicates), retire it
  const bootstrapId = (await db.meta.get(BOOTSTRAP_SPACE_KEY))?.value as string | undefined;
  if (!bootstrapId) return;
  const others = await db.spaces.filter((s) => s.deleted === 0 && s.id !== bootstrapId).count();
  if (others === 0) return;
  const [txs, accounts, cats] = await Promise.all([
    db.transactions.where('spaceId').equals(bootstrapId).count(),
    db.accounts.where('spaceId').equals(bootstrapId).count(),
    db.categories.where('spaceId').equals(bootstrapId).count(),
  ]);
  if (txs === 0 && accounts === 0 && cats === 0) {
    await repo.remove('space', bootstrapId, bootstrapId);
  }
  await db.meta.delete(BOOTSTRAP_SPACE_KEY);
}

interface DataContextValue {
  db: MunniDB;
  repo: Repo;
  /** the currently active space */
  spaceId: string;
  setActiveSpace: (spaceId: string) => Promise<void>;
  /** present only for syncing (user) identities */
  engine: SyncEngine | null;
}

const DataContext = createContext<DataContextValue | null>(null);

/**
 * Opens the identity's database (seeding demo data on first use), resolves
 * the active space, and provides db/repo to the screens. Renders nothing
 * until ready so screens never flash empty state.
 */
export function DataProvider({ children }: { children: ReactNode }) {
  const identity = useSession((s) => s.identity);
  const [state, setState] = useState<{ db: MunniDB; repo: Repo; spaceId: string; engine: SyncEngine | null } | null>(
    null,
  );
  const [failedAttempts, setFailedAttempts] = useState(0);

  useEffect(() => {
    if (!identity) {
      setState(null);
      clearSwSession(); // signed out: background sync stops immediately
      return;
    }
    let cancelled = false;
    const db = new MunniDB(identityDbName(identityKey(identity)));
    const syncing = identity.kind === 'user';

    let engine: SyncEngine | null = null;
    const repo = new Repo(db, getClock(), {
      trackOutbox: syncing, // demo/offline never sync — no outbox
      onWrite: () => engine?.nudge(),
    });
    if (syncing) {
      const key = identityKey(identity);
      const backend = new ApiSyncBackend({
        baseUrl: config.apiUrl,
        getAuth: async () => {
          if (identity.testAuth) {
            mirrorSessionForSw({ apiUrl: config.apiUrl, identityKey: key, testSub: identity.sub });
            return { testSub: identity.sub };
          }
          const bearer = await getAccessToken();
          // mirror the fresh token for the worker's background sync
          // (push-triggered pull + Android outbox flush, app killed)
          if (bearer) {
            mirrorSessionForSw({
              apiUrl: config.apiUrl,
              identityKey: key,
              bearer,
              expiresAt: jwtExpiryMs(bearer) ?? Date.now() + 10 * 60_000,
            });
          }
          return { bearer };
        },
      });
      engine = new SyncEngine(db, repo, backend, getDeviceId());
      // pushes failing (offline / server away) — arm the background
      // flush so the outbox drains even if the app is killed meanwhile
      engine.onStatus((status) => {
        if (status === 'offline' || status === 'error') requestOutboxSync();
      });
    }

    void (async () => {
      // ask the browser not to evict our data (iOS 7-day ITP wipe etc.);
      // best-effort — installed PWAs are exempt anyway
      if (identity.kind !== 'demo') void navigator.storage?.persist?.().catch(() => undefined);
      if (identity.kind === 'demo') await seedDemoIfNeeded(repo);
      if (identity.kind === 'offline' && (await db.spaces.filter((s) => s.deleted === 0).count()) === 0) {
        // fully local profile: personal space named after the profile
        const { offlineProfileName } = await import('@/features/auth/offlineProfiles');
        const personalId = uuidv7();
        await repo.upsert('space', personalId, personalId, {
          name: offlineProfileName(identity.profileId) ?? 'Personal',
          kind: 'personal',
          currency: 'EUR',
          periodType: 'month',
          periodDay: 1,
        });
      }
      if (engine) {
        // wait out the OIDC session restore, then fail-closed bootstrap
        await waitForAuthReady();
        if (cancelled) return;
        await bootstrapUserSpaces(db, repo, engine, () => cancelled, undefined, (n) => {
          if (!cancelled) setFailedAttempts(n);
        });
        if (cancelled) return;
        setFailedAttempts(0);
        engine.start();
      }
      const stored = (await db.meta.get(ACTIVE_SPACE_KEY))?.value as string | undefined;
      const spaces = await db.spaces.filter((s) => s.deleted === 0).toArray();
      const spaceId = spaces.find((s) => s.id === stored)?.id ?? spaces[0]?.id;
      if (!spaceId) throw new Error('no space available after seed');
      if (!cancelled) setState({ db, repo, spaceId, engine });
    })().catch((err) => {
      // StrictMode double-mount closes the first db mid-seed — expected
      if (!cancelled) throw err;
    });
    return () => {
      cancelled = true;
      engine?.stop();
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
  if (!value) return <ConnectingScreen failedAttempts={failedAttempts} />;
  return <DataContext.Provider value={value}>{children}</DataContext.Provider>;
}

/**
 * Shown while the database opens (instant) or a brand-new device waits
 * for the server during bootstrap (can take a while offline) — the
 * message only appears once it's clearly the latter. After repeated
 * failed rounds the screen names the problem (broken API/proxy is a
 * config error, not a loading state) and offers a way out.
 */
function ConnectingScreen({ failedAttempts = 0 }: { failedAttempts?: number }) {
  const { t } = useLang();
  const logout = useSession((s) => s.logout);
  const [slow, setSlow] = useState(false);
  useEffect(() => {
    const timer = setTimeout(() => setSlow(true), 1_500);
    return () => clearTimeout(timer);
  }, []);
  const unreachable = failedAttempts >= 2;
  return (
    <div className="flex h-full flex-col items-center justify-center gap-3 text-ink-3" data-testid="data-loading">
      {slow && (
        <>
          <Icon name={unreachable ? 'cloud-alert' : 'cloud-sync-outline'} size={32} color="var(--m-ink-4)" />
          <p className="max-w-[280px] text-center text-[13px]" data-testid={unreachable ? 'connect-error' : undefined}>
            {unreachable ? t('sync.serverUnreachable') : t('sync.connecting')}
          </p>
          {unreachable && (
            <button
              onClick={() => void logout()}
              data-testid="connect-signout"
              className="m-tap mt-2 rounded-full border border-line bg-surface px-5 py-2 text-[13px] font-semibold text-ink"
            >
              {t('settings.signOut')}
            </button>
          )}
        </>
      )}
    </div>
  );
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
