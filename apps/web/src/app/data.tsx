import { createContext, useCallback, useContext, useEffect, useMemo, useState } from 'react';
import type { ReactNode } from 'react';
import { v7 as uuidv7 } from 'uuid';
import { useLang } from '@/i18n';
import { Icon } from '@/ui/Icon';
import { identityDbName } from '@/db/schema';
import type { StorageBackend } from '@/db/backend';
import { destroyStorage, openStorageBackend } from '@/db/openStore';
import { Repo } from '@/db/repo';
import { setPredictionCountry } from '@/domain/predictCategory';
import { getClock, getDeviceId } from '@/db/device';
import { seedDemoIfNeeded } from '@/db/seed';
import { ApiSyncBackend } from '@/sync/backend';
import { SyncEngine } from '@/sync/engine';
import { config } from './config';
import { requestOutboxSync } from './pwa';
import { clearSwSession, jwtExpiryMs, mirrorSessionForSw } from '@/lib/swBridge';
import { ensurePersistentStorage } from '@/lib/platform';
import { getAccessToken, waitForAuthReady } from './authToken';
import { identityKey, useSession } from './session';
import type { Identity } from './session';
import { DEFAULT_HISTORY_MONTHS, isoMonthsAgo } from '@/features/spaces/spaceDefaults';

const ACTIVE_SPACE_KEY = 'activeSpaceId';
/** id of a personal space this device created during bootstrap (self-heal marker) */
const BOOTSTRAP_SPACE_KEY = 'bootstrapSpaceId';

const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

/** the identity's non-deleted spaces */
const liveSpaces = async (store: StorageBackend) => (await store.allRows('space')).filter((s) => s.deleted === 0);

/**
 * First-run bootstrap for syncing identities — FAIL CLOSED: a personal
 * space is only ever created after the server CONFIRMED this account has
 * no spaces. Network/auth failures retry with backoff instead of
 * spawning an empty duplicate space (an early bug that stranded devices
 * on a blank copy). Existing local data always loads without a server.
 */
export async function bootstrapUserSpaces(
  store: StorageBackend,
  repo: Repo,
  engine: SyncEngine,
  isCancelled: () => boolean,
  baseRetryMs = 2_000,
  onAttemptFailed?: (attempt: number) => void,
): Promise<void> {
  const hasLocalSpaces = async () => (await liveSpaces(store)).length > 0;

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

  // a CANCELLED instance must never write: StrictMode/HMR double-mounts
  // run two bootstraps against the SAME database, and the stale one's
  // slow first sync used to re-set needsOnboarding AFTER the user had
  // already finished onboarding — ambushing the app mid-use
  if (isCancelled()) return;

  if (!(await hasLocalSpaces())) {
    // server confirmed: brand-new user — create the personal space once
    const personalId = uuidv7();
    await repo.upsert('space', personalId, personalId, {
      name: 'Personal',
      kind: 'personal',
      currency: 'EUR',
      periodType: 'month',
      periodDay: 1,
      historyStartDate: isoMonthsAgo(DEFAULT_HISTORY_MONTHS),
    });
    await store.metaPut(BOOTSTRAP_SPACE_KEY, personalId);
    // show the one-time onboarding (this device created the space)
    await store.metaPut('needsOnboarding', true);
    return;
  }

  // self-heal: if a bootstrap-created space is still empty while the
  // account's real spaces arrived (pre-fix duplicates), retire it
  const bootstrapId = (await store.metaGet(BOOTSTRAP_SPACE_KEY))?.value as string | undefined;
  if (!bootstrapId) return;
  const others = (await liveSpaces(store)).filter((s) => s.id !== bootstrapId).length;
  if (others === 0) return;
  const [txs, accounts, cats] = await Promise.all([
    store.countBySpace('transaction', bootstrapId),
    store.countBySpace('account', bootstrapId),
    store.countBySpace('category', bootstrapId),
  ]);
  if (txs === 0 && accounts === 0 && cats === 0) {
    await repo.remove('space', bootstrapId, bootstrapId);
  }
  await store.metaDelete(BOOTSTRAP_SPACE_KEY);
}

/** OIDC restore → fail-closed bootstrap → periodic sync (user identities) */
async function restoreAndSync(
  store: StorageBackend,
  repo: Repo,
  engine: SyncEngine,
  isCancelled: () => boolean,
  onAttempts: (n: number) => void,
): Promise<void> {
  await waitForAuthReady();
  if (isCancelled()) return;
  await bootstrapUserSpaces(store, repo, engine, isCancelled, undefined, onAttempts);
  if (isCancelled()) return;
  onAttempts(0);
  engine.start();
}

