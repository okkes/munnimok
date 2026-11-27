import { useEffect, useState } from 'react';
import { useNavigate } from '@tanstack/react-router';
import { LOCALES, useLang } from '@/i18n';
import type { TranslationKey } from '@/i18n';
import type { PlanRow, PlanSubjectRow } from '@/db/types';
import type { PlanEditability, PlanningModel, PlanningOps } from '@/application/planning';
import { parseLocalDate } from '@/application/planningModel';
import type { Overlap, PaceOffer, PlanPace, SetAside, SubjectView } from '@/domain/planning';
import { canSkipPeriod, coverCandidates, paceOf, paceOffers, planBarParts, shortfallCents, slackCents, subjectFamily } from '@/domain/planning';
import { useData } from '@/app/data';
import { catName } from '@/features/categories/useCategories';
import { useDisplayMoney } from '@/features/currency/useDisplayMoney';
import { parseCents } from '@/lib/money';
import { AppBar, IconButton } from '@/ui/AppBar';
import { Button } from '@/ui/Button';
import { Collapse } from '@/ui/Collapse';
import { DangerConfirmSheet } from '@/ui/DangerConfirmSheet';
import { DecimalInput } from '@/ui/DecimalInput';
import { Icon } from '@/ui/Icon';
import { Row } from '@/ui/primitives';
import { Sheet } from '@/ui/Sheet';
import { AmountSuggestions } from './AmountSuggestions';
import type { AmountSuggestion } from './AmountSuggestions';
import { OverBudgetSheet, useOverBudgetGuard } from './overBudget';
import { PlanBar } from './PlanBar';
import { SETTLED_KEY } from './SegmentSection';
import type { MoneyFmt } from './SegmentSection';
import { SourceTile } from './SourceTile';

function useOpenSource() {
  const navigate = useNavigate();
  return (subject: PlanSubjectRow) => {
    const id = subject.sourceId;
    if (!id) return;
    switch (subject.segment) {
      case 'recurring':
        void navigate({ to: '/recurring/$recId', params: { recId: id } });
        break;
      case 'debts':
        void navigate({ to: '/debts/$debtId', params: { debtId: id } });
        break;
      case 'budgets':
        void navigate({ to: '/budgets/$budgetId', params: { budgetId: id } });
        break;
      case 'goals':
        void navigate({ to: '/goals/$goalId', params: { goalId: id } });
        break;
      case 'events':
        void navigate({ to: '/events/$eventId', params: { eventId: id } });
        break;
      default:
        break;
    }
  };
}

const centsText = (cents: number | null): string => (cents === null ? '' : (cents / 100).toFixed(2));

/** the sign a currency is written with ("€"); its code where the locale knows none */
function currencySign(currency: string, locale: string): string {
  try {
    return new Intl.NumberFormat(locale, { style: 'currency', currency, currencyDisplay: 'narrowSymbol' }).formatToParts(0).find((part) => part.type === 'currency')?.value ?? currency;
  } catch {
    return currency;
  }
}

