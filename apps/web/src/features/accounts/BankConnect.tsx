import { useEffect, useRef, useState } from 'react';
import { useLogto } from '@logto/react';
import { useLang } from '@/i18n';
import { config, logtoConfigured, publicOrigin } from '@/app/config';
import { isNativeApp } from '@/lib/platform';
import { useData } from '@/app/data';
import { apiFetch } from '@/lib/api';
import { Highlight } from '@/ui/Highlight';
import { Icon } from '@/ui/Icon';
import { Sheet } from '@/ui/Sheet';

interface Institution {
  id: string;
  name: string;
  bic?: string;
  logo?: string;
}

/**
 * GoCardless bank connect: pick an institution, get sent to the bank to
 * approve read-only access, return via /gc-callback. Only offered for
 * syncing (user) identities when the server has GoCardless enabled.
 */
export function BankConnectSheet({ open, onOpenChange }: { open: boolean; onOpenChange: (open: boolean) => void }) {
  const { t } = useLang();
  const { spaceId } = useData();
  const [institutions, setInstitutions] = useState<Institution[] | null>(null);
  const [query, setQuery] = useState('');
  const [busy, setBusy] = useState(false);
  const [failed, setFailed] = useState(false);

  const [rateLimited, setRateLimited] = useState(false);

  useEffect(() => {
    if (!open || institutions) return;
    void (async () => {
      try {
        const res = await apiFetch('/gocardless/institutions?country=nl');
        if (res.status === 429 || res.status === 503) {
          // GoCardless quota spent — a distinct message beats a generic
          // failure ("try later" is genuinely the right advice here)
          setRateLimited(true);
          return;
        }
        if (!res.ok) throw new Error(String(res.status));
        setInstitutions((await res.json()) as Institution[]);
      } catch {
        setFailed(true);
      }
    })();
  }, [open, institutions]);

  const connect = async (institutionId: string) => {
    setBusy(true);
    try {
      const res = await apiFetch('/gocardless/requisitions', {
        method: 'POST',
        body: JSON.stringify({
          spaceId,
          institutionId,
          // hosted origin, not window origin: inside the native shell the
          // window is localhost; the hosted page completes anonymously via
          // the reference capability token either way. The shell encodes
          // its deep-link scheme in the PATH (a query param would collide
          // with the ?ref= the bank provider appends), so the hosted page
          // can hand the user back to the app when it finishes.
          redirectUrl: publicOrigin() + '/gc-callback' + (isNativeApp() ? '/app-' + config.nativeScheme : ''),
        }),
      });
      if (!res.ok) throw new Error(String(res.status));
      const { reference, link } = (await res.json()) as { reference: string; link: string };
      sessionStorage.setItem('munni_gc_ref', reference);
      window.location.href = link; // off to the bank
    } catch {
      setFailed(true);
      setBusy(false);
    }
  };

  const filtered = (institutions ?? []).filter(
    (i) => !query || i.name.toLowerCase().includes(query.toLowerCase()) || i.bic?.toLowerCase().includes(query.toLowerCase()),
  );

  return (
    <Sheet open={open} onOpenChange={onOpenChange} title={t('gc.connect')} size="tall">
      <p className="pb-2 text-[12px] text-ink-3">{t('gc.connectSub')}</p>
      {failed && (
        <div className="mb-2 flex items-center gap-2 rounded-card bg-negative-soft px-4 py-3 text-[13px] text-negative" data-testid="gc-error">
          <Icon name="alert-circle-outline" size={16} />
          {t('gc.failed')}
        </div>
      )}
      {rateLimited && (
        <div className="mb-2 flex items-center gap-2 rounded-card bg-warning-soft px-4 py-3 text-[13px] text-ink-2" data-testid="gc-rate-limited">
          <Icon name="clock-alert-outline" size={16} color="var(--m-warning)" />
          {t('gc.rateLimited')}
        </div>
      )}
      <input
        data-testid="gc-bank-search"
        value={query}
        onChange={(e) => setQuery(e.target.value)}
        placeholder={t('acct.bankSearch')}
        className="mb-2 h-11 w-full rounded-input border border-line bg-surface px-4 text-[15px] text-ink outline-none placeholder:text-ink-4"
      />
      {!institutions && !failed && <div className="py-6 text-center text-sm text-ink-3">…</div>}
      {filtered.map((institution) => (
        <button
          key={institution.id}
          data-testid={`gc-bank-${institution.id}`}
          disabled={busy}
          onClick={() => void connect(institution.id)}
          className="m-tap flex w-full items-center gap-3 border-none bg-transparent px-1 py-2.5 text-left"
        >
          {institution.logo ? (
            <img
              src={institution.logo}
              alt=""
              className="h-8 w-8 rounded-lg object-contain"
              loading="lazy"
              // a blocked/expired CDN image must not leave an empty square
              onError={(e) => {
                e.currentTarget.style.display = 'none';
                e.currentTarget.nextElementSibling?.classList.remove('hidden');
              }}
            />
          ) : null}
          <span className={institution.logo ? 'hidden' : ''}>
            <Icon name="bank-outline" size={22} color="var(--m-ink-3)" />
          </span>
          <span className="min-w-0 flex-1">
            <span className="block truncate text-[14px] font-medium text-ink">
              <Highlight text={institution.name} query={query} />
            </span>
            {institution.bic && (
              <span className="block font-mono text-[11px] text-ink-4">
                <Highlight text={institution.bic} query={query} />
              </span>
            )}
          </span>
          <Icon name="chevron-right" size={18} color="var(--m-ink-4)" />
        </button>
      ))}
    </Sheet>
  );
}