/** the sync stack of a signed-in user identity (token mirroring included) */
function buildSyncEngine(identity: Extract<Identity, { kind: 'user' }>, store: StorageBackend, repo: Repo): SyncEngine {
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
  return new SyncEngine(store, repo, backend, getDeviceId());
}

interface DataContextValue {
  /** the storage seam (E1) — all reads/writes go through this */
  store: StorageBackend;
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
  const [state, setState] = useState<{
    store: StorageBackend;
    repo: Repo;
    spaceId: string;
    engine: SyncEngine | null;
  } | null>(null);
  const [failedAttempts, setFailedAttempts] = useState(0);
  const [connectError, setConnectError] = useState<string | null>(null);

  useEffect(() => {
    if (!identity) {
      setState(null);
      clearSwSession(); // signed out: background sync stops immediately
      return;
    }
    let cancelled = false;
    const isCancelled = () => cancelled;
    const onAttempts = (n: number) => {
      if (!cancelled) {
        setFailedAttempts(n);
        setConnectError(engine?.lastError ?? null);
      }
    };
    let engine: SyncEngine | null = null;
    let openedStore: StorageBackend | null = null;

    void (async () => {
      // E2: the backend is chosen here — Dexie, or SQLCipher when the
      // native dev flag is on (openStore.ts) — hence the async open
      const store = await openStorageBackend(identityDbName(identityKey(identity)));
      if (cancelled) {
        store.close();
        return;
      }
      openedStore = store;
      const syncing = identity.kind === 'user';
      const repo = new Repo(store, getClock(), {
        trackOutbox: syncing, // demo/offline never sync — no outbox
        onWrite: () => engine?.nudge(),
      });
      if (syncing) {
        // operator catalog: cheap ETag revalidation, then apply any
        // tombstones exactly once per version — all fire-and-forget
        void (async () => {
          const { cachedCatalog, refreshCatalog } = await import('@/sync/catalogSync');
          await refreshCatalog(store);
          const { applyCatalogTombstones } = await import('@/application/catalogMaintenance');
          await applyCatalogTombstones(store, repo);
          // R9: operator-curated store fingerprints feed the receipt matcher
          const { setCatalogStorePatterns } = await import('@/domain/storeReceipts');
          setCatalogStorePatterns((await cachedCatalog(store))?.stores ?? []);
        })().catch(() => undefined);
        // reinstall gap: the Settings avatar reads the local profile copy —
        // hydrate it from /me when missing (fire-and-forget)
        void (async () => {
          const { hydrateProfileMeta } = await import('@/application/profileHydrate');
          await hydrateProfileMeta(store);
        })().catch(() => undefined);
        // receipts v2 → v3: fan-out rows become global rows + snapshot
        // links, once per identity (fire-and-forget, retried while offline)
        void (async () => {
          const { migrateLegacyReceipts } = await import('@/application/receiptsMigrate');
          await migrateLegacyReceipts(store, repo);
        })().catch(() => undefined);
        engine = buildSyncEngine(identity, store, repo);
        // pushes failing (offline / server away) — arm the background
        // flush so the outbox drains even if the app is killed meanwhile
        engine.onStatus((status) => {
          if (status === 'offline' || status === 'error') requestOutboxSync();
        });
        // remote-wipe: if this account was deleted (or went offline) on
        // ANOTHER device, the /me binding mismatch wipes this copy too
        void enforceAccountBinding(store, identity).catch(() => undefined);
        // remote disconnect (logged-in devices, user ruling: disconnect =
        // wipe): the api choke point saw a 410 device-revoked — erase
        // this copy exactly like the binding wipe would
        revokedWipeIdentity = identity;
        globalThis.removeEventListener('munni:device-revoked', onDeviceRevoked);
        globalThis.addEventListener('munni:device-revoked', onDeviceRevoked);
      }

      // ask the browser not to evict our data (iOS 7-day ITP wipe etc.);
      // best-effort — installed PWAs are exempt, native storage is app-scoped
      if (identity.kind !== 'demo') void ensurePersistentStorage();
      if (identity.kind === 'demo') await seedDemoIfNeeded(repo);
      // reimbursement redesign: legacy NET slices become gross + an
      // explicit reimbursed slice, once per identity (marker-gated;
      // ALL identities — demo/offline data migrates too)
      void (async () => {
        const { migrateReimbursementSlices, migrateUnlinkedTransferKinds } = await import('@/application/catalogMaintenance');
        await migrateReimbursementSlices(store, repo);
        // kind simplification: counterparty-less transfer-family rows
        // become plain income/expense by sign (marker-gated, all identities)
        await migrateUnlinkedTransferKinds(store, repo);
      })().catch(() => undefined);
      if (identity.kind === 'offline' && (await liveSpaces(store)).length === 0) {
        // fully local profile: personal space named after the profile
        const { offlineProfileName } = await import('@/features/auth/offlineProfiles');
        const personalId = uuidv7();
        await repo.upsert('space', personalId, personalId, {
          name: offlineProfileName(identity.profileId) ?? 'Personal',
          kind: 'personal',
          currency: 'EUR',
          periodType: 'month',
          periodDay: 1,
          historyStartDate: isoMonthsAgo(DEFAULT_HISTORY_MONTHS),
        });
        // offline users get the same first-run setup (user ruling)
        await store.metaPut('needsOnboarding', true);
      }
      // country of use tunes the category predictor (onboarding stores it)
      {
        const profile = (await store.metaGet('profile'))?.value as { country?: string } | undefined;
        setPredictionCountry(profile?.country);
      }
      if (engine) {
        const eng = engine;
        const finishSync = () => restoreAndSync(store, repo, eng, isCancelled, onAttempts);
        if ((await liveSpaces(store)).length > 0) {
          // returning device: local-first — render from what's stored NOW;
          // auth restore + first sync catch up in the background. A dead
          // server or unreachable OIDC endpoint must never block the UI
          // (it did: a hanging fetch kept users on the connecting screen
          // despite a fully usable local database).
          void finishSync().catch(() => undefined);
        } else {
          // brand-new device: nothing to show — wait for the server to
          // confirm the account state (fail-closed bootstrap)
          await finishSync();
        }
      }
      const stored = (await store.metaGet(ACTIVE_SPACE_KEY))?.value as string | undefined;
      const spaces = await liveSpaces(store);
      const spaceId = spaces.find((s) => s.id === stored)?.id ?? spaces[0]?.id;
      if (!spaceId) throw new Error('no space available after seed');
      if (!cancelled) setState({ store, repo, spaceId, engine });
    })().catch((err) => {
      // StrictMode double-mount closes the first db mid-seed — expected
      if (!cancelled) throw err;
    });
    return () => {
      cancelled = true;
      engine?.stop();
      openedStore?.close();
    };
  }, [identity]);

