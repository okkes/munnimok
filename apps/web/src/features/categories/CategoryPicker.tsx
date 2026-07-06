import { useMemo, useState } from 'react';
import { BUILTIN_CATEGORIES } from '@/domain/categories';
import type { BuiltinCategory } from '@/domain/categories';
import { useLang } from '@/i18n';
import type { TranslationKey } from '@/i18n';
import { Icon } from '@/ui/Icon';
import { Sheet } from '@/ui/Sheet';

interface CategoryPickerProps {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  selectedId?: string;
  onPick: (catId: string) => void;
}

/** Bottom sheet listing the catalog grouped by parent, with search. */
export function CategoryPicker({ open, onOpenChange, selectedId, onPick }: CategoryPickerProps) {
  const { t } = useLang();
  const [query, setQuery] = useState('');

  const groups = useMemo(() => {
    const name = (c: BuiltinCategory) => t(c.nameKey as TranslationKey);
    const q = query.trim().toLowerCase();
    const parents = BUILTIN_CATEGORIES.filter((c) => c.isParent && !c.hidden);
    return parents
      .map((parent) => ({
        parent,
        children: BUILTIN_CATEGORIES.filter(
          (c) => c.parentId === parent.id && !c.hidden && (!q || name(c).toLowerCase().includes(q)),
        ),
      }))
      .filter((g) => g.children.length > 0);
  }, [query, t]);

  const pick = (catId: string) => {
    onPick(catId);
    onOpenChange(false);
    setQuery('');
  };

  return (
    <Sheet open={open} onOpenChange={onOpenChange} title={t('screen.categories')} height={620}>
      <input
        data-testid="catpicker-search"
        value={query}
        onChange={(e) => setQuery(e.target.value)}
        placeholder={t('cats.searchPlaceholder')}
        className="mb-2 h-11 w-full rounded-input border border-line bg-surface px-4 text-[15px] text-ink outline-none placeholder:text-ink-4"
      />
      {groups.map(({ parent, children }) => (
        <div key={parent.id}>
          <div className="m-cap mt-3 mb-1 flex items-center gap-1.5 px-1" style={{ color: parent.color }}>
            <Icon name={parent.icon} size={14} />
            {t(parent.nameKey as TranslationKey)}
          </div>
          {children.map((cat) => (
            <button
              key={cat.id}
              data-testid={`catpicker-${cat.id}`}
              onClick={() => pick(cat.id)}
              className="m-tap flex w-full items-center gap-3 border-none bg-transparent px-1 py-2.5 text-left text-[14px] text-ink"
            >
              <Icon name={cat.icon} size={19} color={parent.color} />
              <span className="flex-1">{t(cat.nameKey as TranslationKey)}</span>
              {selectedId === cat.id && <Icon name="check" size={18} color="var(--m-accent)" />}
            </button>
          ))}
        </div>
      ))}
    </Sheet>
  );
}
