import { useLang } from '@/i18n';
import type { TranslationKey } from '@/i18n';
import type { PlanBarParts, SubjectView } from '@/domain/planning';
import { planBarParts } from '@/domain/planning';
import { OVER_TARGET_STRIPES } from './planningUi';

type Part = 'spent' | 'left' | 'above' | 'over' | 'gap';

/** left to right: what the funding already paid, what it still holds, what was spent beyond it; the bare track is the part of the target nothing covers */
const DRAWN: readonly Exclude<Part, 'gap'>[] = ['spent', 'left', 'above', 'over'];

const PART_COLOR: Record<Part, string> = {
  spent: 'var(--m-accent-deep)',
  left: 'color-mix(in srgb, var(--m-accent) 50%, var(--m-surface))',
  above: 'var(--m-info)',
  over: 'var(--m-negative)',
  gap: 'var(--m-track)',
};

const PART_KEY: Record<Part, TranslationKey> = {
  spent: 'plan.bar.spent',
  left: 'plan.bar.left',
  above: 'plan.bar.above',
  over: 'plan.bar.over',
  gap: 'plan.bar.gap',
};

/** `above` set apart: what is still there splits into the part up to the target and the part beyond it */
const centsOf = (parts: PlanBarParts, part: Part, above: boolean): number =>
  ({
    spent: parts.spentCents,
    left: parts.leftCents - (above ? parts.aboveCents : 0),
    above: above ? parts.aboveCents : 0,
    over: parts.overCents,
    gap: parts.gapCents,
  })[part];

const pct = (cents: number, scale: number): string => `${(cents / scale) * 100}%`;

/** #691: one bar says where a subject's money stands — spent out of what was funded, funded and still there,
 *  not funded yet, spent beyond the funding. The legend (the sheet's) names the parts with their amounts. */
export function PlanBar({
  view,
  testId,
  legend,
  size = 'row',
  above = false,
}: Readonly<{
  view: Pick<SubjectView, 'targetCents' | 'fundedCents' | 'realizedCents'>;
  testId?: string;
  /** names every part that is not empty, with its amount */
  legend?: (cents: number) => string;
  size?: 'row' | 'sheet';
  /** #692: draws what was funded beyond the target as a part of its own (the subject's own page) */
  above?: boolean;
}>) {
  const { t } = useLang();
  const parts = planBarParts(view);
  const scale = Math.max(parts.spentCents + parts.leftCents + parts.overCents + parts.gapCents, 1);
  const cents = (part: Part): number => centsOf(parts, part, above);
  const shown: Part[] = (['spent', 'left', 'above', 'over', 'gap'] as const).filter((part) => cents(part) > 0);
  const label = shown.map((part) => t(PART_KEY[part])).join(', ');
  return (
    <>
      <div
        role="img"
        aria-label={label || t('plan.bar.gap')}
        data-testid={testId}
        className={`relative flex ${size === 'sheet' ? 'h-3' : 'h-2'} gap-px overflow-hidden rounded-full bg-track`}
      >
        {DRAWN.filter((part) => cents(part) > 0).map((part) => (
          <span
            key={part}
            data-part={part}
            data-testid={testId ? `${testId}-${part}` : undefined}
            className="h-full shrink-0 transition-[width] duration-300 ease-out"
            style={{ width: pct(cents(part), scale), background: PART_COLOR[part] }}
          />
        ))}
        {/* spent past the target while the funding still covers it (#517): stripes on exactly that stretch */}
        {parts.pastTargetCents > 0 && (
          <span
            aria-hidden
            data-testid={testId ? `${testId}-stripes` : undefined}
            className="absolute inset-y-0"
            style={{ left: pct(parts.spentCents - parts.pastTargetCents, scale), width: pct(parts.pastTargetCents, scale), backgroundImage: OVER_TARGET_STRIPES }}
          />
        )}
      </div>
      {legend && shown.length > 0 && (
        <div className="mt-1.5 flex flex-wrap gap-x-3 gap-y-0.5 text-[11px] text-ink-3" data-testid={testId ? `${testId}-legend` : undefined}>
          {shown.map((part) => (
            <span key={part} className="flex items-center gap-1.5" data-testid={testId ? `${testId}-legend-${part}` : undefined}>
              <span aria-hidden className="h-2 w-2 shrink-0 rounded-sm" style={{ background: PART_COLOR[part], outline: part === 'gap' ? '1px solid var(--m-line)' : undefined }} />
              {t(PART_KEY[part])} <span className="m-num font-semibold text-ink-2">{legend(cents(part))}</span>
            </span>
          ))}
        </div>
      )}
    </>
  );
}
