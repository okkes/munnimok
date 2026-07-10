import { useLiveQuery } from 'dexie-react-hooks';
import { useLang } from '@/i18n';
import { useData } from '@/app/data';
import { useHelp } from './HelpContext';
import { TOURS } from './tours';
import { AppBar, IconButton } from '@/ui/AppBar';
import { Icon } from '@/ui/Icon';
import { Row } from '@/ui/primitives';

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
            <Row
              key={tour.id}
              testId={`help-tour-${tour.id}`}
              icon={tour.icon}
              iconColor="var(--m-ink-2)"
              title={t(tour.titleKey)}
              trailing={
                seen?.has(tour.id) ? (
                  <span className="flex items-center gap-1 text-[11px] text-accent-deep">
                    <Icon name="check" size={14} />
                    {t('help.seen')}
                  </span>
                ) : undefined
              }
              onClick={() => openSlides(tour.id)}
            />
          ))}
        </div>
      </div>
    </div>
  );
}