  const setActiveSpace = useCallback(
    async (spaceId: string) => {
      if (!state) return;
      await state.store.metaPut(ACTIVE_SPACE_KEY, spaceId);
      setState((prev) => (prev ? { ...prev, spaceId } : prev));
    },
    [state],
  );

  const value = useMemo(() => (state ? { ...state, setActiveSpace } : null), [state, setActiveSpace]);

  if (!identity) return null;
  if (!value) return <ConnectingScreen failedAttempts={failedAttempts} errorDetail={connectError} />;
  return <DataContext.Provider value={value}>{children}</DataContext.Provider>;
}

/**
 * Shown while the database opens (instant) or a brand-new device waits
 * for the server during bootstrap (can take a while offline) — the
 * message only appears once it's clearly the latter. After repeated
 * failed rounds the screen names the problem (broken API/proxy is a
 * config error, not a loading state) and offers a way out.
 */
function ConnectingScreen({ failedAttempts = 0, errorDetail }: { failedAttempts?: number; errorDetail?: string | null }) {
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
          {unreachable && errorDetail && (
            <p className="max-w-[280px] text-center font-mono text-[10px] break-words text-ink-4" data-testid="connect-error-detail">
              {errorDetail}
            </p>
          )}
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
/** remote-wipe enforcement: mismatch → wipe this device + back to login */
// remote disconnect (user ruling: disconnect = wipe): the api choke
// point saw a 410 device-revoked — erase this copy exactly like the
// account-binding wipe would. One module-level listener; the identity
// it wipes follows the active DataProvider.
let revokedWipeIdentity: Identity | null = null;

async function wipeRevokedDevice(identity: Identity): Promise<void> {
  const { useSession } = await import('./session');
  useSession.getState().logout();
  await destroyIdentityData(identity);
  globalThis.location.assign('/#/login');
}

function onDeviceRevoked(): void {
  if (revokedWipeIdentity) void wipeRevokedDevice(revokedWipeIdentity).catch(() => undefined);
}

async function enforceAccountBinding(store: StorageBackend, identity: Identity): Promise<void> {
  const { verifyAccountBinding } = await import('@/features/auth/accountBinding');
  await verifyAccountBinding(store, identity, async () => {
    const { useSession } = await import('./session');
    useSession.getState().logout();
    await destroyIdentityData(identity);
    globalThis.location.assign('/#/login');
  });
}

export async function destroyIdentityData(identity: Identity): Promise<void> {
  await destroyStorage(identityDbName(identityKey(identity)));
}
