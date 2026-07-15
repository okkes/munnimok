import type { RecurringKind, RecurringRow } from '@/db/types';
import type { TFunc } from '@/i18n';
import { Icon } from '@/ui/Icon';

export const KIND_ICON: Record<RecurringKind, string> = {
  fixed: 'home-lightning-bolt-outline',
  subscription: 'television-play',
};

/** human cadence: "Monthly", "Yearly", "Weekly", "Every 3 months", … */
export function cadenceLabel(rec: Pick<RecurringRow, 'every' | 'everyN'>, t: TFunc): string {
  const n = Math.max(1, rec.everyN ?? 1);
  if (rec.every === 'week') return n === 1 ? t('recurring.everyWeek') : t('recurring.everyNWeeks', { n });
  if (rec.every === 'year') return n === 1 ? t('recurring.everyYear') : t('recurring.everyNYears', { n });
  return n === 1 ? t('recurring.everyMonth') : t('recurring.everyNMonths', { n });
}

/** brand logo when set, the kind's MDI icon otherwise. Logo artwork
 *  renders larger than the glyph size — a 17px image looks lost in the
 *  36px tile that a 17px icon fills optically. */
export function RecurringVisual({ rec, size = 17, active = true }: Readonly<{ rec: Pick<RecurringRow, 'logo' | 'icon' | 'kind'>; size?: number; active?: boolean }>) {
  if (rec.logo) {
    const logoSize = Math.round(size * 1.75);
    return <img src={rec.logo} alt="" className="rounded-md object-contain" style={{ width: logoSize, height: logoSize }} />;
  }
  return <Icon name={rec.icon ?? KIND_ICON[rec.kind]} size={size} color={active ? 'var(--m-accent-deep)' : 'var(--m-ink-2)'} />;
}
