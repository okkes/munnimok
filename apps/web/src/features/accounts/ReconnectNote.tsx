import { useNavigate } from '@tanstack/react-router';
import { useLang } from '@/i18n';
import type { AccountRow } from '@/db/types';
import type { ReconnectNeed } from '@/domain/accountCoverage';
import type { ReconnectDoor } from '@/features/connectors/useReconnect';
import { Button } from '@/ui/Button';
import { uncoveredDateText } from './coverage';

/**
 * #528: an account that needs its connection again says why — no
 * connection of the person's fetches it any more, or the one that syncs it
 * by itself lost its consent — and the button leads to that connection,
 * brought into view on the screen that manages it, instead of leaving the
 * person to guess (user 2026-10-21).
 */
export function ReconnectNote({
  account,
  need,
  door,
  onLeave,
  testId,
  actionTestId,
  className = 'rounded-card border border-line bg-bg-2 px-4 py-3 text-[13px] text-ink-2',
}: Readonly<{
  account: AccountRow;
  need: ReconnectNeed;
  door: ReconnectDoor;
  onLeave: () => void;
  testId: string;
  actionTestId: string;
  /** the host's own frame (a row of the editor's list, or a card of its own) */
  className?: string;
}>) {
  const { t, lang } = useLang();
  const navigate = useNavigate();
  const text =
    need.kind === 'gone' ? t('acct.uncovered', { date: uncoveredDateText(need.since, lang), party: door.name }) : t('acct.consentEnded', { party: door.name });
  return (
    <div className={className} data-testid={testId} data-account={account.id}>
      <span className="block">{text}</span>
      <Button
        size="sm"
        variant="outline"
        className="mt-2"
        data-testid={actionTestId}
        onClick={() => {
          onLeave();
          void navigate({ to: door.to, search: door.search });
        }}
      >
        {t('acct.reconnect', { party: door.name })}
      </Button>
    </div>
  );
}
