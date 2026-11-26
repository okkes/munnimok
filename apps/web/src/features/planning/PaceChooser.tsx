import { LOCALES, useLang } from '@/i18n';
import type { PlanRow } from '@/db/types';
import type { PlanningModel, PlanningOps } from '@/application/planning';
import { paceOf, recurringDueFrom, setAsideChoice } from '@/domain/planning';
import type { PaceOffer, PlanPace, SetAsideChoice, SubjectView } from '@/domain/planning';
import { parseLocalDate } from '@/application/planningModel';
import { Icon } from '@/ui/Icon';
import type { MoneyFmt } from './SegmentSection';

const DEFAULT_SPACE = { periodType: 'month', periodDay: 1 } as const;

const TITLE_KEY = { spread: 'plan.pace.spread', catchUp: 'plan.pace.catchUp' } as const;

function offerText(offer: PaceOffer, choice: SetAsideChoice, t: ReturnType<typeof useLang>['t'], money: (cents: number) => string): string {
  if (offer.pace === 'spread') return t('plan.pace.spreadSub', { now: money(offer.nowCents) });
  const place = { k: choice.cycle.periodNo, total: choice.cycle.periods, later: money(offer.laterCents) };
  // on pace already: this period asks for one share like every other, so there is no "then"
  return offer.nowCents === offer.laterCents ? t('plan.pace.catchUpEven', place) : t('plan.pace.catchUpSub', { ...place, now: money(offer.nowCents) });
}

/** #692: a cost that is not due every period — a yearly bill in a monthly plan — is set aside one of two ways, and the
 *  subject says what each asks for now and afterwards. The choice is the cost's, so the next period's plan reads it too. */
export function PaceChooser({
  view,
  model,
  plan,
  ops,
  fmt,
  currency,
  canEdit,
}: Readonly<{ view: SubjectView; model: PlanningModel; plan: PlanRow; ops: PlanningOps; fmt: MoneyFmt; currency: string; canEdit: boolean }>) {
  const { t, lang } = useLang();
  const rec = view.subject.segment === 'recurring' ? model.data.recurrings.find((r) => r.id === view.subject.sourceId) : undefined;
  if (!rec) return null;
  const space = model.data.space ?? DEFAULT_SPACE;
  const period = model.periodOf(plan);
  const choice = setAsideChoice(rec, space, period, view.carriedCents);
  const due = recurringDueFrom(rec, period);
  if (!choice || !due) return null;
  const chosen = paceOf(rec);
  const money = (cents: number) => fmt(cents, currency);
  const facts = {
    amount: money(Math.abs(rec.amountCents)),
    date: parseLocalDate(due).toLocaleDateString(LOCALES[lang], { day: 'numeric', month: 'short', year: 'numeric' }),
    n: choice.cycle.periodsLeft,
  };
  const pick = (pace: PlanPace) => {
    if (pace !== chosen) void ops.setPace(view.subject.id, pace);
  };
  return (
    <div data-testid="plan-pace">
      <div className="m-cap px-1">{t('plan.pace.title')}</div>
      <p className="mt-1 px-1 text-[12px] leading-snug text-ink-3" data-testid="plan-pace-facts">
        {view.carriedCents > 0 ? t('plan.pace.factsCarried', { ...facts, carried: money(view.carriedCents) }) : t('plan.pace.facts', facts)}
      </p>
      <div className="mt-2 flex flex-col gap-2" role="radiogroup" aria-label={t('plan.pace.title')}>
        {choice.offers.map((offer) => {
          const on = offer.pace === chosen;
          return (
            <button
              key={offer.pace}
              type="button"
              role="radio"
              aria-checked={on}
              disabled={!canEdit}
              data-testid={`plan-pace-${offer.pace}`}
              onClick={() => pick(offer.pace)}
              className={`m-tap flex w-full items-start gap-3 rounded-card border px-3 py-2.5 text-left disabled:opacity-70 ${on ? 'border-accent bg-accent-soft/40' : 'border-line bg-surface'}`}
            >
              <Icon name={on ? 'radiobox-marked' : 'radiobox-blank'} size={20} color={on ? 'var(--m-accent-deep)' : 'var(--m-ink-4)'} />
              <span className="min-w-0 flex-1">
                <span className="flex items-baseline justify-between gap-3">
                  <span className="text-[14px] font-medium text-ink">{t(TITLE_KEY[offer.pace])}</span>
                  <span className="m-num shrink-0 text-[14px] font-semibold text-ink" data-testid={`plan-pace-${offer.pace}-now`}>
                    {money(offer.nowCents)}
                  </span>
                </span>
                <span className="mt-0.5 block text-[12px] leading-snug text-ink-3" data-testid={`plan-pace-${offer.pace}-sub`}>
                  {offerText(offer, choice, t, money)}
                </span>
              </span>
            </button>
          );
        })}
      </div>
    </div>
  );
}