// an event subject's own total (#504): empty = the event's estimate; the period's target spreads it over the periods left
function EventTotal({ view, model, ops, fmt, currency }: Readonly<{ view: SubjectView; model: PlanningModel; ops: PlanningOps; fmt: MoneyFmt; currency: string }>) {
  const { t } = useLang();
  const event = model.data.events.find((e) => e.id === view.subject.sourceId);
  const own = view.subject.targetCents ?? null;
  const [draft, setDraft] = useState(centsText(own));
  useEffect(() => setDraft(centsText(own)), [own]);
  const typed = draft.trim() ? parseCents(draft) : null;
  const valid = draft.trim() === '' || (typed !== null && typed >= 0);
  const estimate = event?.budgetCents ?? null;
  let note = t('plan.event.noEstimate');
  if (own !== null) note = t('plan.event.ownTotal');
  else if (estimate !== null) note = t('plan.event.fromEstimate', { amount: fmt(estimate, currency) });
  return (
    <div data-testid="plan-event-total">
      <div className="px-1 text-[13px] font-semibold text-ink-2">{t('plan.event.total', { currency })}</div>
      <div className="mt-1.5 flex gap-2">
        <input
          data-testid="plan-event-total-input"
          inputMode="decimal"
          value={draft}
          placeholder={estimate === null ? '0.00' : centsText(estimate)}
          onChange={(e) => setDraft(e.target.value)}
          className="h-11 min-w-0 flex-1 rounded-input border border-line bg-surface px-4 font-mono text-[14px] text-ink outline-none placeholder:text-ink-4"
        />
        <Button size="sm" variant="outline" data-testid="plan-event-total-save" disabled={!valid || typed === own} onClick={() => void ops.setOwnTarget(view.subject.id, typed)}>
          {t('action.save')}
        </Button>
      </div>
      <p className="mt-1 px-1 text-[11px] text-ink-4" data-testid="plan-event-total-note">
        {note}
      </p>
    </div>
  );
}

function OverlapNote({ overlap, model, canEdit, ops }: Readonly<{ overlap: Overlap; model: PlanningModel; canEdit: boolean; ops: PlanningOps }>) {
  const { t } = useLang();
  const { holder } = overlap;
  return (
    <p className="rounded-card bg-warning-soft px-3 py-2 text-[12px] text-ink-2" data-testid="plan-sheet-overlap">
      {t('plan.overlapNote', { name: holder.name, cats: overlap.catIds.map((id) => catName(model.data.catalog.byId(id), t)).join(', ') })}{' '}
      {canEdit && (
        <button
          type="button"
          data-testid="plan-sheet-overlap-fix"
          onClick={() => void (holder.segment === 'expenses' ? ops.freeCategories(holder.subjectId, overlap.catIds) : ops.removeSubject(holder.subjectId))}
          className="m-tap border-none bg-transparent p-0 font-semibold text-accent-deep"
        >
          {holder.segment === 'expenses' ? t('plan.overlapTake', { name: holder.name }) : t('plan.overlapRemove', { name: holder.name })}
        </button>
      )}
    </p>
  );
}

/** amounts worth a tap that the three actions do not already offer: what it spent, and an expense subject's history */
function AmountChips({
  view,
  model,
  fmt,
  currency,
  selectedCents,
  onPick,
}: Readonly<{ view: SubjectView; model: PlanningModel; fmt: MoneyFmt; currency: string; selectedCents: number | null; onPick: (cents: number) => void }>) {
  const { t } = useLang();
  const chips: AmountSuggestion[] = [];
  // #670: also once it holds MORE than it spent — a funded subject goes back to what it used in one tap
  if (view.realizedCents > 0 && view.realizedCents !== view.fundedCents) chips.push({ id: 'spent', label: t('plan.fund.chipSpent'), cents: view.realizedCents });
  if (view.subject.segment === 'expenses') {
    const estimate = model.estimate(subjectFamily(view.subject, model.data.catalog));
    if (estimate.lastCents !== null) chips.push({ id: 'last', label: t('plan.subject.estimateLast'), cents: estimate.lastCents });
    if (estimate.averageCents !== null) chips.push({ id: 'avg', label: t('plan.subject.estimateAvg'), cents: estimate.averageCents });
  }
  if (chips.length === 0) return null;
  return (
    <div className="mt-2">
      <AmountSuggestions items={chips} fmt={fmt} currency={currency} testIdPrefix="plan-fund-chip" selectedCents={selectedCents} onPick={onPick} hint={false} />
    </div>
  );
}

