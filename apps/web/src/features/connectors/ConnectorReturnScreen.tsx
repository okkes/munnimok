import { useEffect, useRef, useState } from 'react';
import { useConnectionOps } from '@/application/connections';
import { config, publicOrigin } from '@/app/config';
import { DataProvider, useData } from '@/app/data';
import { useSession } from '@/app/session';
import { useLang } from '@/i18n';
import type { TranslationKey } from '@/i18n';
import { isNativeApp } from '@/lib/platform';
import { Button } from '@/ui/Button';
import { FormBlockerNote, blockerRing } from '@/ui/FormBlockerNote';
import { Icon } from '@/ui/Icon';
import { ConnectorError, connectorApi } from './api';
import { forgetReturn, pendingReturnFor, returnCodeOf } from './connectorReturn';
import type { PendingReturn } from './connectorReturn';
import { RETURN_PATH, TERMINAL_STATES, errorKey, failedWith } from './manifestForm';
import type { ErrorEnvelope, ProviderManifest, SessionView } from './types';
import { useCatalogue } from './useCatalogue';

/**
 * The page a party brings the person back to (§15): a bank's consent
 * page returns to `/gc-callback` in a fresh document — the same tab on
 * the web, the app re-entered through its App Link on a phone — and this
 * screen answers the redirect challenge the flow sheet wrote down before
 * it opened the party (connectorReturn.ts), then adopts the settled
 * session exactly as the sheet would have, and asks the name a fresh
 * connection gets. Rendered outside the hash router (main.tsx), like the
 * sign-in callback. A return that lands where nothing was started (a
 * phone whose App Link is not verified opens the hosted page) offers the
 * app instead of guessing.
 */
type ReturnState =
  | { kind: 'working' }
  | { kind: 'done'; connectionId: string; reconnect: boolean }
  | { kind: 'failed'; error: ErrorEnvelope }
  | { kind: 'cancelled' }
  | { kind: 'lost' }
  | { kind: 'signedOut' };

const POLL_MS = 2_000;
const POLL_LIMIT = 45;
const BUTTON_LINK = 'm-tap rounded-btn bg-brand px-5 py-3 text-[14px] font-semibold text-on-brand no-underline';
const INPUT = 'h-12 w-full rounded-input border border-line bg-surface px-4 text-[15px] text-ink outline-none';

const ICONS: Record<ReturnState['kind'], string> = {
  working: 'progress-clock',
  done: 'check-circle',
  failed: 'alert-circle-outline',
  cancelled: 'close-circle-outline',
  lost: 'help-circle-outline',
  signedOut: 'lock-outline',
};

const delay = (ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms));

const settled = (view: SessionView): boolean => view.state === 'active' || view.state === 'awaiting_input' || TERMINAL_STATES.has(view.state);

/** the view once the party has settled: a login still completing is read again until it has */
async function settledView(provider: string, first: SessionView): Promise<SessionView> {
  let view = first;
  for (let i = 0; i < POLL_LIMIT && !settled(view); i += 1) {
    await delay(POLL_MS);
    view = await connectorApi.login(provider, view.sessionId);
  }
  return view;
}

export function ConnectorReturnScreen() {
  const identity = useSession((s) => s.identity);
  if (identity?.kind !== 'user') return <ReturnShell state={{ kind: 'signedOut' }} />;
  return (
    <DataProvider>
      <ReturnFlow />
    </DataProvider>
  );
}

