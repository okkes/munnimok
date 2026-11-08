import { useState } from 'react';
import { useQuery } from '@/db/useQuery';
import { useNavigate } from '@tanstack/react-router';
import { useLang } from '@/i18n';
import { useData } from '@/app/data';
import { useCanEdit } from '@/app/useCanEdit';
import { useInsightDigest, useInsightOps, useInsights } from '@/application/insights';
import type { Insight, InsightGroup, InsightSeverity } from '@/domain/insights';
import { HelpButton } from '@/features/help/HelpButton';
import { AppBar, IconButton } from '@/ui/AppBar';
import { Button } from '@/ui/Button';
import { Collapse } from '@/ui/Collapse';
import { Icon } from '@/ui/Icon';
import { Tile } from '@/ui/primitives';
import { useInsightText } from './insightText';

const SEVERITY_COLOR: Record<InsightSeverity, string> = {
  alert: 'var(--m-info)',
  leak: 'var(--m-negative)',
  pattern: 'var(--m-warning)',
  win: 'var(--m-accent-deep)',
};

/** tiny inline bar chart — the legacy card's sparkline, CSS only; `focus` is the bar it stresses (the last by default) */
function MiniBars({ data, color, focus }: Readonly<{ data: number[]; color: string; focus?: number }>) {
  const max = Math.max(...data, 1);
  const stressed = focus ?? data.length - 1;
  return (
    <div className="flex h-14 items-end gap-1" data-testid="insight-chart">
      {data.map((value, i) => (
        <span
          key={`${i}-${value}`}
          className="min-w-2 flex-1 rounded-t"
          style={{ height: `${Math.max(6, (value / max) * 100)}%`, background: color, opacity: i === stressed ? 1 : 0.45 }}
        />
      ))}
    </div>
  );
}

/**
 * Insights (approved design N1, #516): ranked detector findings — what
 * needs a look now, what leaks, how you spend, what one change would win —
 * with the evidence and a door to the fix. Findings that give the same
 * advice share one card that lists them. All local math; dismissals sync
 * per space.
 */
export function InsightsScreen() {
  const { t } = useLang();
  const navigate = useNavigate();
  const { store, spaceId } = useData();
  const insights = useInsights();
  const ops = useInsightOps();
  const canEdit = useCanEdit(); // #505: a dismissal hides the card for every member
  useInsightDigest(insights);
  const space = useQuery(store, async () => store.get('space', spaceId), [spaceId]);
  const currency = space?.currency ?? 'EUR';
  const text = useInsightText(currency);
  const [open, setOpen] = useState<string | null>(null);

  const go = (insight: Insight) => {
    if (insight.actionTo) void navigate({ to: insight.actionTo });
  };

  /** one finding of a card that holds several: its line, a door when it has one */
  const renderLine = (insight: Insight) => {
    const body = <span className="min-w-0 flex-1 text-[13px] leading-snug text-ink">{text.line(insight)}</span>;
    if (!insight.actionTo) {
      return (
        <div key={insight.id} className="flex items-center gap-2 py-2.5" data-testid={`insight-line-${insight.id}`}>
          {body}
        </div>
      );
    }
    return (
      <button
        key={insight.id}
        data-testid={`insight-line-${insight.id}`}
        onClick={() => go(insight)}
        className="m-tap flex w-full items-center gap-2 border-none bg-transparent py-2.5 text-left"
      >
        {body}
        <Icon name="chevron-right" size={14} color="var(--m-ink-4)" />
      </button>
    );
  };

  const renderCard = (group: InsightGroup) => {
    const lead = group.members[0];
    const single = group.members.length === 1;
    const expanded = open === group.id;
    const color = SEVERITY_COLOR[group.severity];
    const chart = single ? (lead.chart ?? []) : [];
    return (
      <div key={group.id} className="overflow-hidden rounded-card border border-line bg-surface" data-testid={`insight-${group.id}`}>
        <button
          data-testid={`insight-head-${group.id}`}
          onClick={() => setOpen(expanded ? null : group.id)}
          className="m-tap flex w-full items-start gap-3 border-none bg-transparent px-4 py-3.5 text-left"
        >
          <Tile icon={lead.icon} bg={`color-mix(in srgb, ${color} 13%, transparent)`} color={color} />
          <span className="min-w-0 flex-1">
            <span className="block text-[14px] font-semibold text-ink">{text.title(group)}</span>
            <span className="block text-[12px]">
              <span className="text-ink-4">{text.topic(group)} · </span>
              <span className="m-num" style={{ color }} data-testid={`insight-sub-${group.id}`}>
                {text.sub(group)}
              </span>
            </span>
          </span>
          <Icon name={expanded ? 'chevron-up' : 'chevron-down'} size={16} color="var(--m-ink-4)" />
        </button>
        <Collapse open={expanded}>
          <div className="border-t border-line-2 bg-bg-2/50 px-4 py-3" data-testid={`insight-body-${group.id}`}>
            {single ? (
              <>
                {chart.length > 1 && <MiniBars data={chart} color={color} focus={lead.chartFocus} />}
                <p className="mt-2 text-[13px] leading-relaxed text-ink-2">{text.detail(lead)}</p>
              </>
            ) : (
              <>
                <p className="text-[13px] leading-relaxed text-ink-2">{text.hint(group)}</p>
                <div className="mt-1 divide-y divide-line-2" data-testid={`insight-lines-${group.id}`}>
                  {group.members.map(renderLine)}
                </div>
              </>
            )}
            <div className="mt-3 flex items-center gap-2">
              {single && lead.actionTo && (
                <Button size="sm" data-testid="insight-action" onClick={() => go(lead)}>
                  {t('ins.action')}
                </Button>
              )}
              {canEdit && (
                <button
                  data-testid="insight-dismiss"
                  onClick={() => void ops.dismiss(group.members.map((m) => m.id))}
                  className="m-tap border-none bg-transparent text-[12px] text-ink-4"
                >
                  {t(single ? 'action.dismiss' : 'ins.dismissAll')}
                </button>
              )}
            </div>
          </div>
        </Collapse>
      </div>
    );
  };

  return (
    <div className="m-fade flex h-full flex-col" data-testid="screen-insights">
      <AppBar
        title={t('ins.title')}
        leading={
          <IconButton label={t('action.back')} testId="insights-back" onClick={() => window.history.back()}>
            <Icon name="arrow-left" size={22} />
          </IconButton>
        }
        trailing={<HelpButton tourId="insights" />}
      />
      <div className="min-h-0 flex-1 overflow-y-auto px-5 pb-6">
        <p className="px-1 pb-3 text-[12px] text-ink-3">{t('ins.freshness')}</p>
        {(insights ?? []).length > 0 && <div className="flex flex-col gap-2.5">{(insights ?? []).map(renderCard)}</div>}
        {insights?.length === 0 && (
          <div className="flex flex-col items-center gap-2 px-6 pt-16 text-center" data-testid="insights-empty">
            <Icon name="lightbulb-outline" size={34} color="var(--m-ink-4)" />
            <p className="text-[14px] font-medium text-ink-2">{t('ins.emptyTitle')}</p>
            <p className="text-[12px] text-ink-4">{t('ins.emptyBody')}</p>
          </div>
        )}
      </div>
    </div>
  );
}