export function CoverSheet({
  open,
  onOpenChange,
  model,
  plan,
  view,
  fmt,
  currency,
  onCover,
}: Readonly<{
  open: boolean;
  onOpenChange: (open: boolean) => void;
  model: PlanningModel;
  plan: PlanRow;
  view: SubjectView | null;
  fmt: MoneyFmt;
  currency: string;
  onCover: (fromId: string, cents: number) => void;
}>) {
  const { t } = useLang();
  if (!view) return null;
  const need = Math.max(view.realizedCents - view.fundedCents, shortfallCents(view), 0);
  const candidates = coverCandidates(model.viewsOf(plan), view.subject.id);
  const picks = new Set(candidates.picks.map((c) => c.subject.id));
  const others = candidates.all.filter((c) => !picks.has(c.subject.id));
  const row = (candidate: SubjectView) => {
    const spare = slackCents(candidate);
    const { subject } = candidate;
    return (
      <Row
        key={subject.id}
        kind="data"
        testId={`plan-cover-${subject.id}`}
        leading={<SourceTile segment={subject.segment} sourceId={subject.sourceId} icon={subject.icon} color={subject.color} model={model} />}
        title={candidate.subject.name}
        sub={t('plan.cover.spare', { amount: fmt(spare, currency) })}
        trailing={<span className="m-num text-[13px] font-semibold text-ink">{fmt(Math.min(spare, need), currency)}</span>}
        chevron={false}
        onClick={() => onCover(candidate.subject.id, Math.min(spare, need))}
      />
    );
  };
  return (
    <Sheet open={open} onOpenChange={onOpenChange} title={t('plan.cover.title')} size="tall">
      <div data-testid="plan-cover-list">
        {candidates.all.length === 0 && <p className="py-4 text-center text-[13px] text-ink-4">{t('plan.cover.none')}</p>}
        {candidates.picks.length > 0 && <div className="m-cap mt-1 mb-1 px-1">{t('plan.cover.picks')}</div>}
        {candidates.picks.length > 0 && <div className="overflow-hidden rounded-card border border-line bg-surface">{candidates.picks.map(row)}</div>}
        {others.length > 0 && <div className="m-cap mt-3 mb-1 px-1">{t('plan.cover.others')}</div>}
        {others.length > 0 && <div className="overflow-hidden rounded-card border border-line bg-surface">{others.map(row)}</div>}
      </div>
    </Sheet>
  );
}

const PACE_TITLE: Record<PlanPace, TranslationKey> = { spread: 'plan.pace.spread', catchUp: 'plan.pace.catchUp' };

type Money = (cents: number) => string;

function paceLine(offer: PaceOffer, aside: SetAside, t: ReturnType<typeof useLang>['t'], money: Money): string {
  if (offer.pace === 'spread' || offer.nowCents === offer.laterCents) return t('plan.pace.spreadLine', { now: money(offer.nowCents), n: aside.cycle.periodsLeft });
  return t('plan.pace.catchUpLine', { now: money(offer.nowCents), later: money(offer.laterCents) });
}

function paceText(offer: PaceOffer, t: ReturnType<typeof useLang>['t'], money: Money): string {
  if (offer.pace === 'spread') return t('plan.pace.spreadSub', { now: money(offer.nowCents) });
  // on pace already: this period asks for one share like every other, so there is no "then"
  if (offer.nowCents === offer.laterCents) return t('plan.pace.catchUpEven', { later: money(offer.laterCents) });
  return t('plan.pace.catchUpSub', { now: money(offer.nowCents), later: money(offer.laterCents) });
}

/** #692: money that leaves in a later period — a yearly bill, a loan payment, a goal, an event — is set aside one of
 *  two ways. The card says which and what it asks for; opened, it offers both. */
