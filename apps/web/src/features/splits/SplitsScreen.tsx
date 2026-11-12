import { useCallback, useEffect, useState } from 'react';
import { useNavigate } from '@tanstack/react-router';
import { LOCALES, useLang } from '@/i18n';
import { useData } from '@/app/data';
import { useSession } from '@/app/session';
import { localToday } from '@/application/recurring';
import type { SplitInvitation, SplitSummary } from '@/application/splitsApi';
import { useQuery } from '@/db/useQuery';
import { EVENT_PICTURES } from '@/features/events/EventsScreen';
import { fmtCents } from '@/lib/money';
import { useServerRefresh } from '@/lib/serverEvents';
import { AppBar, IconButton } from '@/ui/AppBar';
import { Button } from '@/ui/Button';
import { Icon } from '@/ui/Icon';
import { adoptEventLinks } from './splitEvents';
import { SplitFormSheet } from './SplitFormSheet';
import { splitDates, splitPhase, useSplitsApi } from './splitsCore';
import type { SplitPhase } from './splitsCore';

const SECTIONS: readonly SplitPhase[] = ['running', 'planned', 'settling', 'archived'];

/** where the person stands in an event, as the row's right-hand word */
function Standing({ split }: Readonly<{ split: SplitSummary }>) {
  const { t, lang } = useLang();
  if (split.deleteAt) return <span className="shrink-0 text-[11px] font-medium text-warning">{t('splits.deleting')}</span>;
  if (split.myBalanceCents === 0) return null;
  const owed = split.myBalanceCents > 0;
  return (
    <span className={`m-num shrink-0 text-right text-[12px] font-semibold ${owed ? 'text-accent-deep' : 'text-negative'}`} data-testid={`split-standing-${split.id}`}>
      {t(owed ? 'splits.youGet' : 'splits.youOwe', { amount: fmtCents(Math.abs(split.myBalanceCents), split.currency, lang) })}
    </span>
  );
}

function SplitRow({ split, onOpen }: Readonly<{ split: SplitSummary; onOpen: () => void }>) {
  const { t, lang } = useLang();
  const dates = splitDates(split, LOCALES[lang], t);
  const members = split.memberCount === 1 ? t('splits.membersCountOne') : t('splits.membersCount', { n: split.memberCount });
  return (
    <button
      data-testid={`split-row-${split.id}`}
      onClick={onOpen}
      className="m-tap flex w-full items-center gap-3 border-b border-line-2 bg-transparent px-3 py-3 text-left last:border-0"
    >
      <img src={split.picture ?? EVENT_PICTURES[0]} alt="" loading="lazy" className="h-11 w-11 shrink-0 rounded-xl object-cover" />
      <span className="min-w-0 flex-1">
        <span className="block truncate text-[15px] text-ink">{split.name}</span>
        <span className="block truncate text-[11px] text-ink-4">{[dates, members].filter(Boolean).join(' · ')}</span>
        {split.totalCents > 0 && <span className="m-num block text-[11px] text-ink-3">{t('splits.total', { amount: fmtCents(split.totalCents, split.currency, lang) })}</span>}
      </span>
      <Standing split={split} />
      <Icon name="chevron-right" size={18} color="var(--m-ink-4)" />
    </button>
  );
}

/**
 * Splits (#538): group ledgers whose membership has nothing to do with
 * spaces. The list says which are running, which are planned, which are
 * being settled and which are archived; an invitation from a friend waits
 * on top for a yes or a no. Online by design — a profile without an
 * account is told so, the demo shows seeded examples.
 */
