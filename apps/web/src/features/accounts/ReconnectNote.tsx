import { useNavigate } from '@tanstack/react-router';
import { useLang } from '@/i18n';
import type { AccountRow } from '@/db/types';
import type { ReconnectNeed } from '@/domain/accountCoverage';
import type { ReconnectDoor } from '@/features/connectors/useReconnect';
import { Button } from '@/ui/Button';
import { uncoveredDateText } from './coverage';

/** #528: says why the account needs its connection again (nothing fetches it, or the syncing one lost consent)
 *  and the button leads to that connection on the screen that manages it */
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
