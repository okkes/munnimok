import { useLang } from '@/i18n';
import { AppBar } from '@/ui/AppBar';

export function SpacesScreen() {
  const { t } = useLang();
  return (
    <div className="m-fade flex h-full flex-col" data-testid="screen-spaces">
      <AppBar large title={t('screen.spaces')} />
      <div className="min-h-0 flex-1 overflow-y-auto px-5 pb-6" />
    </div>
  );
}
