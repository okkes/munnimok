import { useLang } from '@/i18n';
import { useHelp } from './HelpContext';
import type { TourId } from './tours';
import { IconButton } from '@/ui/AppBar';
import { Icon } from '@/ui/Icon';

/** the app-bar `?` — every screen with a registered tour carries one */
export function HelpButton({ tourId }: Readonly<{ tourId: TourId }>) {
  const { t } = useLang();
  const { openSlides } = useHelp();
  return (
    <IconButton label={t('help.title')} testId={`help-btn-${tourId}`} onClick={() => openSlides(tourId)}>
      <Icon name="help-circle-outline" size={19} />
    </IconButton>
  );
}