export function SplitsScreen() {
  const { t } = useLang();
  const navigate = useNavigate();
  const api = useSplitsApi();
  const { identity } = useSession();
  const { store, repo, spaceId } = useData();
  const space = useQuery(store, async () => store.get('space', spaceId), [spaceId]);
  const [splits, setSplits] = useState<SplitSummary[] | null>(null);
  const [invitations, setInvitations] = useState<SplitInvitation[]>([]);
  const [offline, setOffline] = useState(false);
  const [formOpen, setFormOpen] = useState(false);
  const [showArchived, setShowArchived] = useState(false);
  const [answering, setAnswering] = useState<string | null>(null);

  const reload = useCallback(async () => {
    if (!api) return;
    const [list, invites] = await Promise.all([api.list(), api.invitations()]);
    setOffline(list === null);
    // an answer that cannot be had keeps what was on screen
    setSplits((prev) => list ?? prev ?? []);
    if (invites) setInvitations(invites);
    // a link the server still keeps from before lands on its event once
    if (list) void adoptEventLinks(store, repo, list);
  }, [api, store, repo]);
  useEffect(() => {
    void reload();
  }, [reload]);
  useServerRefresh(reload);

  const open = (splitId: string) => void navigate({ to: '/splits/$splitId', params: { splitId } });
  const answer = async (invitation: SplitInvitation, accept: boolean) => {
    if (!api || answering) return;
    setAnswering(invitation.id);
    const answered = await api.answerInvitation(invitation.id, accept);
    setAnswering(null);
    if (answered && accept) open(invitation.splitId);
    else await reload();
  };

  const today = localToday();
  const inPhase = (phase: SplitPhase) => (splits ?? []).filter((split) => splitPhase(split, today) === phase);
  const archived = inPhase('archived');

  return (
    <div className="flex h-dvh flex-col bg-bg" data-testid="screen-splits">
      <AppBar
        title={t('splits.title')}
        leading={
          <IconButton label={t('action.back')} testId="splits-back" onClick={() => window.history.back()}>
            <Icon name="chevron-left" size={24} />
          </IconButton>
        }
        trailing={
          api ? (
            <IconButton label={t('splits.new')} testId="splits-add" onClick={() => setFormOpen(true)}>
              <Icon name="plus" size={22} />
            </IconButton>
          ) : undefined
        }
      />
      <div className="min-h-0 flex-1 overflow-y-auto px-5 pb-6">
        {!api && (
          <p className="pt-16 text-center text-[13px] text-ink-3" data-testid="splits-needs-account">
            {t('splits.needsAccount')}
          </p>
        )}
        {identity?.kind === 'demo' && (
          <p className="py-2 text-center text-[11px] text-ink-4" data-testid="splits-demo-note">
            {t('splits.demoNote')}
          </p>
        )}
        {offline && (
          <p className="py-2 text-center text-[12px] text-ink-4" data-testid="splits-offline">
            {t('splits.offline')}
          </p>
        )}

        {invitations.map((invitation) => (
          <div key={invitation.id} className="mb-3 rounded-card border border-accent bg-accent-soft p-3" data-testid={`split-invitation-${invitation.id}`}>
            <p className="text-[13px] text-ink">{t('splits.invitedTo', { name: invitation.fromName ?? t('splits.someone'), split: invitation.splitName })}</p>
            <div className="mt-2 flex gap-2">
              <Button size="sm" className="flex-1" disabled={answering !== null} data-testid={`split-invitation-join-${invitation.id}`} onClick={() => void answer(invitation, true)}>
                {t('splits.join')}
              </Button>
              <Button size="sm" variant="outline" className="flex-1" disabled={answering !== null} data-testid={`split-invitation-decline-${invitation.id}`} onClick={() => void answer(invitation, false)}>
                {t('splits.inviteDecline')}
              </Button>
            </div>
          </div>
        ))}

        {api && splits !== null && splits.length === 0 && !offline && (
          <div className="pt-16 text-center" data-testid="splits-empty">
            <Icon name="account-cash-outline" size={40} color="var(--m-ink-4)" />
            <p className="mt-3 text-[15px] font-medium text-ink">{t('splits.emptyTitle')}</p>
            <p className="mx-auto mt-1 max-w-[280px] text-[13px] text-ink-3">{t('splits.emptyBody')}</p>
          </div>
        )}
        {api && splits === null && <div className="px-4 py-6 text-center text-[13px] text-ink-4">…</div>}

        {SECTIONS.filter((phase) => phase !== 'archived').map((phase) => {
          const rows = inPhase(phase);
          if (rows.length === 0) return null;
          return (
            <section key={phase} data-testid={`splits-section-${phase}`}>
              <div className="m-cap mt-3 mb-1 px-1">{t(`splits.section.${phase}`)}</div>
              <div className="overflow-hidden rounded-card border border-line bg-surface">
                {rows.map((split) => (
                  <SplitRow key={split.id} split={split} onOpen={() => open(split.id)} />
                ))}
              </div>
            </section>
          );
        })}

        {archived.length > 0 && (
          <section data-testid="splits-section-archived">
            <button
              data-testid="splits-archived-toggle"
              onClick={() => setShowArchived((shown) => !shown)}
              className="m-tap mt-4 flex w-full items-center gap-1 border-none bg-transparent px-1 py-1 text-[12px] font-medium text-ink-3"
            >
              {t('splits.showArchived', { n: archived.length })}
              <Icon name={showArchived ? 'chevron-up' : 'chevron-down'} size={15} />
            </button>
            {showArchived && (
              <div className="overflow-hidden rounded-card border border-line bg-surface">
                {archived.map((split) => (
                  <SplitRow key={split.id} split={split} onOpen={() => open(split.id)} />
                ))}
              </div>
            )}
          </section>
        )}
      </div>

      {api && (
        <SplitFormSheet api={api} open={formOpen} onOpenChange={setFormOpen} editing={null} defaultCurrency={space?.currency ?? 'EUR'} onSaved={open} />
      )}
    </div>
  );
}
