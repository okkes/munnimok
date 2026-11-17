import { createContext, useCallback, useContext, useEffect, useMemo, useState } from 'react';
import type { ReactNode } from 'react';
import type { Span } from '@sentry/react';
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
import type { SyncStatus } from '@/sync/engine';
import { SpaceAccess } from '@/sync/spaceAccess';
import { config } from './config';
import { requestOutboxSync } from './pwa';
import { clearSwSession, jwtExpiryMs, mirrorSessionForSw } from '@/lib/swBridge';
import { measure, tagSpacePeriod } from '@/lib/perf';
import { ensurePersistentStorage } from '@/lib/platform';
import { disablePush } from '@/lib/push';
import { authWaits, getAccessToken, oidcSignIn, waitForAuthReady } from './authToken';
import { BOOT_STEPS, bootStepText, useBootStep } from './bootStep';
import { LOGTO_WIPE_KEY, clearStaleLogtoState } from '@/lib/authState';
import { clearQueryCache } from '@/db/useQuery';
import { forgetNavCache } from '@/features/navigation/navCache';
import { adoptedStoreKeys } from '@/features/auth/offlineProfiles';
import { identityKey, useSession } from './session';
import type { Identity } from './session';
import { useEvicted } from './evicted';

const ACTIVE_SPACE_KEY = 'activeSpaceId';

const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

const liveSpaces = async (store: StorageBackend) => (await store.allRows('space')).filter((s) => s.deleted === 0);

/** fail closed: network/auth failures retry with backoff, never spawn an empty duplicate space;
 * local data loads without a server */
export async function bootstrapUserSpaces(
  store: StorageBackend,
  engine: SyncEngine,
  isCancelled: () => boolean,
  baseRetryMs = 2_000,
  onAttemptFailed?: (attempt: number) => void,
): Promise<void> {
  const hasLocalSpaces = async () => (await liveSpaces(store)).length > 0;

  for (let attempt = 0; ; attempt++) {
    await engine.syncAll().catch(() => undefined);
    // the round, not the status: a refused token leaves the status idle while the server confirmed nothing
    if (engine.lastRoundOk()) break; // server confirmed our spaces
    if (await hasLocalSpaces()) return; // offline but usable — local-first
    // brand-new device with nothing local: keep trying (capped backoff) and tell the UI, so a broken server is visible
    onAttemptFailed?.(attempt + 1);
    await sleep(Math.min(baseRetryMs * 2 ** attempt, baseRetryMs * 8));
    if (isCancelled()) return;
  }

  // a cancelled instance must never write: a StrictMode/HMR double-mount's stale bootstrap
  // re-set needsOnboarding after onboarding finished
  if (isCancelled()) return;

  if (!(await hasLocalSpaces())) {
    // a confirmed brand-new user gets no space (the Mina tutorial's create-step provides one); any Mina marker means the
    // first-run is owned, so this does not re-fire on every start (the ambush bug)
    if (!(await minaMarkerExists(store))) {
      await store.metaPut('needsOnboarding', true);
      await store.metaPut('minaTutorialPending', true);
    }
  }
}

async function minaMarkerExists(store: StorageBackend): Promise<boolean> {
  for (const key of ['minaTutorialPending', 'minaTutorialState', 'minaTutorialDone']) {
    if ((await store.metaGet(key))?.value) return true;
  }
  return false;
}

/** zero spaces is legal only while the Mina tutorial owns the first-run; anything else is a hard bug */
async function minaOwnsFirstRun(store: StorageBackend): Promise<boolean> {
  if ((await store.metaGet('minaTutorialPending'))?.value) return true;
  const state = (await store.metaGet('minaTutorialState'))?.value as { active?: boolean } | undefined;
  return !!state?.active;
}

async function restoreAndSync(
  store: StorageBackend,
  engine: SyncEngine,
  isCancelled: () => boolean,
  onAttempts: (n: number) => void,
): Promise<void> {
  const at = useBootStep.getState().set;
  at({ step: 'signin' });
  await waitForAuthReady();
  if (isCancelled()) return;
  // only the first round says where it stands: later ones have a whole app to show for themselves
  const off = engine.onProgress((p) => at(p.phase === 'server' ? { step: 'server' } : { step: 'spaces', done: p.done, total: p.total, changes: p.changes }));
  try {
    await bootstrapUserSpaces(store, engine, isCancelled, undefined, onAttempts);
  } finally {
    off();
  }
  if (isCancelled()) return;
  onAttempts(0);
  engine.start();
}