/**
 * rendered at /gc-callback (outside the hash router) after the bank
 * redirect. With Logto configured we must wait for the SDK to restore the
 * session before calling the API — firing immediately loses the race and
 * 401s.
 */
export function GcCallbackScreen() {
  return logtoConfigured ? <GcCallbackWithLogto /> : <GcCallbackInner bearer={null} />;
}

// symbol sentinel: 'pending' as a literal would widen into the string union
const PENDING = Symbol('pending');

function GcCallbackWithLogto() {
  const { isLoading, isAuthenticated, getAccessToken } = useLogto();
  const [bearer, setBearer] = useState<string | null | typeof PENDING>(PENDING);

  useEffect(() => {
    if (isLoading) return;
    if (!isAuthenticated) {
      setBearer(null); // no session — inner screen will fail gracefully
      return;
    }
    void getAccessToken(config.logto.resource || undefined).then((token) => setBearer(token ?? null));
  }, [isLoading, isAuthenticated, getAccessToken]);

  if (bearer === PENDING) return <GcCallbackShell state="working" />;
  return <GcCallbackInner bearer={bearer} />;
}

function GcCallbackInner({ bearer }: { bearer: string | null }) {
  const [state, setState] = useState<'working' | 'done' | 'failed'>('working');
  const started = useRef(false);

  useEffect(() => {
    if (started.current) return; // StrictMode double-mount guard
    started.current = true;
    void (async () => {
      const params = new URLSearchParams(window.location.search);
      if (params.get('done') === '1') {
        // the hosted page already completed the requisition — this is
        // the deep-linked return into the shell
        sessionStorage.removeItem('munni_gc_ref');
        setState('done');
        return;
      }
      // Enable Banking puts the reference in `state` and adds a `code`;
      // GoCardless echoes `ref` and needs no code
      const reference = params.get('ref') ?? params.get('state') ?? sessionStorage.getItem('munni_gc_ref');
      const code = params.get('code');
      if (!reference) {
        setState('failed');
        return;
      }
      try {
        const headers: Record<string, string> = {};
        if (bearer) headers.Authorization = `Bearer ${bearer}`;
        const query = code ? `?code=${encodeURIComponent(code)}` : '';
        const res = await apiFetch(`/gocardless/requisitions/${reference}/complete${query}`, { method: 'POST', headers });
        if (!res.ok) throw new Error(String(res.status));
        sessionStorage.removeItem('munni_gc_ref');
        setState('done');
      } catch {
        setState('failed');
      }
    })();
  }, [bearer]);

  return <GcCallbackShell state={state} />;
}

const SHELL_ICONS = { working: 'bank-outline', done: 'check-circle-outline', failed: 'alert-circle-outline' } as const;
const SHELL_TEXT_KEYS = { working: 'gc.completing', done: 'gc.done', failed: 'gc.failed' } as const;

/** the shell's deep-link scheme when the flow started inside the app —
 *  encoded in the path as /gc-callback/app-{scheme} (see connect()) */
function appSchemeFromPath(): string | null {
  const match = /\/gc-callback\/app-([a-z][a-z0-9+.-]*)/i.exec(window.location.pathname);
  return match ? match[1] : null;
}

function GcCallbackShell({ state }: { state: 'working' | 'done' | 'failed' }) {
  const { t } = useLang();
  const appScheme = appSchemeFromPath();

  // consent started in the native app: the moment the hosted page is
  // done, hand the user straight back (user report: they were stranded
  // in the browser). The button below stays as the manual fallback.
  useEffect(() => {
    if (state !== 'done' || !appScheme) return;
    const timer = setTimeout(() => {
      window.location.href = appScheme + '://gc-callback?done=1';
    }, 800);
    return () => clearTimeout(timer);
  }, [state, appScheme]);

  return (
    <div className="flex h-dvh flex-col items-center justify-center gap-4 bg-bg px-6 text-center" data-testid="screen-gc-callback">
      <Icon
        name={SHELL_ICONS[state]}
        size={44}
        color={state === 'failed' ? 'var(--m-negative)' : 'var(--m-accent)'}
      />
      <div className="m-h3 text-ink">{t(SHELL_TEXT_KEYS[state])}</div>
      {state === 'done' && (
        // bank-app detours land this screen in a browser tab, not the
        // installed app — say out loud that closing the tab is fine
        <p className="max-w-[280px] text-[13px] text-ink-3">{t('gc.closeTabHint')}</p>
      )}
      {state !== 'working' && (
        <a
          href={appScheme ? appScheme + '://gc-callback?done=1' : `${window.location.origin}/#/accounts`}
          className="m-tap rounded-btn bg-brand px-5 py-3 text-[14px] font-semibold text-on-brand no-underline"
        >
          {t('gc.backToApp')}
        </a>
      )}
    </div>
  );
}
