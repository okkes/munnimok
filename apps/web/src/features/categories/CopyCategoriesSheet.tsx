import { useEffect, useMemo, useState } from 'react';
import { useData } from '@/app/data';
import { logActivity } from '@/application/activity';
import { useLang } from '@/i18n';
import type { SpaceRow } from '@/db/types';
import { SpacePicture } from '@/features/spaces/SpacePicture';
import { Button } from '@/ui/Button';
import { Icon } from '@/ui/Icon';
import { Sheet } from '@/ui/Sheet';
import { TickBox, enterToggles, halfRef } from '@/ui/TickBox';
import type { TickState } from '@/ui/TickBox';
import { copyFaces, copyGroupToSpace } from './categoryOps';
import type { CopyGroup } from './categoryOps';
import { catName, useCategories } from './useCategories';
import type { Cat } from './useCategories';

const idsOf = (group: CopyGroup): string[] => [...(group.main ? [group.main.id] : []), ...group.subs.map((sub) => sub.id)];

/** a group's tick: a main this space lacks reads full only with every sub along; a group joining a main here, by its subs */
function groupTick(group: CopyGroup, picked: ReadonlySet<string>): TickState {
  const subsIn = group.subs.filter((sub) => picked.has(sub.id)).length;
  if (group.main && !picked.has(group.main.id)) return 'off';
  if (!group.main && subsIn === 0) return 'off';
  return subsIn === group.subs.length ? 'checked' : 'half';
}

/** a row labels a native checkbox that wears the house tick and lends the row its focus ring (m-focus-card) */
const rowClass = 'm-tap m-focus-card relative flex w-full items-center gap-3 border-none bg-transparent py-2.5 pr-3 text-left';

/** one main of one other space: its own row (a main this space lacks, or the main here its subs join) and every sub a pick of its own */
function CopyGroupRows({
  group,
  into,
  first,
  picked,
  faces,
  onToggleGroup,
  onToggleSub,
}: Readonly<{
  group: CopyGroup;
  /** the main here the subs join */
  into: Cat | null;
  first: boolean;
  picked: ReadonlySet<string>;
  faces: ReadonlyMap<string, string>;
  onToggleGroup: (group: CopyGroup) => void;
  onToggleSub: (group: CopyGroup, subId: string) => void;
}>) {
  const { t } = useLang();
  const color = group.main?.color || into?.color || 'var(--m-ink-3)';
  const tick = groupTick(group, picked);
  return (
    <div className={first ? '' : 'border-t border-line'}>
      <label className={`${rowClass} pl-3`}>
        <input
          type="checkbox"
          data-testid={group.main ? `cats-copy-unit-${group.main.id}` : `cats-copy-into-${group.space.id}-${group.intoId}`}
          data-state={tick}
          data-quiet-focus
          ref={halfRef(tick === 'half')}
          checked={tick === 'checked'}
          onChange={() => onToggleGroup(group)}
          onKeyDown={enterToggles}
          className="sr-only"
        />
        <TickBox state={tick} />
        <Icon name={group.main?.icon ?? into?.icon ?? 'shape-outline'} size={19} color={color} />
        <span className="min-w-0 flex-1">
          <span className="block truncate text-[14px] font-semibold text-ink">{group.main?.name ?? (into ? catName(into, t) : '')}</span>
          <span className="block truncate text-[11px] text-ink-4">{t(group.main ? 'cats.copyNewMain' : 'cats.copyInto')}</span>
        </span>
      </label>
      {group.subs.map((sub) => {
        const on = picked.has(sub.id);
        return (
          <label key={sub.id} className={`${rowClass} border-t border-line-2 pl-10`}>
            <input
              type="checkbox"
              data-testid={`cats-copy-sub-${sub.id}`}
              data-quiet-focus
              checked={on}
              onChange={() => onToggleSub(group, sub.id)}
              onKeyDown={enterToggles}
              className="sr-only"
            />
            <TickBox state={on ? 'checked' : 'off'} />
            <Icon name={faces.get(sub.id) ?? sub.icon} size={17} color={color} />
            <span className="min-w-0 flex-1 truncate text-[13px] text-ink">{sub.name}</span>
          </label>
        );
      })}
    </div>
  );
}

