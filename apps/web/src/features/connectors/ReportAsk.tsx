import { useLang } from '@/i18n';
import { Button } from '@/ui/Button';

/**
 * #441 L1 (user ruling 2026-10-06): a failed run's last picture of the
 * page goes to the people who run munni only with the person's word.
 * Asked once, beside the error it belongs to — yes keeps it a month, no
 * deletes it on the spot, and a question left unanswered deletes itself
 * after two days. Rendered by the connect sheet's failed arm and by the
 * hub's card.
 */
export function ReportAsk({
  answered,
  busy,
  onAnswer,
  testId,
}: Readonly<{
  answered: 'yes' | 'no' | null;
  busy: boolean;
  onAnswer: (share: boolean) => void;
  testId: string;
}>) {
  const { t } = useLang();
  if (answered) {
    return (
      <p className="text-[12px] text-ink-4" data-testid={`${testId}-done`}>
        {t(answered === 'yes' ? 'conn.report.thanks' : 'conn.report.declined')}
      </p>
    );
  }
  return (
    <div className="rounded-card border border-line bg-bg px-3 py-2.5" data-testid={testId}>
      <p className="text-[13px] font-medium text-ink">{t('conn.report.ask')}</p>
      <p className="mt-0.5 text-[11px] leading-snug text-ink-4">{t('conn.report.sub')}</p>
      <div className="mt-2 flex gap-2">
        <Button size="sm" data-testid={`${testId}-yes`} disabled={busy} onClick={() => onAnswer(true)}>
          {t('conn.report.yes')}
        </Button>
        <Button size="sm" variant="outline" data-testid={`${testId}-no`} disabled={busy} onClick={() => onAnswer(false)}>
          {t('conn.report.no')}
        </Button>
      </div>
    </div>
  );
}
