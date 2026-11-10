import { useCallback, useEffect, useState } from 'react';
import type { ReactNode } from 'react';
import { useQuery } from '@/db/useQuery';
import { useNavigate, useParams } from '@tanstack/react-router';
import { useLang } from '@/i18n';
import { useData } from '@/app/data';
import { useSession } from '@/app/session';
import { apiFetch } from '@/lib/api';
import { AppBar, IconButton } from '@/ui/AppBar';
import { Button } from '@/ui/Button';
import { Icon } from '@/ui/Icon';

interface InvitePeek {
  splitName: string;
  currency: string;
  inviterName: string | null;
  /** the caller made this link */
  mine?: boolean;
  /** the caller is in the split already; `splitId` opens it */
  member?: boolean;
  splitId?: string | null;
}

/** only a 404 says the link is dead: a failed request or a busy server says nothing about it */
type Lookup = { state: 'loading' } | { state: 'invalid' } | { state: 'unreachable' } | { state: 'found'; peek: InvitePeek };

function Notice({ icon, text, testId, children }: Readonly<{ icon: string; text: string; testId: string; children?: ReactNode }>) {
  return (
    <div className="pt-16 text-center" data-testid={testId}>
      <Icon name={icon} size={40} color="var(--m-ink-4)" />
      <p className="mx-auto mt-3 max-w-[280px] text-[14px] text-ink-2">{text}</p>
      {children && <div className="mx-auto mt-5 flex max-w-[280px] flex-col">{children}</div>}
    </div>
  );
}

/**
 * Join screen (SP3): an invitee sees ONLY the split name + inviter —
 * design rule — and picks which of THEIR OWN spaces the split attaches
 * to (per-member attachment; nobody else ever sees the choice).
 */
export function SplitJoinScreen() {
  const { t } = useLang();
  const navigate = useNavigate();
  const { token } = useParams({ strict: false }) as { token: string };
  const { identity } = useSession();
  const { store, spaceId: activeSpaceId } = useData();
  const [lookup, setLookup] = useState<Lookup>({ state: 'loading' });
  const [picked, setPicked] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const signedIn = identity?.kind === 'user';

  const spaces = useQuery(store, async () => (await store.allRows('space')).filter((s) => s.deleted === 0), []);

  const load = useCallback(async () => {
    setLookup({ state: 'loading' });
    const res = await apiFetch(`/splits/invites/${token}`).catch(() => null);
    if (res?.ok) setLookup({ state: 'found', peek: (await res.json()) as InvitePeek });
    else setLookup({ state: res?.status === 404 ? 'invalid' : 'unreachable' });
  }, [token]);

  useEffect(() => {
    if (signedIn) void load();
  }, [load, signedIn]);

  const open = (splitId: string) => navigate({ to: '/splits/$splitId', params: { splitId }, replace: true });

  const join = async () => {
    setBusy(true);
    const res = await apiFetch(`/splits/invites/${token}/accept`, {
      method: 'POST',
      body: JSON.stringify({ spaceId: picked ?? activeSpaceId }),
    }).catch(() => null);
    setBusy(false);
    if (!res?.ok) {
      setLookup({ state: res?.status === 404 ? 'invalid' : 'unreachable' });
      return;
    }
    const { splitId } = (await res.json()) as { splitId: string };
    await open(splitId);
  };

  const body = () => {
    // splits live on the server: a profile without an account has nothing to join with
    if (!signedIn) return <Notice icon="account-alert-outline" text={t('splits.joinNeedsAccount')} testId="split-join-needs-account" />;
    if (lookup.state === 'loading') return <div className="px-4 py-16 text-center text-[13px] text-ink-4">…</div>;
    if (lookup.state === 'invalid') return <Notice icon="link-variant-off" text={t('splits.inviteInvalid')} testId="split-join-invalid" />;
    if (lookup.state === 'unreachable') {
      return (
        <Notice icon="cloud-off-outline" text={t('splits.joinUnreachable')} testId="split-join-unreachable">
          <Button data-testid="split-join-retry" onClick={() => void load()}>
            {t('splits.joinRetry')}
          </Button>
        </Notice>
      );
    }
    const { peek } = lookup;
    if (peek.member && peek.splitId) {
      const splitId = peek.splitId;
      return (
        <Notice
          icon="account-check-outline"
          text={t(peek.mine ? 'splits.joinOwn' : 'splits.joinAlready')}
          testId={peek.mine ? 'split-join-own' : 'split-join-already'}
        >
          <Button data-testid="split-join-open" onClick={() => void open(splitId)}>
            {t('splits.joinOpen')}
          </Button>
        </Notice>
      );
    }
    return (
      <>
        <div className="mt-4 rounded-card border border-line bg-surface p-5 text-center" data-testid="split-join-card">
          <Icon name="account-cash-outline" size={36} color="var(--m-accent-deep)" />
          {peek.inviterName && <p className="mt-2 text-[13px] text-ink-3">{t('splits.invitedBy', { name: peek.inviterName })}</p>}
          <p className="mt-1 text-[19px] font-semibold text-ink">{peek.splitName}</p>
        </div>

        <div className="m-cap mt-6 mb-1 px-1">{t('splits.attachPrompt')}</div>
        <div className="overflow-hidden rounded-card border border-line bg-surface">
          {(spaces ?? []).map((space) => {
            const active = (picked ?? activeSpaceId) === space.id;
            return (
              <button
                key={space.id}
                data-testid={`split-join-space-${space.id}`}
                onClick={() => setPicked(space.id)}
                className="m-tap flex w-full items-center gap-3 border-b border-line-2 bg-transparent px-4 py-3 text-left last:border-0"
              >
                <Icon
                  name={active ? 'radiobox-marked' : 'radiobox-blank'}
                  size={20}
                  color={active ? 'var(--m-accent-deep)' : 'var(--m-ink-4)'}
                />
                <span className="min-w-0 flex-1 truncate text-[14px] text-ink">{space.name}</span>
              </button>
            );
          })}
        </div>
        <p className="mt-2 px-1 text-[12px] text-ink-4">{t('splits.attachHint')}</p>

        <div className="mt-6 flex flex-col">
          <Button data-testid="split-join-confirm" disabled={busy} onClick={() => void join()}>
            {t('splits.join')}
          </Button>
        </div>
      </>
    );
  };

  return (
    <div className="flex h-dvh flex-col bg-bg" data-testid="screen-split-join">
      <AppBar
        title={t('splits.joinTitle')}
        leading={
          <IconButton label={t('action.back')} testId="split-join-back" onClick={() => window.history.back()}>
            <Icon name="chevron-left" size={24} />
          </IconButton>
        }
      />
      <div className="min-h-0 flex-1 overflow-y-auto px-5 pb-6">{body()}</div>
    </div>
  );
}