function FundingPlan({
  aside,
  offers,
  pace,
  onPace,
  canEdit,
  money,
}: Readonly<{ aside: SetAside; offers: readonly PaceOffer[]; pace: PlanPace; onPace: (pace: PlanPace) => void; canEdit: boolean; money: Money }>) {
  const { t, lang } = useLang();
  const [open, setOpen] = useState(false);
  const chosen = offers.find((offer) => offer.pace === pace) ?? offers[0];
  const date = parseLocalDate(aside.due).toLocaleDateString(LOCALES[lang], { day: 'numeric', month: 'short', year: 'numeric' });
  return (
    <section data-testid="plan-pace">
      <div className="flex items-baseline justify-between gap-3 px-1">
        <h2 className="text-[13px] font-semibold text-ink-2">{t('plan.pace.title')}</h2>
        <span className="text-[12px] text-ink-3" data-testid="plan-pace-due">
          {t('plan.pace.due', { date, amount: money(aside.amountCents) })}
        </span>
      </div>
      <div className="mt-1.5 overflow-hidden rounded-card border border-line bg-surface">
        <button
          type="button"
          data-testid="plan-pace-toggle"
          aria-expanded={open}
          onClick={() => setOpen((shown) => !shown)}
          className="m-tap flex w-full items-center gap-3 border-none bg-transparent px-3.5 py-3 text-left"
        >
          <span className="flex h-10 w-10 shrink-0 items-center justify-center rounded-xl bg-accent-soft text-accent-deep">
            <Icon name="calendar-month-outline" size={20} />
          </span>
          <span className="min-w-0 flex-1">
            <span className="block text-[14px] font-semibold text-ink" data-testid="plan-pace-chosen">
              {t(PACE_TITLE[chosen.pace])}
            </span>
            <span className="block text-[12px] text-ink-3" data-testid="plan-pace-line">
              {paceLine(chosen, aside, t, money)}
            </span>
          </span>
          <Icon name={open ? 'chevron-down' : 'chevron-right'} size={20} color="var(--m-ink-4)" />
        </button>
        <Collapse open={open}>
          <div className="border-t border-line-2 px-3.5 pt-3 pb-3.5">
            <p className="text-[12px] text-ink-3" data-testid="plan-pace-facts">
              {t('plan.pace.remaining', { n: aside.cycle.periodsLeft })}
            </p>
            <div className="mt-2.5 flex flex-col gap-2" role="radiogroup" aria-label={t('plan.pace.title')}>
              {offers.map((offer) => {
                const on = offer.pace === chosen.pace;
                return (
                  <button
                    key={offer.pace}
                    type="button"
                    role="radio"
                    aria-checked={on}
                    disabled={!canEdit}
                    data-testid={`plan-pace-${offer.pace}`}
                    onClick={() => onPace(offer.pace)}
                    className={`m-tap flex w-full items-start gap-3 rounded-card border px-3 py-2.5 text-left disabled:opacity-70 ${on ? 'border-accent bg-accent-soft/40' : 'border-line bg-surface'}`}
                  >
                    <Icon name={on ? 'radiobox-marked' : 'radiobox-blank'} size={20} color={on ? 'var(--m-accent-deep)' : 'var(--m-ink-4)'} />
                    <span className="min-w-0 flex-1">
                      <span className="flex items-baseline justify-between gap-3">
                        <span className="text-[14px] font-medium text-ink">{t(PACE_TITLE[offer.pace])}</span>
                        <span className="m-num shrink-0 text-[14px] font-semibold text-ink" data-testid={`plan-pace-${offer.pace}-now`}>
                          {money(offer.nowCents)}
                        </span>
                      </span>
                      <span className="mt-0.5 block text-[12px] leading-snug text-ink-3" data-testid={`plan-pace-${offer.pace}-sub`}>
                        {paceText(offer, t, money)}
                      </span>
                    </span>
                  </button>
                );
              })}
            </div>
          </div>
        </Collapse>
      </div>
    </section>
  );
}

function ActionTile({ icon, label, testId, disabled, onClick }: Readonly<{ icon: string; label: string; testId: string; disabled: boolean; onClick: () => void }>) {
  return (
    <button
      type="button"
      data-testid={testId}
      disabled={disabled}
      onClick={onClick}
      className="m-tap flex min-w-0 flex-1 flex-col items-center gap-1.5 rounded-card border border-line bg-surface px-1.5 py-3 text-center disabled:bg-transparent disabled:opacity-45"
    >
      <Icon name={icon} size={22} color="var(--m-accent-deep)" />
      <span className="w-full text-[12px] leading-tight font-semibold text-ink">{label}</span>
    </button>
  );
}