/** whether the first sync round of this boot reached its end; the heals wait for it:
 * a one-way fold on a copy older than the server's overwrites other devices */
export function firstRoundOf(engine: SyncEngine): { finished: Promise<boolean>; release: () => void } {
  let settle: (ok: boolean) => void = () => undefined;
  const finished = new Promise<boolean>((resolve) => {
    settle = resolve;
  });
  const off = engine.onStatus((status) => {
    if (status === 'syncing') return;
    off();
    // idle alone proves nothing: a refused token ends idle as well
    settle(status === 'idle' && engine.lastRoundOk());
  });
  return {
    finished,
    release: () => {
      off();
      settle(false);
    },
  };
}

/** an identity that never syncs holds the only copy there is: confirmed at once */
function copyConfirmedBy(engine: SyncEngine | null): { finished: Promise<boolean>; release: () => void } {
  return engine ? firstRoundOf(engine) : { finished: Promise.resolve(true), release: () => undefined };
}

function healOnceKnown(copyConfirmed: Promise<boolean>, cancelled: () => boolean, store: StorageBackend, upkeep: Repo): Promise<unknown> {
  return copyConfirmed
    .then((confirmed) => (cancelled() ? undefined : measure('app.boot.heal', () => bootHeals(store, upkeep, confirmed), undefined, { parent: null })))
    .catch(() => undefined);
}

/** the every-boot heals, in order; the one-way folds only on a copy the server confirmed in this boot */
async function bootHeals(store: StorageBackend, upkeep: Repo, confirmed: boolean): Promise<void> {
  // #228: reimbursement on a split transaction stays on the split
  const { normalizeReimbursements } = await import('@/application/catalogMaintenance');
  await normalizeReimbursements(store, upkeep);
  // #546: the retired family defaults leave their spaces; a default pulled later retires on the next boot
  const { retireDefaultAccounts } = await import('@/application/defaultAccounts');
  if (confirmed) await retireDefaultAccounts(store, upkeep);
  // #544: rows still naming an account their space lost let go of it
  const { repairDanglingCounterparties } = await import('@/application/accountRelease');
  if (confirmed) await repairDanglingCounterparties(store, upkeep);
  // #133/#546: bare movement rows link the account their text names (the ATM pair: the cash wallet); every boot, as the server
  // keeps writing predicted movement categories. #574: a "Transfer out/in" to a cash wallet re-files as the ATM pair
  const { migrateBareSpecialRows, refileCashTransfers } = await import('@/application/categoryModel');
  // its leg shares an id with the leg another device minted for the same row: on an old copy it moves a second balance
  if (confirmed) await migrateBareSpecialRows(store, upkeep);
  if (confirmed) await refileCashTransfers(store, upkeep);
  // #509: a loan typed at its original amount counts every payment linked to it, its date's included
  const { settlePristineLoans } = await import('@/application/loanBalance');
  if (confirmed) await settlePristineLoans(store, upkeep);
  // the recurring owns the category: a linked row a fetch's overlay re-filed takes it back every boot
  const { realignRecurringCategories } = await import('@/application/recurring');
  await realignRecurringCategories(store, upkeep);
  // transfers are one event with two legs: paired within each space's books, never across (funding covers that)
  const { linkTransferPairs } = await import('@/application/transferMatch');
  await linkTransferPairs(store, upkeep);
  // #533: a reserved charge the bank booked hands its story to the booked row
  const { carryReservedOpinions } = await import('@/application/reservedCarry');
  await carryReservedOpinions(store, upkeep);
  // #578: the keys recurrings, loans and dismissals stored follow the merchant key's new spelling, once
  const { rekeyMerchantKeys } = await import('@/application/merchantKeyRekey');
  await rekeyMerchantKeys(store, upkeep);
  // #630: a photo or an invoice still inside its receipt moves out — on any copy: the change is stamped right behind
  // the value it replaces, and the server has written the same one
  const { splitReceiptFiles } = await import('@/application/receiptFiles');
  await splitReceiptFiles(store, upkeep);
}

