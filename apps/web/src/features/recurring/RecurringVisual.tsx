import type { RecurringKind, RecurringRow } from '@/db/types';
import { Icon } from '@/ui/Icon';

export const KIND_ICON: Record<RecurringKind, string> = {
  fixed: 'home-lightning-bolt-outline',
  subscription: 'television-play',
};

/** brand logo when set, the kind's MDI icon otherwise */
export function RecurringVisual({ rec, size = 17, active = true }: Readonly<{ rec: Pick<RecurringRow, 'logo' | 'icon' | 'kind'>; size?: number; active?: boolean }>) {
  if (rec.logo) return <img src={rec.logo} alt="" className="object-contain" style={{ width: size, height: size }} />;
  return <Icon name={rec.icon ?? KIND_ICON[rec.kind]} size={size} color={active ? 'var(--m-accent-deep)' : 'var(--m-ink-2)'} />;
}
