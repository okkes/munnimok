import { useState } from 'react';
import { useLang } from '@/i18n';
import { useData } from '@/app/data';
import { AppBar, IconButton } from '@/ui/AppBar';
import { Button } from '@/ui/Button';
import { Icon } from '@/ui/Icon';
import { Sheet } from '@/ui/Sheet';
import { catName, useCategories } from './useCategories';
import type { Cat } from './useCategories';

// curated MDI icons for custom categories
const ICONS = [
  'silverware-fork-knife', 'coffee-outline', 'cart-outline', 'cash', 'gift-outline', 'home-outline',
  'car-outline', 'bus', 'bike', 'airplane', 'gamepad-variant-outline', 'music',
  'movie-open-outline', 'book-open-outline', 'school-outline', 'heart-outline', 'medical-bag', 'pill',
  'dumbbell', 'run', 'tshirt-crew-outline', 'shoe-sneaker', 'laptop', 'cellphone',
  'sofa-outline', 'flower-outline', 'paw', 'baby-carriage', 'beach', 'tent',
  'tools', 'lightning-bolt-outline', 'water-outline', 'fire', 'leaf', 'tag-outline',
];

export function ManageCategoriesScreen() {
  const { t } = useLang();
  const { repo, spaceId } = useData();
  const cats = useCategories();
  const [formOpen, setFormOpen] = useState(false);
  const [editing, setEditing] = useState<Cat | null>(null);
  const [name, setName] = useState('');
  const [parentId, setParentId] = useState<string>('consumption');
  const [icon, setIcon] = useState(ICONS[0]);

  const openCreate = () => {
    setEditing(null);
    setName('');
    setParentId('consumption');
    setIcon(ICONS[0]);
    setFormOpen(true);
  };
  const openEdit = (cat: Cat) => {
    setEditing(cat);
    setName(cat.name ?? '');
    setParentId(cat.parentId ?? 'consumption');
    setIcon(cat.icon);
    setFormOpen(true);
  };

  const save = () => {
    if (!name.trim()) return;
    const parent = cats.byId(parentId);
    void repo.upsert('category', spaceId, editing?.id ?? repo.newId(), {
      parentId,
      name: name.trim(),
      icon,
      color: '',
      txType: parent.txTypes[0] ?? 'expense',
      sortOrder: 999,
      builtin: 0,
    });
    setFormOpen(false);
  };
  const remove = () => {
    if (!editing) return;
    void repo.remove('category', spaceId, editing.id);
    setFormOpen(false);
  };

  return (
    <div className="m-fade flex h-full flex-col" data-testid="screen-manage-cats">
      <AppBar
        title={t('screen.categories')}
        leading={
          <IconButton label={t('action.back')} testId="cats-back" onClick={() => window.history.back()}>
            <Icon name="chevron-left" size={24} />
          </IconButton>
        }
        trailing={
          <IconButton label={t('cats.addCustom')} testId="cats-add" onClick={openCreate}>
            <Icon name="plus" size={22} />
          </IconButton>
        }
      />
      <div className="min-h-0 flex-1 overflow-y-auto px-5 pb-6">
        {cats.parents.map((parent) => (
          <div key={parent.id}>
            <div className="m-cap mt-5 mb-1 flex items-center gap-1.5 px-1" style={{ color: parent.color }}>
              <Icon name={parent.icon} size={14} />
              {catName(parent, t)}
            </div>
            <div className="overflow-hidden rounded-card border border-line bg-surface">
              {cats.childrenOf(parent.id).map((cat, i) => (
                <div key={cat.id}>
                  {i > 0 && <div className="mx-4 h-px bg-line-2" />}
                  <button
                    data-testid={`managecat-${cat.id}`}
                    disabled={!cat.custom}
                    onClick={() => openEdit(cat)}
                    className="m-tap flex w-full items-center gap-3 border-none bg-transparent px-4 py-3 text-left text-[14px] text-ink disabled:pointer-events-none"
                  >
                    <Icon name={cat.icon} size={19} color={parent.color} />
                    <span className="flex-1">{catName(cat, t)}</span>
                    {cat.custom && (
                      <>
                        <span className="rounded bg-accent-soft px-1.5 py-0.5 text-[10px] font-semibold text-accent-deep">
                          {t('cats.customBadge')}
                        </span>
                        <Icon name="pencil-outline" size={16} color="var(--m-ink-4)" />
                      </>
                    )}
                  </button>
                </div>
              ))}
            </div>
          </div>
        ))}
      </div>

      {/* create / edit custom category */}
      <Sheet
        open={formOpen}
        onOpenChange={setFormOpen}
        title={editing ? t('cats.editCustom') : t('cats.addCustom')}
        height={560}
      >
        <div className="flex flex-col gap-3 pt-1">
          <input
            data-testid="catform-name"
            value={name}
            onChange={(e) => setName(e.target.value)}
            placeholder={t('cats.name')}
            className="h-12 w-full rounded-input border border-line bg-surface px-4 text-[15px] text-ink outline-none placeholder:text-ink-4"
          />
          {/* parent picker */}
          <div className="flex gap-2 overflow-x-auto pb-1">
            {cats.parents.map((p) => (
              <button
                key={p.id}
                data-testid={`catform-parent-${p.id}`}
                onClick={() => setParentId(p.id)}
                className={`m-tap shrink-0 rounded-full border px-3 py-1.5 text-[12px] ${
                  parentId === p.id
                    ? 'border-accent bg-accent-soft font-medium text-accent-deep'
                    : 'border-line bg-surface text-ink-2'
                }`}
              >
                {catName(p, t)}
              </button>
            ))}
          </div>
          {/* icon grid */}
          <div className="grid grid-cols-6 gap-2">
            {ICONS.map((name_) => (
              <button
                key={name_}
                data-testid={`catform-icon-${name_}`}
                onClick={() => setIcon(name_)}
                className={`m-tap flex h-11 items-center justify-center rounded-xl border ${
                  icon === name_ ? 'border-accent bg-accent-soft text-accent-deep' : 'border-line bg-surface text-ink-2'
                }`}
              >
                <Icon name={name_} size={20} />
              </button>
            ))}
          </div>
          <Button data-testid="catform-save" onClick={save} disabled={!name.trim()}>
            {editing ? t('action.save') : t('action.add')}
          </Button>
          {editing && (
            <Button variant="danger" data-testid="catform-delete" onClick={remove}>
              {t('action.delete')}
            </Button>
          )}
        </div>
      </Sheet>
    </div>
  );
}
