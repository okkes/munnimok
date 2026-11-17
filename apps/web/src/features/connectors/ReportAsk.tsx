import { useLang } from '@/i18n';
import { Button } from '@/ui/Button';

// #441 L1: a failed run's last picture goes to the people who run munni only with the person's word: yes keeps it a month,
// no deletes it at once, unanswered deletes itself after two days
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
