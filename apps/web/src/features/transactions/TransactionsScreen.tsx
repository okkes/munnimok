import { useLang } from '@/i18n';
import { AppBar } from '@/ui/AppBar';

export function TransactionsScreen() {
  const { t } = useLang();
  return (
    <div className="m-fade flex h-full flex-col" data-testid="screen-transactions">
      <AppBar large title={t('tab.transactions')} />
      <div className="min-h-0 flex-1 overflow-y-auto px-5 pb-6" />
    </div>
  );
}