/** what the bar's second figure says: what was spent beyond the funding, funded beyond the target, or still not funded */
function secondFigure(parts: ReturnType<typeof planBarParts>): { key: TranslationKey; cents: number; color: string } {
  if (parts.overCents > 0) return { key: 'plan.bar.over', cents: parts.overCents, color: 'var(--m-negative)' };
  if (parts.aboveCents > 0) return { key: 'plan.bar.above', cents: parts.aboveCents, color: 'var(--m-info)' };
  return { key: 'plan.bar.gap', cents: parts.gapCents, color: 'var(--m-warning)' };
}

/** #692: a plan subject on a page of its own — what it holds, what that leaves in the pool, and how money that leaves in
 *  a later period is set aside. The amount and the way of setting aside are a draft until Save changes. */
export function SubjectScreen({
  view,
  model,
  plan,
  editability,
  ops,
  fmt,
  currency,
  onClose,
  onEdit,
}: Readonly<{
  view: SubjectView;
  model: PlanningModel;
  plan: PlanRow;
  editability: PlanEditability;
  ops: PlanningOps;
  fmt: MoneyFmt;
  currency: string;
  onClose: () => void;
  onEdit: (subject: PlanSubjectRow) => void;
}>) {
  const { t, lang } = useLang();
  const { spaceId } = useData();
  const overBudget = useOverBudgetGuard(spaceId);
  const openSource = useOpenSource();
  // #530: what is left in the pool hides with the sensitive figures
  const poolMoney = useDisplayMoney().sensitive(fmt);
  const { subject } = view;
  const savedPace = paceOf(subject);
  const [draft, setDraft] = useState(() => centsText(view.fundedCents));
  const [pace, setPace] = useState<PlanPace>(savedPace);
  const [coverOpen, setCoverOpen] = useState(false);
  const [removeOpen, setRemoveOpen] = useState(false);
  useEffect(() => setDraft(centsText(view.fundedCents)), [subject.id, view.fundedCents]);
  useEffect(() => setPace(savedPace), [subject.id, savedPace]);

  const canMove = editability !== 'readOnly';
  const canEdit = editability === 'full';
  const money: Money = (cents) => fmt(cents, currency);
  const typed = parseCents(draft);
  const amount = typed ?? view.fundedCents;
  // only where the money leaves in a later period: due in this one, all of it is wanted now and there is nothing to choose
  const offers = view.orphaned || view.inPool ? null : paceOffers(view.setAside);
  const offer = offers?.find((o) => o.pace === pace);
  const target = offer && pace !== savedPace ? view.carriedCents + offer.nowCents : view.targetCents;
  const dirty = (typed !== null && typed !== view.fundedCents) || pace !== savedPace;
  const parts = planBarParts({ targetCents: target, fundedCents: amount, realizedCents: view.realizedCents });
  const second = secondFigure(parts);
  const toAllocate = model.toAllocateOf(plan);
  const needsMoney = view.status === 'overspent' || shortfallCents(view) > 0;

  const save = () => {
    if (typed === null) return;
    const write = async () => {
      if (pace !== savedPace) await ops.setPace(subject.id, pace);
      if (typed !== view.fundedCents) await ops.fund(subject.id, typed);
      onClose();
    };
    // beyond the pool asks once a day: only the part the pool must still give counts
    overBudget.guard(toAllocate, typed - view.fundedCents, () => void write());
  };

  return (
    <div className="m-fade flex h-full flex-col" data-testid="screen-plan-subject">
      <AppBar
        title={
          <span className="flex min-w-0 items-center justify-center gap-2">
            <span className="-my-1 flex shrink-0 scale-75">
              <SourceTile segment={subject.segment} sourceId={subject.sourceId} icon={subject.icon} color={subject.color} model={model} />
            </span>
            <span className="truncate" data-testid="plan-page-name">
              {subject.name}
            </span>
          </span>
        }
        leading={
          <IconButton label={t('action.back')} testId="plan-page-back" onClick={onClose}>
            <Icon name="arrow-left" size={22} />
          </IconButton>
        }
      />
      <div className="min-h-0 flex-1 overflow-y-auto px-5 pb-6">
        <div className="mx-auto flex w-full max-w-[560px] flex-col gap-4 pt-1" data-testid="plan-sheet">
          <section>
            <div className="flex items-baseline justify-between gap-3 px-1">
              <h2 className="text-[13px] font-semibold text-ink-2">{t('plan.subject.setAside')}</h2>
              {target !== null && (
                <span className="text-[12px] text-ink-3" data-testid="plan-page-target">
                  {t('plan.fund.chipTarget')} <span className="m-num font-semibold text-ink">{money(target)}</span>
                </span>
              )}
            </div>
            <label className="mt-1.5 flex items-center gap-3 rounded-card border border-line bg-surface px-4 py-3.5 focus-within:border-accent">
              <span className="text-[22px] font-medium text-ink-4">{currencySign(currency, LOCALES[lang])}</span>
              <DecimalInput
                data-testid="plan-fund-input"
                // the card's border is the focus cue
                data-quiet-focus
                aria-label={t('plan.fund.amount', { currency })}
                value={draft}
                onValue={setDraft}
                readOnly={!canMove}
                className="m-num min-w-0 flex-1 border-none bg-transparent p-0 text-[28px] leading-tight font-semibold text-ink outline-none"
              />
            </label>
            {canMove && <AmountChips view={view} model={model} fmt={fmt} currency={currency} selectedCents={typed} onPick={(cents) => setDraft(centsText(cents))} />}
            <div className="mt-3 flex items-center justify-between gap-3 px-1 text-[13px]">
              <span className="flex items-center gap-2 text-ink-3">
                <Icon name="wallet-outline" size={18} />
                {t('plan.subject.poolLeft')}
              </span>
              <span className="m-num font-semibold text-accent-deep" data-testid="plan-page-pool">
                {poolMoney(toAllocate - (amount - view.fundedCents), currency)}
              </span>
            </div>
            <div className="mt-3">
              <PlanBar view={{ targetCents: target, fundedCents: amount, realizedCents: view.realizedCents }} testId="plan-sheet-bar" size="sheet" above />
            </div>
            <div className="mt-2 grid grid-cols-2 gap-3 px-1">
              <div data-testid="plan-page-spent">
                <div className="flex items-center gap-1.5 text-[12px] text-ink-3">
                  <span aria-hidden className="h-2 w-2 rounded-full" style={{ background: 'var(--m-accent-deep)' }} />
                  {t('plan.bar.spent')}
                </div>
                <div className="m-num mt-0.5 text-[16px] font-semibold text-ink">{money(view.realizedCents)}</div>
              </div>
              <div data-testid="plan-page-second">
                <div className="flex items-center gap-1.5 text-[12px] text-ink-3">
                  <span aria-hidden className="h-2 w-2 rounded-full" style={{ background: second.color }} />
                  {t(second.key)}
                </div>
                <div className="m-num mt-0.5 text-[16px] font-semibold" style={{ color: second.color }}>
                  {money(second.cents)}
                </div>
              </div>
            </div>
          </section>

          {canMove && (
            <div className="flex gap-2">
              <ActionTile icon="undo-variant" label={t('plan.fund.empty')} testId="plan-fund-empty" disabled={amount === 0} onClick={() => setDraft(centsText(0))} />
              <ActionTile
                icon="bullseye"
                label={t('plan.fund.fill')}
                testId="plan-fund-fill"
                disabled={target === null || target <= 0 || amount === target}
                onClick={() => setDraft(centsText(target))}
              />
              {/* while the pool still has money the pool pays: taking from another subject is for when it is empty */}
              <ActionTile icon="swap-horizontal" label={t('plan.cover.title')} testId="plan-fund-cover" disabled={toAllocate > 0 || !needsMoney} onClick={() => setCoverOpen(true)} />
            </div>
          )}

          {editability === 'readOnly' && (
            <p className="rounded-card bg-bg-2 px-3 py-2 text-[12px] text-ink-3" data-testid="plan-sheet-readonly">
              {t('plan.readOnly')}
            </p>
          )}
          {view.overlaps.map((overlap) => (
            <OverlapNote key={overlap.holder.subjectId} overlap={overlap} model={model} canEdit={canEdit} ops={ops} />
          ))}
          {view.inPool && (
            <p className="rounded-card bg-bg-2 px-3 py-2 text-[12px] text-ink-3" data-testid="plan-sheet-inpool">
              {t('plan.debtInPool')}
            </p>
          )}
          {view.settledAhead && (
            <p className="rounded-card bg-bg-2 px-3 py-2 text-[12px] text-ink-3" data-testid="plan-sheet-settled">
              {t(SETTLED_KEY[subject.segment] ?? 'plan.settled.events')}
            </p>
          )}
          {view.cycles > 1 && <p className="px-1 text-[12px] text-ink-3">{t('plan.cycles', { n: view.cycles })}</p>}

          {offers && view.setAside && <FundingPlan aside={view.setAside} offers={offers} pace={pace} onPace={setPace} canEdit={canEdit} money={money} />}
          {canEdit && subject.segment === 'events' && !view.orphaned && <EventTotal view={view} model={model} ops={ops} fmt={fmt} currency={currency} />}

          <div className="overflow-hidden rounded-card border border-line bg-surface">
            {/* skip only where nothing leaves this period: a yearly cost spread out, a goal far off */}
            {canEdit && (canSkipPeriod(view) || subject.snoozed === 1) && (
              <Row
                icon="skip-next-outline"
                title={subject.snoozed === 1 ? t('plan.fund.unsnooze') : t('plan.fund.snooze')}
                testId="plan-fund-snooze"
                chevron={false}
                onClick={() => void ops.snooze(subject.id, subject.snoozed !== 1).then(onClose)}
              />
            )}
            {subject.sourceId && <Row icon="open-in-new" title={t('plan.fund.openSource')} testId="plan-fund-open" onClick={() => openSource(subject)} />}
            {canEdit && subject.segment === 'expenses' && <Row icon="pencil-outline" title={t('plan.fund.edit')} testId="plan-fund-edit" onClick={() => onEdit(subject)} />}
            {canEdit && (
              <Row
                icon="delete-outline"
                iconColor="var(--m-negative)"
                title={<span className="text-negative">{t('plan.subject.remove')}</span>}
                testId="plan-fund-remove"
                chevron={false}
                onClick={() => setRemoveOpen(true)}
              />
            )}
          </div>
        </div>
      </div>
      {canMove && (
        <div className="shrink-0 border-t border-line bg-bg px-5 pt-3 pb-3">
          <div className="mx-auto w-full max-w-[560px]">
            <Button className="w-full" data-testid="plan-fund-save" disabled={!dirty || typed === null} onClick={save}>
              {t('plan.subject.save')}
            </Button>
          </div>
        </div>
      )}
      <OverBudgetSheet guard={overBudget} fmt={fmt} currency={currency} />
      <CoverSheet
        open={coverOpen}
        onOpenChange={setCoverOpen}
        model={model}
        plan={plan}
        view={view}
        fmt={fmt}
        currency={currency}
        onCover={(fromId, cents) => {
          void ops.cover(fromId, subject.id, cents).then(() => setCoverOpen(false));
        }}
      />
      <DangerConfirmSheet
        open={removeOpen}
        onOpenChange={setRemoveOpen}
        title={t('plan.subject.remove')}
        body={t('plan.subject.removeNote')}
        confirmLabel={t('action.delete')}
        cooldown={0}
        testId="plan-remove-confirm"
        onConfirm={() => {
          void ops.removeSubject(subject.id).then(() => {
            setRemoveOpen(false);
            onClose();
          });
        }}
      />
    </div>
  );
}
