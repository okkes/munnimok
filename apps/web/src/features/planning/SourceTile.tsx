import type { PlanSegmentKind } from '@/db/types';
import type { PlanningModel } from '@/application/planning';
import { LoanTile } from '@/features/debts/DebtsScreen';
import { KIND_ICON, RecurringVisual } from '@/features/recurring/RecurringVisual';
import { Tile } from '@/ui/primitives';
import { SEGMENT_COLOR, SEGMENT_META, softOf } from './planningUi';

/**
 * The face of a mirrored source in the plan (user 2026-10-09: "add the
 * recurring cost logos in the list at the planning"): a recurring cost's
 * brand logo covers the tile the way the recurring list shows it, a loan's
 * logo reads as on the Debts screen; without a logo the plan keeps its own
 * coloured icon tile, so the list reads like the source lists do. The
 * `model` hands the source rows over — the subject row carries no logo.
 */
export function SourceTile({
  segment,
  sourceId,
  icon,
  color,
  model,
  size = 36,
  testId,
}: Readonly<{
  segment: PlanSegmentKind;
  sourceId?: string;
  icon?: string;
  color?: string;
  model?: PlanningModel;
  size?: 36 | 48;
  /** stamped on the logo only, so a test can tell the logo tile from the icon tile */
  testId?: string;
}>) {
  const rec = segment === 'recurring' && sourceId ? model?.data.recurrings.find((r) => r.id === sourceId) : undefined;
  if (rec?.logo) {
    return (
      <Tile size={size} tone="neutral">
        <span data-testid={testId} className="absolute inset-0 rounded-[inherit]">
          <RecurringVisual rec={rec} fill active={false} />
        </span>
      </Tile>
    );
  }
  const loan = segment === 'debts' && sourceId ? model?.data.accounts.find((a) => a.id === sourceId) : undefined;
  if (loan?.logo) {
    return (
      <span data-testid={testId} className="flex shrink-0">
        <LoanTile account={loan} size={size} />
      </span>
    );
  }
  const tone = color ?? SEGMENT_COLOR[segment];
  const face = icon ?? rec?.icon ?? (rec && KIND_ICON[rec.kind]) ?? SEGMENT_META[segment].icon;
  return <Tile size={size} icon={face} bg={softOf(tone)} color={tone} />;
}
