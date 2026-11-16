import { useState } from 'react';
import type { ReactNode } from 'react';
import { useLang } from '@/i18n';
import { Button } from './Button';
import { Sheet } from './Sheet';

/** #164: asks before a back button drops unsaved edits; render `sheet` once in the screen's tree */
export function useDiscardGuard(dirty: boolean, back: () => void): { guardedBack: () => void; sheet: ReactNode } {
  const { t } = useLang();
  const [open, setOpen] = useState(false);
  const guardedBack = dirty ? () => setOpen(true) : back;
  const sheet = (
    <Sheet open={open} onOpenChange={setOpen} title={t('sheet.discardTitle')} size="compact">
      <div className="flex flex-col gap-3 pt-1" data-testid="screen-discard">
        <p className="text-[13px] leading-relaxed text-ink-2">{t('sheet.discardBody')}</p>
        <Button data-testid="screen-discard-stay" onClick={() => setOpen(false)}>
          {t('sheet.keepEditing')}
        </Button>
        <Button
          variant="danger"
          data-testid="screen-discard-leave"
          onClick={() => {
            setOpen(false);
            back();
          }}
        >
          {t('sheet.discardConfirm')}
        </Button>
      </div>
    </Sheet>
  );
  return { guardedBack, sheet };
}
