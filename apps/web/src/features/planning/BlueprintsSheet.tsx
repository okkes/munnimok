import { useState } from 'react';
import { useLang } from '@/i18n';
import type { PlanRow } from '@/db/types';
import type { PlanningModel, PlanningOps } from '@/application/planning';
import { brokenSubjects } from '@/domain/planning';
import { isDebtTracked } from '@/domain/debts';
import { Button } from '@/ui/Button';
import { DangerConfirmSheet } from '@/ui/DangerConfirmSheet';
import { Icon } from '@/ui/Icon';
import { Sheet } from '@/ui/Sheet';

/** how many of a blueprint's subjects point at things that no longer exist */
function brokenCount(model: PlanningModel, blueprint: PlanRow): number {
  return brokenSubjects(model.subjectsOf(blueprint), {
    catalog: model.data.catalog,
    budgetIds: new Set(model.data.budgets.map((b) => b.id)),
    recurringIds: new Set(model.data.recurrings.map((r) => r.id)),
    loanIds: new Set(model.data.accounts.filter((a) => isDebtTracked(a)).map((a) => a.id)),
    goalIds: new Set(model.data.goals.map((g) => g.id)),
  }).length;
}

function BlueprintRow({
  blueprint,
  model,
  ops,
  target,
  alsoAhead,
  onDelete,
}: Readonly<{ blueprint: PlanRow; model: PlanningModel; ops: PlanningOps; target: PlanRow; alsoAhead: boolean; onDelete: () => void }>) {
  const { t } = useLang();
  const [renaming, setRenaming] = useState(false);
  const [name, setName] = useState(blueprint.name ?? '');
  const broken = brokenCount(model, blueprint);
  const count = model.subjectsOf(blueprint).length;
  const rename = async () => {
    if (name.trim()) await ops.renameBlueprint(blueprint.id, name.trim());
    setRenaming(false);
  };
  return (
    <div className="border-b border-line-2 px-4 py-3 last:border-0" data-testid={`plan-bp-row-${blueprint.id}`}>
      <div className="flex items-center gap-2">
        {renaming ? (
          <input
            data-testid={`plan-bp-rename-input-${blueprint.id}`}
            value={name}
            onChange={(e) => setName(e.target.value)}
            onBlur={() => void rename()}
            onKeyDown={(e) => e.key === 'Enter' && void rename()}
            className="h-9 min-w-0 flex-1 rounded-input border border-line bg-surface px-3 text-[14px] text-ink outline-none"
          />
        ) : (
          <span className="min-w-0 flex-1">
            <span className="block truncate text-[14px] font-medium text-ink">{blueprint.name}</span>
            <span className="block text-[11px] text-ink-4">{t('plan.blueprints.subjects', { n: count })}</span>
          </span>
        )}
        <button
          data-testid={`plan-bp-rename-${blueprint.id}`}
          aria-label={t('plan.blueprints.rename')}
          onClick={() => setRenaming((v) => !v)}
          className="m-tap flex h-9 w-9 items-center justify-center rounded-full border-none bg-transparent text-ink-3"
        >
          <Icon name="pencil-outline" size={18} />
        </button>
        <button
          data-testid={`plan-bp-delete-${blueprint.id}`}
          aria-label={t('action.delete')}
          onClick={onDelete}
          className="m-tap flex h-9 w-9 items-center justify-center rounded-full border-none bg-transparent text-negative"
        >
          <Icon name="delete-outline" size={18} />
        </button>
      </div>
      {broken > 0 && (
        <p className="mt-1 flex items-center gap-2 text-[11px] text-warning" data-testid={`plan-bp-broken-${blueprint.id}`}>
          {t('plan.blueprints.broken', { n: broken })}
          <button data-testid={`plan-bp-repair-${blueprint.id}`} onClick={() => void ops.repairBlueprint(blueprint.id)} className="m-tap border-none bg-transparent p-0 font-semibold text-accent-deep">
            {t('plan.blueprints.repair')}
          </button>
        </p>
      )}
      <Button size="sm" variant="outline" className="mt-2" data-testid={`plan-bp-apply-${blueprint.id}`} onClick={() => void ops.applyBlueprint(blueprint.id, target, alsoAhead)}>
        {t('plan.blueprints.apply')}
      </Button>
    </div>
  );
}

