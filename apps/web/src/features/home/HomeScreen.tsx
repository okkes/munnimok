import { useLang } from '@/i18n';
import { AppBar } from '@/ui/AppBar';

export function HomeScreen() {
  const { t } = useLang();
  return (
    <div className="m-fade flex h-full flex-col" data-testid="screen-home">
      <AppBar large title={t('tab.home')} />
      <div className="min-h-0 flex-1 overflow-y-auto px-5 pb-6">
        <div className="flex flex-col items-center gap-2 pt-24 text-center text-ink-3">
          <div className="m-h3 text-ink-2">{t('home.balance')}</div>
          <div className="m-num text-4xl text-ink">€ —</div>
        </div>
      </div>
    </div>
  );
}