async function startFirstSync(
  store: StorageBackend,
  engine: SyncEngine,
  isCancelled: () => boolean,
  onAttempts: (n: number) => void,
  boot: Span,
): Promise<void> {
  const finishSync = () => restoreAndSync(store, engine, isCancelled, onAttempts);
  if ((await liveSpaces(store)).length > 0) {
    // returning device: render from what is stored now, auth restore and first sync catch up;
    // a hanging server must never block the UI
    void finishSync().catch(() => undefined);
  } else {
    boot.setAttribute('boot.waited_for_server', true);
    await finishSync();
  }
}

function buildSyncEngine(identity: Extract<Identity, { kind: 'user' }>, store: StorageBackend, repo: Repo, access: SpaceAccess): SyncEngine {
  const key = identityKey(identity);
  const backend = new ApiSyncBackend({
    baseUrl: config.apiUrl,
    getAuth: async () => {
      if (identity.testAuth) {
        mirrorSessionForSw({ apiUrl: config.apiUrl, identityKey: key, testSub: identity.sub });
        return { testSub: identity.sub };
      }
      const bearer = await getAccessToken();
      // mirrored for the worker's background sync (push-triggered pull, Android outbox flush with the app killed)
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
  // "Go offline" in another tab hands this store to a profile: from then on it is not this account's to sync or purge
  return new SyncEngine(store, repo, backend, getDeviceId(), { access, frozen: () => adoptedStoreKeys().has(key) });
}

function onEngineStatus(status: SyncStatus, store: StorageBackend, upkeep: Repo): void {
  // failing pushes arm the background flush, so the outbox drains even if the app is killed
  if (status === 'offline' || status === 'error') requestOutboxSync();
  // #533: a cycle that pulled a booking hands the reserved row's story on
  if (status === 'idle') {
    void import('@/application/reservedCarry')
      .then(({ carryReservedOpinionsWhenDue }) => carryReservedOpinionsWhenDue(store, upkeep))
      // #547: then the bank's version of what was typed by hand — after the carry, which moves a link from a reserved row to its booking
      .then(() => import('@/application/entryLink'))
      .then(({ linkEntriesAfterSync }) => linkEntriesAfterSync(store, upkeep))
      .catch(() => undefined);
  }
}

interface DataContextValue {
  store: StorageBackend;
  repo: Repo;
  spaceId: string;
  setActiveSpace: (spaceId: string) => Promise<void>;
  /** present only for syncing (user) identities */
  engine: SyncEngine | null;
  /** #505: this identity's role per space — read through useCanEdit */
  access: SpaceAccess;
}

const DataContext = createContext<DataContextValue | null>(null);

export function DataProvider({ children }: { children: ReactNode }) {
  const identity = useSession((s) => s.identity);
  const [state, setState] = useState<{
    store: StorageBackend;
    repo: Repo;
    spaceId: string;
    engine: SyncEngine | null;
    access: SpaceAccess;
  } | null>(null);
  const [failedAttempts, setFailedAttempts] = useState(0);
  const [connectError, setConnectError] = useState<string | null>(null);

  useEffect(() => {
    if (!identity) {
      setState(null);
      clearSwSession();
      return;
    }
    // an identity that never syncs leaves the worker nothing to do: the mirror of the account before it must go
    if (identity.kind !== 'user') clearSwSession();
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
    let releaseHeals: () => void = () => undefined;
    // #363: the remount cache is per identity; a sign-in after a wipe must never seed a screen with the last user's rows
    clearQueryCache();
    useBootStep.getState().set({ step: 'opening' });

    // boot span (docs/observability.md): store open to first screen; identity kind and space count ride along, never an id
    void measure('app.boot', async (boot) => {
      boot.setAttribute('boot.identity', identity.kind);
      // the backend is chosen here: Dexie, or SQLCipher with the native dev flag (openStore.ts)
      const store = await measure('app.boot.open', () => openStorageBackend(identityDbName(identityKey(identity))), undefined, { parent: boot });
      if (cancelled) {
        store.close();
        boot.setAttribute('boot.cancelled', true);
        return;
      }
      openedStore = store;
      liveStore = store;
      const syncing = identity.kind === 'user';
      // #505: the roles the server named last, known before the first write, so a reader's space refuses writes offline too
      const access = new SpaceAccess(syncing ? store : null);
      await access.hydrate();
      const repo = new Repo(store, getClock(), {
        trackOutbox: syncing, // demo/offline never sync — no outbox
        onWrite: () => engine?.nudge(),
        readOnly: (spaceId) => access.isReadOnly(spaceId),
      });
      // the app's own upkeep leaves the spaces this identity only reads alone
      const upkeep = repo.upkeep();
      if (syncing) {
        // operator catalog: ETag revalidation, tombstones applied once per version; fire-and-forget
        void (async () => {
          const { cachedCatalog, refreshCatalog } = await import('@/sync/catalogSync');
          await refreshCatalog(store);
          const { applyCatalogTombstones } = await import('@/application/catalogMaintenance');
          await applyCatalogTombstones(store, upkeep);
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
        engine = buildSyncEngine(identity, store, repo, access);
        engine.onStatus((status) => onEngineStatus(status, store, upkeep));
        // remote wipe: an account deleted or taken offline on another device wipes this copy (the /me binding mismatch)
        void enforceAccountBinding(store, identity).catch(() => undefined);
        // remote disconnect = wipe: a 410 device-revoked at the api choke point erases this copy like the binding wipe
        revokedWipeIdentity = identity;
        globalThis.removeEventListener('munni:device-revoked', onDeviceRevoked);
        globalThis.addEventListener('munni:device-revoked', onDeviceRevoked);
      }

      // ask the browser not to evict our data (iOS 7-day ITP wipe etc.);
      // best-effort — installed PWAs are exempt, native storage is app-scoped
      if (identity.kind !== 'demo') void ensurePersistentStorage();
      if (identity.kind === 'demo') await measure('app.boot.seed', () => seedDemoIfNeeded(repo), undefined, { parent: boot });
      // the every-boot heals run for all identities, through the upkeep view (#505: a read-only space is healed by its writers)
      // they wait for the first round: a one-way fold on an unconfirmed copy undoes another device's work
      // a non-syncing identity holds the only copy
      const firstRound = copyConfirmedBy(engine);
      releaseHeals = firstRound.release;
      const bootChain = healOnceKnown(firstRound.finished, () => cancelled, store, upkeep);
      // test seam: tests drain this before deleting the database, else a previous boot's chain
      // boots the next app on a dying handle
      if (import.meta.env.VITEST) (globalThis as { __munniBootChain?: Promise<unknown> }).__munniBootChain = bootChain;
      void bootChain;
      // bank-connect completions attach server-side from an anonymous page: mirror any link no device saw being made
      if (identity.kind === 'user') void mirrorSpaceLinks(store, upkeep).catch(() => undefined);
      if (identity.kind === 'offline' && (await liveSpaces(store)).length === 0) {
        // fully local profile: the same Mina flow as online, no auto-created space
        await store.metaPut('needsOnboarding', true);
        await store.metaPut('minaTutorialPending', true);
      }
      {
        const profile = (await store.metaGet('profile'))?.value as { country?: string } | undefined;
        setPredictionCountry(profile?.country);
      }
      if (engine) await startFirstSync(store, engine, isCancelled, onAttempts, boot);
      const stored = (await store.metaGet(ACTIVE_SPACE_KEY))?.value as string | undefined;
      const spaces = await liveSpaces(store);
      const spaceId = spaces.find((s) => s.id === stored)?.id ?? spaces[0]?.id;
      boot.setAttribute('boot.spaces', spaces.length);
      tagSpacePeriod(spaces.find((s) => s.id === spaceId)?.periodType);
      if (!spaceId && !(await minaOwnsFirstRun(store))) throw new Error('no space available after seed');
      if (!cancelled) setState({ store, repo, spaceId: spaceId ?? '', engine, access });
    }).catch((err) => {
      // StrictMode double-mount closes the first db mid-seed — expected
      if (!cancelled) throw err;
    });
    return () => {
      cancelled = true;
      releaseHeals();
      engine?.stop();
      openedStore?.close();
      if (liveStore === openedStore) liveStore = null;
    };
  }, [identity]);

  const setActiveSpace = useCallback(
    async (spaceId: string) => {
      if (!state) return;
      await state.store.metaPut(ACTIVE_SPACE_KEY, spaceId);
      tagSpacePeriod((await state.store.get('space', spaceId))?.periodType);
      setState((prev) => (prev ? { ...prev, spaceId } : prev));
    },
    [state],
  );

  // #173: an eviction of the active space hops to a surviving one at once; before, screens read undefined until the next boot
  const evicted = useEvicted((s) => s.evicted);
  useEffect(() => {
    if (!evicted || !state || evicted.spaceId !== state.spaceId) return;
    void (async () => {
      const next = (await liveSpaces(state.store)).find((s) => s.id !== evicted.spaceId);
      if (next) {
        useEvicted.getState().markSwitched(next.name);
        await setActiveSpace(next.id);
      }
    })();
  }, [evicted, state, setActiveSpace]);

  const value = useMemo(() => (state ? { ...state, setActiveSpace } : null), [state, setActiveSpace]);

  if (!identity) return null;
  if (!value) return <ConnectingScreen failedAttempts={failedAttempts} errorDetail={connectError} />;
  return <DataContext.Provider value={value}>{children}</DataContext.Provider>;
}

async function mirrorSpaceLinks(store: StorageBackend, repo: Repo): Promise<void> {
  const { reconcileSpaceLinks } = await import('@/application/accountAttach');
  for (const space of await liveSpaces(store)) {
    await reconcileSpaceLinks(store, repo, space.id).catch(() => undefined);
  }
}

// the connecting screen names a broken API/proxy after repeated failed rounds
// (a config error, not a loading state) and offers a way out
const REHEAL_KEY = 'munni_auth_reheal';

/** how long the connecting screen stays calm, and how long its diagnosis waits for the server (a test seam) */
export const connectTuning = { patienceMs: 20_000, probeMs: 10_000 };

const STEP_LABEL = {
  opening: 'sync.step.opening',
  signin: 'sync.step.signin',
  server: 'sync.step.server',
  spaces: 'sync.step.spaces',
} as const;

function BootSteps() {
  const { t } = useLang();
  const at = useBootStep((s) => s.at);
  const now = BOOT_STEPS.indexOf(at.step);
  return (
    <ol className="flex w-[260px] max-w-[80vw] list-none flex-col gap-1.5 p-0 text-left text-[12px]" data-testid="connect-steps">
      {BOOT_STEPS.map((step, index) => {
        let state: 'done' | 'now' | 'ahead' = 'ahead';
        if (index < now) state = 'done';
        else if (index === now) state = 'now';
        const icons = { done: 'check-circle', now: 'progress-clock', ahead: 'circle-outline' } as const;
        return (
          <li key={step} data-step={step} data-state={state} className={`flex items-center gap-2 ${state === 'ahead' ? 'text-ink-4' : 'text-ink-2'}`}>
            <Icon name={icons[state]} size={15} color={state === 'done' ? 'var(--m-accent-deep)' : 'var(--m-ink-4)'} />
            <span className={state === 'now' ? 'font-semibold' : ''}>
              {t(STEP_LABEL[step])}
              {step === 'spaces' && at.step === 'spaces' && at.total > 0 && ` — ${t('sync.step.count', { done: at.done, total: at.total })}`}
              {step === 'spaces' && at.step === 'spaces' && at.changes > 0 && ` · ${t('sync.step.changes', { count: at.changes })}`}
            </span>
          </li>
        );
      })}
    </ol>
  );
}

function ConnectingScreen({ failedAttempts = 0, errorDetail }: { failedAttempts?: number; errorDetail?: string | null }) {
  const { t } = useLang();
  const logout = useSession((s) => s.logout);
  const identity = useSession((s) => s.identity);
  const signOut = () => {
    // this screen means the server is out of reach or refuses: only the device can let go of its notifications
    if (identity?.kind === 'user') void disablePush({ server: false }).catch(() => undefined);
    logout();
  };
  // self-heal (iOS 401): a signed-in user with 401s and no mintable token lost the client Logto keys
  // while the IdP cookie lives; a silent re-sign-in re-mints them. Capped per tab so a dead IdP session cannot loop
  useEffect(() => {
    if (identity?.kind !== 'user' || identity.testAuth) return;
    if (!(errorDetail ?? '').includes('401')) return;
    void (async () => {
      if (await getAccessToken()) {
        sessionStorage.removeItem(REHEAL_KEY); // tokens mint — the 401 is not evicted state
        return;
      }
      const attempts = Number(sessionStorage.getItem(REHEAL_KEY) ?? '0');
      if (attempts >= 2) return;
      sessionStorage.setItem(REHEAL_KEY, String(attempts + 1));
      const { callbackUri } = await import('@/features/auth/logto');
      if (!(await oidcSignIn(callbackUri()))) sessionStorage.removeItem(REHEAL_KEY);
    })();
  }, [identity, errorDetail]);
  const [slow, setSlow] = useState(false);
  useEffect(() => {
    const timer = setTimeout(() => setSlow(true), 1_500);
    return () => clearTimeout(timer);
  }, []);
  // 401s during a fresh sign-in settle on their own, and "can't reach the server" at a new user got Sign out clicked;
  // but patience ends: on iOS the 401s never settled and the screen sat forever, so past 20 s the truth wins
  const [patienceOver, setPatienceOver] = useState(false);
  useEffect(() => {
    const timer = setTimeout(() => setPatienceOver(true), connectTuning.patienceMs);
    return () => clearTimeout(timer);
  }, []);
  const authSettling = (errorDetail ?? '').includes('401') && !patienceOver;
  const unreachable = (failedAttempts >= 2 && !authSettling) || (patienceOver && failedAttempts >= 1);
  // #594: nothing failed because nothing ever answered — the exits are owed all the same
  const waiting = patienceOver && failedAttempts === 0;
  const exits = unreachable || waiting;
  // the stuck platform is iOS-only, where DevTools are out of reach: a built-in probe produces a copyable report
  const [report, setReport] = useState<string | null>(null);
  const diagnose = async () => {
    // key suffixes only, never values: tells "exchange never persisted" from "refresh gone" from "signInSession stranded"
    const logtoSuffixes = (store: Storage) => {
      const names = Object.keys(store)
        .filter((k) => k.startsWith('logto:'))
        .map((k) => k.split(':').pop() ?? '');
      return names.join(',') || '-';
    };
    const lines = [
      `build: v${__APP_VERSION__} (${String(__BUILD_NUMBER__)})`,
      `ua: ${navigator.userAgent}`,
      `standalone: ${window.matchMedia?.('(display-mode: standalone)')?.matches ?? false}`,
      `online: ${navigator.onLine}`,
      `sw: ${navigator.serviceWorker?.controller ? 'controlling' : 'none'}`,
      `session: ${identity?.kind ?? 'absent'}`,
      `logtoKeys: ${Object.keys(localStorage).filter((k) => k.startsWith('logto:')).length}`,
      `logtoLs: ${logtoSuffixes(localStorage)}`,
      `logtoSs: ${logtoSuffixes(sessionStorage)}`,
      `lsKeys: ${Object.keys(localStorage).length} ssKeys: ${Object.keys(sessionStorage).length}`,
      `lastLogtoWipe: ${localStorage.getItem(LOGTO_WIPE_KEY) ?? '-'}`,
      `rehealAttempts: ${sessionStorage.getItem(REHEAL_KEY) ?? '0'}`,
      `lastError: ${errorDetail ?? '-'}`,
      `waitingAt: ${bootStepText(useBootStep.getState().at)}`,
      `restore: ${authWaits().restore} tokenMint: ${authWaits().mint}`,
    ];
    try {
      localStorage.setItem('munni_probe', '1');
      const ok = localStorage.getItem('munni_probe') === '1';
      localStorage.removeItem('munni_probe');
      lines.push(`lsWrite: ${ok}`);
    } catch (err) {
      const detail = err instanceof Error ? err.name : String(err);
      lines.push(`lsWrite threw: ${detail}`);
    }
    // the definitive probe: can the auth SDK mint a token at all? (iOS field report: logtoKeys 0, client auth storage evicted)
    try {
      const token = await getAccessToken();
      const state = token ? `present (${token.length} chars)` : 'ABSENT';
      lines.push(`accessToken: ${state}`);
    } catch (err) {
      const detail = err instanceof Error ? `${err.name}: ${err.message}` : String(err);
      lines.push(`accessToken threw: ${detail}`);
    }
    try {
      const { apiFetch } = await import('@/lib/api');
      // a server that never answers is a finding too: the report does not wait for it
      const res = await Promise.race([apiFetch('/me'), new Promise<null>((resolve) => setTimeout(() => resolve(null), connectTuning.probeMs))]);
      if (res) lines.push(`GET /me: ${res.status}`, `www-authenticate: ${res.headers.get('www-authenticate') ?? '-'}`);
      else lines.push(`GET /me: no answer in ${connectTuning.probeMs / 1000} s`);
    } catch (err) {
      const detail = err instanceof Error ? `${err.name}: ${err.message}` : String(err);
      lines.push(`GET /me threw: ${detail}`);
    }
    setReport(lines.join('\n'));
  };
  return (
    <div className="flex h-full flex-col items-center justify-center gap-3 text-ink-3" data-testid="data-loading">
      {slow && (
        <>
          <Icon name={unreachable ? 'cloud-alert' : 'cloud-sync-outline'} size={32} color="var(--m-ink-4)" />
          <p className="max-w-[280px] text-center text-[13px]" data-testid={unreachable ? 'connect-error' : undefined}>
            {unreachable ? t('sync.serverUnreachable') : t('sync.connecting')}
          </p>
          <BootSteps />
          {waiting && (
            <p className="max-w-[280px] text-center text-[12px] text-warning" data-testid="connect-waiting">
              {t('sync.stillWaiting')}
            </p>
          )}
          {unreachable && errorDetail && (
            <p className="max-w-[280px] text-center font-mono text-[10px] break-words text-ink-4" data-testid="connect-error-detail">
              {errorDetail}
            </p>
          )}
          {exits && (
            <div className="flex items-center gap-2">
              <button
                onClick={signOut}
                data-testid="connect-signout"
                className="m-tap mt-2 rounded-full border border-line bg-surface px-5 py-2 text-[13px] font-semibold text-ink"
              >
                {t('settings.signOut')}
              </button>
              <button
                onClick={() => void diagnose()}
                data-testid="connect-diagnose"
                className="m-tap mt-2 rounded-full border border-line bg-surface px-5 py-2 text-[13px] font-semibold text-ink"
              >
                {t('sync.diagnose')}
              </button>
            </div>
          )}
          {report && (
            <textarea
              readOnly
              data-testid="connect-diagnose-report"
              value={report}
              rows={8}
              className="mt-2 w-[300px] max-w-[86vw] rounded-input border border-line bg-surface p-2 font-mono text-[10px] text-ink-2"
              onFocus={(e) => e.currentTarget.select()}
            />
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

// one module-level listener; the identity it wipes follows the active DataProvider
let revokedWipeIdentity: Identity | null = null;

async function wipeRevokedDevice(identity: Identity): Promise<void> {
  const { useSession } = await import('./session');
  // the server refuses this device already: asking it again would raise the disconnect once more
  void disablePush({ server: false }).catch(() => undefined);
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
    // the account is gone from the server: its notifications end on the device alone
    void disablePush({ server: false }).catch(() => undefined);
    useSession.getState().logout();
    await destroyIdentityData(identity);
    globalThis.location.assign('/#/login');
  });
}

/** the store the provider currently holds open — the wipe closes it first */
let liveStore: StorageBackend | null = null;

export async function destroyIdentityData(identity: Identity): Promise<void> {
  // #363: an open connection blocks the database delete, and wiped accounts greeted the next sign-up: close the live handle,
  // forget cached rows, verify the delete (destroyStorage throws when the database survived)
  liveStore?.close();
  liveStore = null;
  clearQueryCache();
  await destroyStorage(identityDbName(identityKey(identity)));
  // the Logto client state of a dead account is dead too
  clearStaleLogtoState('identity wiped');
  // #298: the identity's lock config dies with it — a later signup on
  // this device must never inherit a dead user's PIN
  try {
    localStorage.removeItem(`munni_lock_${identityKey(identity)}`);
  } catch {
    // storage may be unavailable mid-wipe; the stale key is harmless
  }
  forgetNavCache(identityKey(identity));
}