/**
 * Blueprints (#128): a plan's shape saved without its money — save the
 * current plan as one (an identical twin is refused, with an override),
 * apply one to this period (and the periods ahead), repair, rename, delete.
 */
export function BlueprintsSheet({
  open,
  onOpenChange,
  model,
  plan,
  ops,
}: Readonly<{ open: boolean; onOpenChange: (open: boolean) => void; model: PlanningModel; plan: PlanRow; ops: PlanningOps }>) {
  const { t } = useLang();
  const [name, setName] = useState('');
  const [same, setSame] = useState<{ name: string; id: string } | null>(null);
  const [alsoAhead, setAlsoAhead] = useState(false);
  const [deleting, setDeleting] = useState<PlanRow | null>(null);
  const save = async (overrideId?: string) => {
    if (!name.trim()) return;
    const result = await ops.saveBlueprint(plan, name.trim(), overrideId);
    if (result.ok) {
      setName('');
      setSame(null);
    } else {
      setSame({ name: result.sameAs, id: result.sameId });
    }
  };
  return (
    <>
      <Sheet open={open} onOpenChange={onOpenChange} title={t('plan.blueprints.title')} size="tall">
        <div className="flex flex-col gap-3" data-testid="plan-blueprints">
          <p className="text-[12px] text-ink-3">{t('plan.blueprints.hint')}</p>
          {model.subjectsOf(plan).length > 0 && (
            <div className="rounded-card border border-line bg-surface p-3">
              <div className="m-cap mb-1">{t('plan.blueprints.saveCurrent')}</div>
              <div className="flex gap-2">
                <input
                  data-testid="plan-bp-name"
                  value={name}
                  onChange={(e) => {
                    setName(e.target.value);
                    setSame(null);
                  }}
                  placeholder={t('plan.blueprints.name')}
                  className="h-10 min-w-0 flex-1 rounded-input border border-line bg-surface px-3 text-[14px] text-ink outline-none placeholder:text-ink-4"
                />
                <Button size="sm" data-testid="plan-bp-save" disabled={!name.trim()} onClick={() => void save()}>
                  {t('action.save')}
                </Button>
              </div>
              {same && (
                <p className="mt-2 flex flex-wrap items-center gap-2 text-[11px] text-warning" data-testid="plan-bp-same">
                  {t('plan.blueprints.same', { name: same.name })}
                  <button data-testid="plan-bp-override" onClick={() => void save(same.id)} className="m-tap border-none bg-transparent p-0 font-semibold text-accent-deep">
                    {t('plan.blueprints.override')}
                  </button>
                </p>
              )}
            </div>
          )}
          {model.ahead.length > 0 && (
            <label className="flex items-center gap-2 px-1 text-[13px] text-ink-2">
              <input type="checkbox" data-testid="plan-bp-ahead" checked={alsoAhead} onChange={(e) => setAlsoAhead(e.target.checked)} />
              {t('plan.blueprints.applyAhead')}
            </label>
          )}
          <div className="overflow-hidden rounded-card border border-line bg-surface">
            {model.blueprints.length === 0 && (
              <p className="px-4 py-4 text-center text-[13px] text-ink-4" data-testid="plan-bp-none">
                {t('plan.blueprints.none')}
              </p>
            )}
            {model.blueprints.map((blueprint) => (
              <BlueprintRow key={blueprint.id} blueprint={blueprint} model={model} ops={ops} target={plan} alsoAhead={alsoAhead} onDelete={() => setDeleting(blueprint)} />
            ))}
          </div>
        </div>
      </Sheet>
      <DangerConfirmSheet
        open={deleting !== null}
        onOpenChange={(next) => !next && setDeleting(null)}
        title={t('plan.blueprints.deleteTitle', { name: deleting?.name ?? '' })}
        body={t('plan.blueprints.deleteBody')}
        confirmLabel={t('action.delete')}
        testId="plan-bp-delete-confirm"
        onConfirm={() => {
          if (deleting) void ops.deleteBlueprint(deleting.id).then(() => setDeleting(null));
        }}
      />
    </>
  );
}
