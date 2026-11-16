import type { PlanSegmentKind } from '@/db/types';
import type { PlanningModel } from '@/application/planning';
import { LoanTile } from '@/features/debts/DebtsScreen';
import { eventPictureStyle } from '@/features/events/EventsScreen';
import { KIND_ICON, RecurringVisual } from '@/features/recurring/RecurringVisual';
import { Tile } from '@/ui/primitives';
import { SEGMENT_COLOR, SEGMENT_META, softOf } from './planningUi';

// the subject row carries no logo: `model` hands the source rows over; without a logo the plan keeps its own icon tile
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
  // an event wears its own picture (#504), cropped as the events list crops it
  const event = segment === 'events' && sourceId ? model?.data.events.find((e) => e.id === sourceId) : undefined;
  if (event?.picture) {
    return (
      <Tile size={size} tone="neutral">
        <img data-testid={testId} src={event.picture} alt="" className="absolute inset-0 h-full w-full rounded-[inherit] object-cover" style={eventPictureStyle(event)} />
      </Tile>
    );
  }
  const tone = color ?? event?.color ?? SEGMENT_COLOR[segment];
  const face = icon ?? event?.icon ?? rec?.icon ?? (rec && KIND_ICON[rec.kind]) ?? SEGMENT_META[segment].icon;
  return <Tile size={size} icon={face} bg={softOf(tone)} color={tone} />;
}
