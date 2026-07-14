import { useState } from 'react';
import { LOCALES, useLang } from '@/i18n';
import { Icon } from '@/ui/Icon';
import { Sheet } from '@/ui/Sheet';
import { WHATS_NEW, latestWhatsNewVersion, useMarkWhatsNewSeen, useWhatsNewUnseen } from './releaseNotes';

/** the release-notes sheet — reachable any time from Help */
export function WhatsNewSheet({ open, onOpenChange }: Readonly<{ open: boolean; onOpenChange: (open: boolean) => void }>) {
  const { t, lang } = useLang();
  const fmtDate = (iso: string) => new Date(iso).toLocaleDateString(LOCALES[lang], { day: 'numeric', month: 'long', year: 'numeric' });

  return (
    <Sheet open={open} onOpenChange={onOpenChange} title={t('whatsnew.title')} size="tall">
      <div className="flex flex-col gap-4 pt-1" data-testid="whatsnew-list">
        {WHATS_NEW.map((entry) => (
          <div key={entry.version}>
            <div className="m-cap mb-1 px-1">
              v{entry.version} · {fmtDate(entry.date)}
            </div>
            <div className="rounded-card border border-line bg-surface px-4 py-1">
              {entry.items.map((item) => (
                <div key={item.en} className="flex gap-2.5 border-b border-line-2 py-2.5 last:border-0">
                  <Icon name="star-four-points-outline" size={15} color="var(--m-accent-deep)" />
                  <p className="min-w-0 flex-1 text-[13px] leading-relaxed text-ink-2">{item[lang]}</p>
                </div>
              ))}
            </div>
          </div>
        ))}
      </div>
    </Sheet>
  );
}

/**
 * One-line nudge on Home after an update (user request: "news
 * notification for the latest changes"). Independent of the hide-tips
 * switch — release news is information, not teaching. Dismiss or open
 * marks the current version seen; it returns on the next release.
 */
export function WhatsNewCard() {
  const { t } = useLang();
  const unseen = useWhatsNewUnseen();
  const markSeen = useMarkWhatsNewSeen();
  const [open, setOpen] = useState(false);

  if (!unseen && !open) return null;

  return (
    <>
      {unseen && (
        <div
          className="mt-3 flex items-center gap-3 rounded-card border border-accent/40 bg-accent-soft/40 px-4 py-2.5"
          data-testid="whatsnew-card"
        >
          <Icon name="bullhorn-variant-outline" size={18} color="var(--m-accent-deep)" />
          <span className="min-w-0 flex-1 text-[13px] text-ink-2">
            {t('whatsnew.cardTitle', { version: latestWhatsNewVersion() ?? '' })}
          </span>
          <button
            data-testid="whatsnew-open"
            onClick={() => {
              setOpen(true);
              markSeen();
            }}
            className="m-tap border-none bg-transparent text-[13px] font-semibold text-accent-deep"
          >
            {t('whatsnew.see')}
          </button>
          <button
            aria-label={t('action.dismiss')}
            data-testid="whatsnew-dismiss"
            onClick={markSeen}
            className="m-tap flex h-7 w-7 items-center justify-center rounded-full border-none bg-transparent"
          >
            <Icon name="close" size={16} color="var(--m-ink-4)" />
          </button>
        </div>
      )}
      <WhatsNewSheet open={open} onOpenChange={setOpen} />
    </>
  );
}
