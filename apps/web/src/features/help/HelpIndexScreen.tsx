import { useLiveQuery } from 'dexie-react-hooks';
import { useLang } from '@/i18n';
import { useData } from '@/app/data';
import { useHelp } from './HelpContext';
import { TOURS } from './tours';
import { AppBar, IconButton } from '@/ui/AppBar';
import { Icon } from '@/ui/Icon';

/** Settings → Help & tutorials: every tour, rerunnable any time. */
export function HelpIndexScreen() {
  const { t } = useLang();
  const { db } = useData();
  const { openSlides } = useHelp();
  const seen = useLiveQuery(async () => {
    const keys = TOURS.map((tour) => `tutorialSeen_${tour.id}`);
    const rows = await db.meta.bulkGet(keys);
    return new Set(TOURS.filter((_, i) => Boolean(rows[i]?.value)).map((tour) => tour.id));
  }, [db]);

  return (
    <div className="m-fade flex h-full flex-col" data-testid="screen-help">
      <AppBar
        title={t('help.title')}
        leading={
          <IconButton label={t('action.back')} testId="help-back-btn" onClick={() => window.history.back()}>
            <Icon name="arrow-left" size={22} />
          </IconButton>
        }
      />
      <div className="min-h-0 flex-1 overflow-y-auto px-5 pb-6">
        <p className="px-1 pb-3 text-[12px] text-ink-3">{t('help.indexSub')}</p>
        <div className="overflow-hidden rounded-card border border-line bg-surface">
          {TOURS.map((tour) => (
            <button
              key={tour.id}
              data-testid={`help-tour-${tour.id}`}
              onClick={() => openSlides(tour.id)}
              className="m-tap flex w-full items-center gap-3 border-b border-line-2 px-4 py-3.5 text-left last:border-0"
            >
              <Icon name={tour.icon} size={20} color="var(--m-ink-2)" />
              <span className="min-w-0 flex-1 text-[15px] text-ink">{t(tour.titleKey)}</span>
              {seen?.has(tour.id) && (
                <span className="flex items-center gap-1 text-[11px] text-accent-deep">
                  <Icon name="check" size={14} />
                  {t('help.seen')}
                </span>
              )}
              <Icon name="chevron-right" size={18} color="var(--m-ink-4)" />
            </button>
          ))}
        </div>
      </div>
    </div>
  );
}
