import { useMemo } from 'react';
import type { SpacePeriodType } from '@/db/types';
import { LOCALES, useLang } from '@/i18n';
import type { TranslationKey } from '@/i18n';
import { periodUnitKey } from '@/domain/goals';
import type { Insight, InsightGroup, InsightKind, InsightParam, InsightTopic } from '@/domain/insights';
import { catName, useCategories } from '@/features/categories/useCategories';
import { useDisplayMoney } from '@/features/currency/useDisplayMoney';

const UNITS: Record<SpacePeriodType, TranslationKey> = {
  month: 'ins.unitsMonth',
  week: 'ins.unitsWeek',
  biweekly: 'ins.unitsBiweekly',
  custom: 'ins.unitsPeriod',
};

const TOPIC: Record<InsightTopic, TranslationKey> = {
  subscriptions: 'ins.topic.subscriptions',
  bills: 'ins.topic.bills',
  spending: 'ins.topic.spending',
  income: 'ins.topic.income',
  debt: 'ins.topic.debt',
  behaviour: 'ins.topic.behaviour',
  budgets: 'ins.topic.budgets',
};

/** the card title of several findings of one kind — the kinds that can repeat */
const GROUP_TITLE: Partial<Record<InsightKind, TranslationKey>> = {
  missed: 'ins.missed.group',
  salary: 'ins.salary.group',
  duplicate: 'ins.dup.group',
  creep: 'ins.creep.group',
  overlap: 'ins.overlap.group',
  habit: 'ins.habit.group',
  drift: 'ins.drift.group',
  budget: 'ins.budget.group',
};

/** the one piece of advice a card of several gives */
const GROUP_HINT: Partial<Record<InsightKind, TranslationKey>> = {
  missed: 'ins.missed.groupHint',
  salary: 'ins.salary.groupHint',
  duplicate: 'ins.dup.groupHint',
  creep: 'ins.creep.groupHint',
  overlap: 'ins.overlap.groupHint',
  habit: 'ins.habit.groupHint',
  drift: 'ins.drift.groupHint',
  budget: 'ins.budget.groupHint',
};

/** kinds whose impact is money per year — a card of several adds them up; the others name what they are about */
const SUMMED: ReadonlySet<InsightKind> = new Set(['creep', 'overlap', 'habit', 'budget']);

/** #530: the figures a card quotes that tell what comes in or what is owed — they hide with the sensitive ones */
const SENSITIVE_PARAMS: Partial<Record<InsightKind, ReadonlySet<string>>> = {
  salary: new Set(['amount']),
  debtclear: new Set(['amount']),
};

const noon = (iso: string): Date => {
  const [y, m, d] = iso.split('-').map(Number);
  return new Date(y, m - 1, d, 12);
};

export interface InsightText {
  title: (group: InsightGroup) => string;
  /** the line under the title: what is at stake, or what the card is about */
  sub: (group: InsightGroup) => string;
  topic: (group: InsightGroup) => string;
  detail: (insight: Insight) => string;
  /** one finding inside a card of several */
  line: (insight: Insight) => string;
  hint: (group: InsightGroup) => string;
}

/** the words of an insight card, shared by the Insights screen and Home's block */
export function useInsightText(currency: string): InsightText {
  const { t, lang } = useLang();
  const cats = useCategories();
  const { fmt, fmtSensitive } = useDisplayMoney();
  return useMemo(() => {
    const word = (value: InsightParam, sensitive = false): string | number => {
      if (typeof value === 'string' || typeof value === 'number') return value;
      if ('money' in value) return (sensitive ? fmtSensitive : fmt)(value.money, value.currency ?? currency);
      if ('date' in value) return noon(value.date).toLocaleDateString(LOCALES[lang], { day: 'numeric', month: 'short' });
      // 4 Jan 2026 is a Sunday: weekday 0 … 6 from there
      if ('weekday' in value) return new Date(2026, 0, 4 + value.weekday, 12).toLocaleDateString(LOCALES[lang], { weekday: 'long' });
      if ('cat' in value) return catName(cats.byId(value.cat), t);
      if ('unit' in value) return t(periodUnitKey(value.unit));
      return t(UNITS[value.units]);
    };
    const vars = (insight: Insight) =>
      Object.fromEntries(Object.entries(insight.params).map(([key, value]) => [key, word(value, SENSITIVE_PARAMS[insight.kind]?.has(key))]));
    const impact = (insight: Pick<Insight, 'severity' | 'impactCents'>) =>
      t(insight.severity === 'win' ? 'ins.impactWin' : 'ins.impactYear', { amount: fmt(insight.impactCents, currency) });
    const single = (insight: Insight) => (insight.subKey ? t(insight.subKey, vars(insight)) : impact(insight));
    return {
      title: (group) => {
        const key = GROUP_TITLE[group.kind];
        return group.members.length > 1 && key ? t(key, { n: group.members.length }) : t(group.members[0].titleKey, vars(group.members[0]));
      },
      sub: (group) => {
        if (group.members.length === 1) return single(group.members[0]);
        if (SUMMED.has(group.kind)) return impact(group);
        return group.members.map((m) => (m.about === undefined ? t(m.titleKey, vars(m)) : String(word(m.about)))).join(', ');
      },
      topic: (group) => t(TOPIC[group.members[0].topic]),
      detail: (insight) => t(insight.detailKey, vars(insight)),
      line: (insight) => t(insight.lineKey ?? insight.titleKey, vars(insight)),
      hint: (group) => {
        const key = GROUP_HINT[group.kind];
        return key ? t(key) : '';
      },
    };
  }, [t, lang, cats, fmt, fmtSensitive, currency]);
}
