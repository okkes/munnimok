import { useCallback, useEffect, useState } from 'react';
import { useSession } from '@/app/session';
import { settleAnswered } from '@/application/deliveredResolve';
import { serverSplits } from '@/application/splitsApi';
import type { SplitDetail, SplitMember, SplitsApi, SplitSummary } from '@/application/splitsApi';
import { useLang } from '@/i18n';
import { useServerRefresh } from '@/lib/serverEvents';
import { demoSplits } from './demoSplits';

type Translate = ReturnType<typeof useLang>['t'];

/** the demo shows seeded splits that stay on the device; a profile without an account has none: online by design (#538) */
export function useSplitsApi(): SplitsApi | null {
  const { identity } = useSession();
  if (identity?.kind === 'user') return serverSplits;
  return identity?.kind === 'demo' ? demoSplits : null;
}

export type SplitPhase = 'planned' | 'running' | 'settling' | 'archived';

export function splitPhase(split: Pick<SplitSummary, 'status' | 'startDate'>, today: string): SplitPhase {
  if (split.status === 'archived') return 'archived';
  if (split.status === 'settled') return 'settling';
  return split.startDate && split.startDate > today ? 'planned' : 'running';
}

/** a member by the name the screens say: "You", their name, or — an account that is gone — "Former member" */
export const memberName = (member: Pick<SplitMember, 'isMe' | 'displayName'> | undefined, t: Translate): string => {
  if (member?.isMe) return t('word.you');
  return member?.displayName ?? t('splits.formerMember');
};

export function splitDates(split: Pick<SplitSummary, 'startDate' | 'endDate'>, locale: string, t: Translate): string {
  const day = (iso: string) => new Date(`${iso}T12:00:00`).toLocaleDateString(locale, { day: 'numeric', month: 'short', year: 'numeric' });
  if (split.startDate && split.endDate) return `${day(split.startDate)} – ${day(split.endDate)}`;
  if (split.startDate) return t('splits.datesFrom', { date: day(split.startDate) });
  return split.endDate ? t('splits.datesUntil', { date: day(split.endDate) }) : '';
}

export type DetailState = { state: 'loading' } | { state: 'offline' } | { state: 'gone' } | { state: 'ready'; detail: SplitDetail };

/** a failed read keeps what was on screen: a flaky connection must not blank the page */
export function useSplitDetail(api: SplitsApi | null, splitId: string): { view: DetailState; reload: () => Promise<void> } {
  const [view, setView] = useState<DetailState>({ state: 'loading' });
  const reload = useCallback(async () => {
    if (!api) return;
    const answer = await api.get(splitId);
    if (answer === 'gone') setView({ state: 'gone' });
    else if (answer) setView({ state: 'ready', detail: answer });
    else setView((prev) => (prev.state === 'ready' ? prev : { state: 'offline' }));
    // #614: an owner who answered the last join request no longer needs the phone's notice of it
    if (answer && answer !== 'gone' && answer.requests) {
      void settleAnswered({ splitRequests: { splitId, waiting: answer.requests.length } }).catch(() => undefined);
    }
  }, [api, splitId]);
  useEffect(() => {
    void reload();
  }, [reload]);
  useServerRefresh(reload);
  return { view, reload };
}