function ReturnFlow() {
  const { store } = useData();
  const ops = useConnectionOps();
  const catalogue = useCatalogue();
  const [state, setState] = useState<ReturnState>({ kind: 'working' });
  const [name, setName] = useState('');
  const [attempted, setAttempted] = useState(false);
  const started = useRef(false);
  // read once: the query carries the party's reference, the pending return names the session it belongs to
  const [arrival] = useState(() => {
    const params = new URLSearchParams(globalThis.location.search);
    return { params, pending: pendingReturnFor(returnCodeOf(params)) };
  });

  const finish = async (pending: PendingReturn, manifest: ProviderManifest) => {
    try {
      // the landing address as the party's return pattern names it — the app's own origin, never the webview's
      const landing = `${publicOrigin()}${RETURN_PATH}${globalThis.location.search}`;
      const answered = await connectorApi.answer(pending.provider, pending.sessionId, pending.challengeId, landing);
      const view = await settledView(pending.provider, answered);
      if (view.state !== 'active') {
        setState({ kind: 'failed', error: view.error ?? failedWith(view.state) });
        return;
      }
      // the bundle is handed over exactly once: on the settling answer, or on the first view read after it
      const full = view.bundle ? view : await connectorApi.login(pending.provider, view.sessionId);
      const result = await ops.adopt({ manifest, view: full, connectionId: pending.connectionId, reconnect: pending.reconnect });
      forgetReturn();
      const meta = (await store.allRows('storeConn')).find((c) => c.id === result.connectionId);
      setName(meta?.displayName ?? manifest.name);
      setState({ kind: 'done', connectionId: result.connectionId, reconnect: pending.reconnect });
    } catch (err) {
      setState({ kind: 'failed', error: err instanceof ConnectorError ? err.envelope : failedWith('failed') });
    }
  };

  useEffect(() => {
    if (started.current) return;
    const { params, pending } = arrival;
    if (params.get('error')) {
      // the BANK said no — the person cancelled or the consent was refused
      // upstream: no completion, the session let go, a calm way back
      started.current = true;
      forgetReturn();
      if (pending) void connectorApi.cancel(pending.provider, pending.sessionId).catch(() => undefined);
      setState({ kind: 'cancelled' });
      return;
    }
    if (!pending) {
      started.current = true;
      setState({ kind: 'lost' });
      return;
    }
    const manifest = catalogue.byId.get(pending.provider);
    if (!manifest) {
      // the catalogue comes from the identity's store first, the relay next: wait for it, fail with it
      if (!catalogue.loading) {
        started.current = true;
        setState({ kind: 'failed', error: catalogue.error ?? failedWith('failed') });
      }
      return;
    }
    started.current = true;
    void finish(pending, manifest);
    // finish reads the props of this render only once — the guard above is the dependency that matters
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [arrival, catalogue.byId, catalogue.loading, catalogue.error]);

  const proceed = async () => {
    if (state.kind !== 'done') return;
    if (!name.trim()) {
      setAttempted(true);
      return;
    }
    await ops.rename(state.connectionId, name);
    globalThis.location.assign('/#/connections');
  };

  return <ReturnShell state={state} name={name} onName={setName} attempted={attempted} onContinue={() => void proceed()} />;
}

const headlineOf = (state: ReturnState): TranslationKey => {
  switch (state.kind) {
    case 'working':
      return 'connect.return.working';
    case 'done':
      return state.reconnect ? 'connect.return.reconnected' : 'connect.done';
    case 'failed':
      return 'connect.failedTitle';
    case 'cancelled':
      return 'connect.return.cancelled';
    case 'lost':
      return 'connect.return.lost';
    default:
      return 'conn.signInShort';
  }
};

function ReturnShell({
  state,
  name = '',
  onName,
  attempted = false,
  onContinue,
}: Readonly<{ state: ReturnState; name?: string; onName?: (value: string) => void; attempted?: boolean; onContinue?: () => void }>) {
  const { t } = useLang();
  const naming = state.kind === 'done' && !state.reconnect;
  const nameMissing = attempted && !name.trim();
  return (
    <div className="flex h-dvh flex-col items-center justify-center gap-4 bg-bg px-6 text-center" data-testid="screen-connector-return" data-state={state.kind}>
      <Icon name={ICONS[state.kind]} size={44} color={state.kind === 'failed' ? 'var(--m-negative)' : 'var(--m-accent)'} />
      <div className="m-h3 text-ink">{t(headlineOf(state))}</div>
      {state.kind === 'failed' && (
        <p className="max-w-[300px] text-[13px] leading-relaxed text-negative" data-testid="connector-return-error">
          {t(errorKey(state.error.code))}
        </p>
      )}
      {state.kind === 'done' && (
        <p className="max-w-[300px] text-[13px] leading-relaxed text-ink-3" data-testid="connector-return-done-note">
          {t(state.reconnect ? 'connect.return.reconnectedSub' : 'connect.return.doneSub')}
        </p>
      )}
      {naming && (
        <div className="flex w-full max-w-[320px] flex-col gap-2 text-left">
          <label className="flex flex-col gap-1 text-[12px] text-ink-3">
            {t('conn.nameTitle')}
            <input
              data-testid="connector-return-name"
              value={name}
              onChange={(e) => onName?.(e.target.value)}
              aria-invalid={nameMissing}
              className={`${INPUT}${blockerRing(nameMissing)}`}
            />
          </label>
          <FormBlockerNote show={nameMissing} text={t('form.needName')} testId="connector-return-name-blocker" />
          <Button data-testid="connector-return-continue" onClick={onContinue}>
            {t('connect.return.continue')}
          </Button>
        </div>
      )}
      {state.kind === 'lost' && (
        <>
          <p className="max-w-[300px] text-[13px] leading-relaxed text-ink-3" data-testid="connector-return-lost-note">
            {t('connect.return.lostNote')}
          </p>
          {!isNativeApp() && (
            <a href={`${config.nativeScheme}://${RETURN_PATH.slice(1)}${globalThis.location.search}`} data-testid="connector-return-open-app" className={BUTTON_LINK}>
              {t('connect.return.openApp')}
            </a>
          )}
        </>
      )}
      {state.kind === 'signedOut' && (
        <p className="max-w-[300px] text-[13px] leading-relaxed text-ink-3" data-testid="connector-return-signedout-note">
          {t('connect.return.signedOut')}
        </p>
      )}
      {state.kind !== 'working' && !naming && (
        <a href="/#/connections" data-testid="connector-return-back" className={state.kind === 'lost' && !isNativeApp() ? 'text-[13px] text-accent-deep' : BUTTON_LINK}>
          {t('connect.return.back')}
        </a>
      )}
    </div>
  );
}
