import { useCallback, useEffect, useState } from 'react';
import { useSession } from '@/app/session';
import { serverSplits } from '@/application/splitsApi';
import type { SplitDetail, SplitMember, SplitsApi, SplitSummary } from '@/application/splitsApi';
import { useLang } from '@/i18n';
import { useServerRefresh } from '@/lib/serverEvents';
import { demoSplits } from './demoSplits';

type Translate = ReturnType<typeof useLang>['t'];

/**
 * The splits of this identity (#538, user): an account's live on the
 * server; the demo shows seeded ones that stay on the device, so the
 * feature can be understood without an account; a profile without an
 * account has none — the feature is online by design.
 */
export function useSplitsApi(): SplitsApi | null {
  const { identity } = useSession();
  if (identity?.kind === 'user') return serverSplits;
  return identity?.kind === 'demo' ? demoSplits : null;
}

export type SplitPhase = 'planned' | 'running' | 'settling' | 'archived';

/** where an event stands in the list: settled and archived say so themselves; an open one is planned until its first day */
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

/** "20 – 27 Dec 2026", "from 20 Dec 2026", "until 27 Dec 2026", or nothing */
export function splitDates(split: Pick<SplitSummary, 'startDate' | 'endDate'>, locale: string, t: Translate): string {
  const day = (iso: string) => new Date(`${iso}T12:00:00`).toLocaleDateString(locale, { day: 'numeric', month: 'short', year: 'numeric' });
  if (split.startDate && split.endDate) return `${day(split.startDate)} – ${day(split.endDate)}`;
  if (split.startDate) return t('splits.datesFrom', { date: day(split.startDate) });
  return split.endDate ? t('splits.datesUntil', { date: day(split.endDate) }) : '';
}

export type DetailState = { state: 'loading' } | { state: 'offline' } | { state: 'gone' } | { state: 'ready'; detail: SplitDetail };

/**
 * One event, read from where it lives. A change someone else made arrives
 * with the next push or the next look at the tab; what the person does
 * themselves is followed by a re-read. An answer that cannot be had keeps
 * what was on screen — a flaky connection must not blank the page.
 */
export function useSplitDetail(api: SplitsApi | null, splitId: string): { view: DetailState; reload: () => Promise<void> } {
  const [view, setView] = useState<DetailState>({ state: 'loading' });
  const reload = useCallback(async () => {
    if (!api) return;
    const answer = await api.get(splitId);
    if (answer === 'gone') setView({ state: 'gone' });
    else if (answer) setView({ state: 'ready', detail: answer });
    else setView((prev) => (prev.state === 'ready' ? prev : { state: 'offline' }));
  }, [api, splitId]);
  useEffect(() => {
    void reload();
  }, [reload]);
  useServerRefresh(reload);
  return { view, reload };
}
