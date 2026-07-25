import { useState } from 'react';
import { useQuery } from '@/db/useQuery';
import { useLang } from '@/i18n';
import { useData } from '@/app/data';
import { useSession } from '@/app/session';
import { useHelp } from './HelpContext';
import { Icon } from '@/ui/Icon';

/**
 * The guided walkthrough's front door on Home (docs/space-onboarding-
 * walkthrough.md): starts — or resumes, the tour fast-forwards past
 * finished steps — the space/account/transaction setup. Skipping gets
 * ONE encouragement line; the second tap skips for good. Demo
 * identities never see it: the demo data already demonstrates it all.
 */
export function WelcomeTourCard() {
  const { t } = useLang();
  const { store } = useData();
  const { startSpotlight } = useHelp();
  const identity = useSession((s) => s.identity);
  const done = useQuery(store, async () => (await store.metaGet('welcomeTourDone')) ?? null, []);
  const [encouraged, setEncouraged] = useState(false);

  if (identity?.kind === 'demo' || done === undefined || Boolean(done?.value)) return null;

  const skip = () => {
    if (!encouraged) {
      setEncouraged(true); // one nudge, never two (design rule)
      return;
    }
    void store.metaPut('welcomeTourDone', true).catch(() => undefined);
  };

  return (
    <div
      className="mt-3 flex items-center gap-3 rounded-card border border-accent/40 bg-accent-soft/40 px-4 py-2.5"
      data-testid="welcome-tour-card"
    >
      <Icon name="compass-outline" size={18} color="var(--m-accent-deep)" />
      <span className="min-w-0 flex-1 text-[13px] text-ink-2" data-testid="welcome-tour-line">
        {t(encouraged ? 'tour.welcome.encourage' : 'tour.welcome.card')}
      </span>
      <button
        data-testid="welcome-tour-start"
        onClick={() => startSpotlight('welcome')}
        className="m-tap border-none bg-transparent text-[13px] font-semibold text-accent-deep"
      >
        {t('help.start')}
      </button>
      <button
        aria-label={t('action.dismiss')}
        data-testid="welcome-tour-skip"
        onClick={skip}
        className="m-tap flex h-7 w-7 items-center justify-center rounded-full border-none bg-transparent"
      >
        <Icon name="close" size={16} color="var(--m-ink-4)" />
      </button>
    </div>
  );
}