/**
 * #390 (user): copy custom categories from the person's other spaces — per
 * space and per main, every sub on its own row to tick (r2: "I would also
 * like to see the sub categories"). A main this space lacks comes along
 * when ticked (a sub needs it); subs whose main is here already join it.
 */
export function CopyCategoriesSheet({
  open,
  onOpenChange,
  groups,
}: Readonly<{ open: boolean; onOpenChange: (open: boolean) => void; groups: readonly CopyGroup[] }>) {
  const { t } = useLang();
  const { store, repo, spaceId } = useData();
  const cats = useCategories();
  const [picked, setPicked] = useState<ReadonlySet<string>>(new Set());
  useEffect(() => {
    if (open) setPicked(new Set());
  }, [open]);

  // one computation for the rows and for the copy: what the sheet shows is what lands
  const faces = useMemo(() => copyFaces(groups, (mainId) => cats.childrenOf(mainId).map((c) => c.icon)), [groups, cats]);
  const pickedCount = groups.flatMap(idsOf).filter((id) => picked.has(id)).length;

  const toggleGroup = (group: CopyGroup) =>
    setPicked((prev) => {
      const next = new Set(prev);
      const all = groupTick(group, prev) === 'checked';
      for (const id of idsOf(group)) {
        if (all) next.delete(id);
        else next.add(id);
      }
      return next;
    });
  const toggleSub = (group: CopyGroup, subId: string) =>
    setPicked((prev) => {
      const next = new Set(prev);
      if (next.has(subId)) next.delete(subId);
      else {
        next.add(subId);
        if (group.main) next.add(group.main.id); // a sub needs its main
      }
      return next;
    });

  const copySelected = async () => {
    for (const group of groups) {
      if (groupTick(group, picked) === 'off') continue;
      await copyGroupToSpace(repo, spaceId, group, picked, faces);
      const added = group.main ? [group.main.name] : group.subs.filter((sub) => picked.has(sub.id)).map((sub) => sub.name);
      for (const name of added) void logActivity(store, repo, spaceId, 'catAdd', name);
    }
    onOpenChange(false);
  };

  const spaces = [...new Map(groups.map((g) => [g.space.id, g.space])).values()];
  return (
    <Sheet
      open={open}
      onOpenChange={onOpenChange}
      title={t('cats.copyFromSpaces')}
      size="tall"
      footer={
        <Button data-testid="cats-copy-commit" disabled={pickedCount === 0} onClick={() => void copySelected()}>
          {t('cats.copyCommit', { n: pickedCount })}
        </Button>
      }
    >
      <div data-testid="cats-copy-list" className="flex flex-col gap-4 pt-1">
        {groups.length === 0 && <p className="py-3 text-center text-[13px] text-ink-3">{t('cats.copyNone')}</p>}
        {spaces.map((space) => (
          <div key={space.id}>
            <SpaceCaption space={space} text={t('cats.copyFrom', { space: space.name })} />
            <div className="overflow-hidden rounded-card border border-line bg-surface">
              {groups
                .filter((g) => g.space.id === space.id)
                .map((group, i) => (
                  <CopyGroupRows
                    key={group.main?.id ?? `${space.id}-${group.intoId}`}
                    group={group}
                    into={group.intoId ? cats.byId(group.intoId) : null}
                    first={i === 0}
                    picked={picked}
                    faces={faces}
                    onToggleGroup={toggleGroup}
                    onToggleSub={toggleSub}
                  />
                ))}
            </div>
          </div>
        ))}
      </div>
    </Sheet>
  );
}

function SpaceCaption({ space, text }: Readonly<{ space: SpaceRow; text: string }>) {
  return (
    <div className="m-cap flex items-center gap-2 px-1 pb-1.5">
      {space.picture ? <SpacePicture space={space} className="h-4 w-4" /> : <Icon name={space.icon ?? 'leaf'} size={14} color={space.color} />}
      {text}
    </div>
  );
}
