import { isSpecialCategory } from '@/domain/categories';
import { useLang } from '@/i18n';

// special categories carry system meaning (buckets count them, movements force them)
// #244: the income family wears it too (direction is gone: the mark says "counts as income") and stays open to user subs
export function SpecialCatMark({ cat, color }: Readonly<{ cat: { id: string; parentId?: string }; color?: string }>) {
  const { t } = useLang();
  const incomeFamily = cat.id === 'income' || cat.parentId === 'income';
  if (!isSpecialCategory(cat) && !incomeFamily) return null;
  return (
    <span
      data-testid={`speccat-${cat.id}`}
      title={t('cats.special')}
      aria-label={t('cats.special')}
      className="inline-block h-[7px] w-[7px] shrink-0 rotate-45 rounded-[1.5px]"
      style={{ background: color ?? 'var(--m-ink-3)' }}
    />
  );
}
