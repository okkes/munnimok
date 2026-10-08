import { LOCKED_MAIN_IDS } from '@/domain/categories';
import { useLang } from '@/i18n';
import { catName, useCategories } from '@/features/categories/useCategories';
import { Icon } from '@/ui/Icon';
import { Sheet } from '@/ui/Sheet';

/**
 * The built-in card's scope: all expenses, one main, or one sub — mains
 * first, tapping a main offers its subs. The custom graphs have their own
 * multi-pick editor; this one-pick sheet stays for the quick look.
 */
export function CatPickerSheet({
  open,
  onOpenChange,
  catId,
  onPick,
}: Readonly<{
  open: boolean;
  onOpenChange: (open: boolean) => void;
  catId: string | undefined;
  onPick: (catId: string | undefined) => void;
}>) {
  const { t } = useLang();
  const cats = useCategories();
  const pick = (id: string | undefined) => {
    onPick(id);
    onOpenChange(false);
  };
  return (
    <Sheet open={open} onOpenChange={onOpenChange} title={t('trends.pickCategory')} size="tall" dragHandle>
      <div data-testid="trends-cat-list">
        <button
          data-testid="trends-cat-all"
          onClick={() => pick(undefined)}
          className="m-tap flex w-full items-center gap-3 border-b border-line-2 px-1 py-3 text-left text-[14px] text-ink"
        >
          <Icon name="shape-outline" size={18} color="var(--m-ink-3)" />
          <span className="flex-1">{t('trends.allExpenses')}</span>
          {catId === undefined && <Icon name="check" size={16} color="var(--m-accent-deep)" />}
        </button>
        {cats.parents
          .filter((parent) => parent.txTypes.includes('expense') && !LOCKED_MAIN_IDS.has(parent.id))
          .map((parent) => (
            <div key={parent.id}>
              <button
                data-testid={`trends-cat-${parent.id}`}
                onClick={() => pick(parent.id)}
                className="m-tap flex w-full items-center gap-3 border-b border-line-2 px-1 py-3 text-left text-[14px] text-ink"
              >
                <Icon name={parent.icon} size={18} color={parent.color} />
                <span className="flex-1 font-medium">{catName(parent, t)}</span>
                {catId === parent.id && <Icon name="check" size={16} color="var(--m-accent-deep)" />}
              </button>
              {catId && (catId === parent.id || cats.byId(catId).parentId === parent.id) &&
                cats.childrenOf(parent.id).map((sub) => (
                  <button
                    key={sub.id}
                    data-testid={`trends-cat-${sub.id}`}
                    onClick={() => pick(sub.id)}
                    className="m-tap flex w-full items-center gap-3 border-b border-line-2 py-2.5 pr-1 pl-8 text-left text-[13px] text-ink-2"
                  >
                    <Icon name={sub.icon} size={16} color={parent.color} />
                    <span className="flex-1">{catName(sub, t)}</span>
                    {catId === sub.id && <Icon name="check" size={15} color="var(--m-accent-deep)" />}
                  </button>
                ))}
            </div>
          ))}
      </div>
    </Sheet>
  );
}
