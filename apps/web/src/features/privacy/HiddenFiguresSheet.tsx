import { useNavigate } from '@tanstack/react-router';
import { useLang } from '@/i18n';
import { Button } from '@/ui/Button';
import { Sheet } from '@/ui/Sheet';
import { setHideSensitiveFocusIntent } from './sensitive';

/** #530: why the balance reads as stars, and the way to the switch that does it */
export function HiddenFiguresSheet({ open, onOpenChange }: Readonly<{ open: boolean; onOpenChange: (open: boolean) => void }>) {
  const { t } = useLang();
  const navigate = useNavigate();
  return (
    <Sheet open={open} onOpenChange={onOpenChange} title={t('privacy.infoTitle')} size="compact">
      <div className="flex flex-col gap-3 pt-1" data-testid="privacy-info-sheet">
        <p className="text-[13px] leading-relaxed text-ink-2">{t('privacy.infoBody')}</p>
        <Button
          data-testid="privacy-info-open"
          onClick={() => {
            onOpenChange(false);
            setHideSensitiveFocusIntent();
            void navigate({ to: '/settings/global' });
          }}
        >
          {t('privacy.infoOpen')}
        </Button>
      </div>
    </Sheet>
  );
}
