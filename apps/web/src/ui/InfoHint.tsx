import { useState } from 'react';
import { useLang } from '@/i18n';
import { Icon } from './Icon';

// #283: renders a fragment: the button joins the host's caption row, the expansion wraps onto its own line
// via `basis-full`, so the host row needs `flex-wrap`
export function InfoHint({
  text,
  testId,
  className = '',
}: Readonly<{
  text: string;
  /** the EXPANSION's testid; the button is `${testId}-toggle` */
  testId: string;
  className?: string;
}>) {
  const { t } = useLang();
  const [open, setOpen] = useState(false);
  return (
    <>
      <button
        type="button"
        data-testid={`${testId}-toggle`}
        aria-expanded={open}
        aria-label={t('ui.moreInfo')}
        onClick={() => setOpen((v) => !v)}
        className={`m-tap flex h-5 w-5 shrink-0 items-center justify-center rounded-full border-none bg-transparent p-0 text-ink-4 ${className}`}
      >
        <Icon name="information-outline" size={15} />
      </button>
      {open && (
        // m-cap hosts pass their caps styling down — neutralize it so the
        // hint reads as body copy wherever it unfolds
        <span
          data-testid={testId}
          className="w-full basis-full text-[12px] font-normal tracking-normal normal-case leading-snug text-ink-3"
        >
          {text}
        </span>
      )}
    </>
  );
}
