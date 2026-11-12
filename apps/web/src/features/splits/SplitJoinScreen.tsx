import { useCallback, useEffect, useState } from 'react';
import type { ReactNode } from 'react';
import { useNavigate, useParams } from '@tanstack/react-router';
import { useLang } from '@/i18n';
import { useData } from '@/app/data';
import { useSession } from '@/app/session';
import { serverSplits } from '@/application/splitsApi';
import type { SplitPeek } from '@/application/splitsApi';
import { EVENT_PICTURES } from '@/features/events/EventsScreen';
import { AppBar, IconButton } from '@/ui/AppBar';
import { Button } from '@/ui/Button';
import { Icon } from '@/ui/Icon';

/** only "gone" says the link is dead: a failed request or a busy server says nothing about it */
type Lookup =
  | { state: 'loading' }
  | { state: 'invalid' }
  | { state: 'unreachable' }
  | { state: 'waiting' }
  | { state: 'removed' }
  | { state: 'found'; peek: SplitPeek };

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
 * The join screen (#538): an invitee sees ONLY the split's name, its
 * picture and who invited them — design rule — and where they stand with
 * this link: their own, already in, waiting for an owner, or taken out
 * before. A link that asks for approval says so before it is used.
 */
export function SplitJoinScreen() {
  const { t } = useLang();
  const navigate = useNavigate();
  const { token } = useParams({ strict: false }) as { token: string };
  const { identity } = useSession();
  const { spaceId } = useData();
  const [lookup, setLookup] = useState<Lookup>({ state: 'loading' });
  const [busy, setBusy] = useState(false);
  const signedIn = identity?.kind === 'user';

  const load = useCallback(async () => {
    setLookup({ state: 'loading' });
    const peek = await serverSplits.peek(token);
    if (peek === 'gone') setLookup({ state: 'invalid' });
    else if (!peek) setLookup({ state: 'unreachable' });
    else if (peek.removed) setLookup({ state: 'removed' });
    else if (peek.waiting) setLookup({ state: 'waiting' });
    else setLookup({ state: 'found', peek });
  }, [token]);

  useEffect(() => {
    if (signedIn) void load();
  }, [load, signedIn]);

  const open = (splitId: string) => navigate({ to: '/splits/$splitId', params: { splitId }, replace: true });

  const join = async () => {
    setBusy(true);
    const answer = await serverSplits.accept(token, spaceId);
    setBusy(false);
    if (answer === 'gone') setLookup({ state: 'invalid' });
    else if (answer === 'removed') setLookup({ state: 'removed' });
    else if (!answer) setLookup({ state: 'unreachable' });
    else if (answer.state === 'waiting' || !answer.splitId) setLookup({ state: 'waiting' });
    else await open(answer.splitId);
  };

  const body = () => {
    // splits live on the server: a profile without an account has nothing to join with
    if (!signedIn) return <Notice icon="account-alert-outline" text={t('splits.joinNeedsAccount')} testId="split-join-needs-account" />;
    if (lookup.state === 'loading') return <div className="px-4 py-16 text-center text-[13px] text-ink-4">…</div>;
    if (lookup.state === 'invalid') return <Notice icon="link-variant-off" text={t('splits.inviteInvalid')} testId="split-join-invalid" />;
    if (lookup.state === 'waiting') return <Notice icon="account-clock-outline" text={t('splits.joinWaiting')} testId="split-join-waiting" />;
    if (lookup.state === 'removed') return <Notice icon="account-cancel-outline" text={t('splits.joinRemoved')} testId="split-join-removed" />;
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
        <Notice icon="account-check-outline" text={t(peek.mine ? 'splits.joinOwn' : 'splits.joinAlready')} testId={peek.mine ? 'split-join-own' : 'split-join-already'}>
          <Button data-testid="split-join-open" onClick={() => void open(splitId)}>
            {t('splits.joinOpen')}
          </Button>
        </Notice>
      );
    }
    return (
      <>
        <div className="mt-4 overflow-hidden rounded-card border border-line bg-surface text-center" data-testid="split-join-card">
          <img src={peek.picture ?? EVENT_PICTURES[0]} alt="" className="h-28 w-full object-cover" />
          <div className="p-5">
            {peek.inviterName && <p className="text-[13px] text-ink-3">{t('splits.invitedBy', { name: peek.inviterName })}</p>}
            <p className="mt-1 text-[19px] font-semibold text-ink">{peek.splitName}</p>
          </div>
        </div>
        <p className="mt-3 px-1 text-[12px] leading-snug text-ink-4">{t('splits.joinHint')}</p>
        {peek.needsApproval && (
          <p className="mt-2 px-1 text-[12px] leading-snug text-ink-3" data-testid="split-join-approval">
            {t('splits.joinApproval')}
          </p>
        )}
        <div className="mt-6 flex flex-col">
          <Button data-testid="split-join-confirm" disabled={busy} onClick={() => void join()}>
            {t(peek.needsApproval ? 'splits.joinAsk' : 'splits.join')}
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
