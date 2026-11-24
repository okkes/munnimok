import { useMemo, useState } from 'react';
import { useQuery } from '@/db/useQuery';
import { useData } from '@/app/data';
import { useNavigate } from '@tanstack/react-router';
import { LOCALES, useLang } from '@/i18n';
import type { Lang } from '@/i18n';
import { useGlobalReceipts, useStoreConnMetas } from '@/application/connections';
import type { FetchedRange } from '@/application/connections';
import { ReceiptAiConsentSheet } from '@/features/shopping/ReceiptAiRead';
import { ReceiptList } from '@/features/shopping/ReceiptList';
import { receiptAiChoice, receiptAutoRead, setReceiptAutoRead } from '@/features/shopping/receiptAi';
import { getApiCapabilities } from '@/lib/api';
import { AppBar, IconButton } from '@/ui/AppBar';
import { Button } from '@/ui/Button';
import { Icon } from '@/ui/Icon';
import { Pill, Row } from '@/ui/primitives';
import { resultStillFresh, useSyncActivity } from './syncActivity';
import type { SyncActivity } from './syncActivity';

type Translate = ReturnType<typeof useLang>['t'];

const fmtDay = (iso: string, lang: Lang) => new Date(iso).toLocaleDateString(LOCALES[lang], { day: 'numeric', month: 'short', year: 'numeric' });

export function rangeLine(range: FetchedRange | undefined, t: Translate, lang: Lang): string {
  if (!range || range.count === 0) return t('conn.rangeNone');
  return t('conn.range', { from: fmtDay(range.from, lang), to: fmtDay(range.to, lang), n: range.count });
}

/** #460: a sync gone on to older history, with the oldest day it reached so far */
export const olderLine = (reached: string, t: Translate, lang: Lang): string => t('conn.syncOlder', { date: fmtDay(reached, lang) });

export function activityLine(activity: SyncActivity | undefined, t: Translate, lang: Lang): { text: string; busy: boolean } | null {
  if (!activity) return null;
  if (activity.phase === 'fetching') {
    if (activity.older) return { text: olderLine(activity.older, t, lang), busy: true };
    return { text: activity.found === null ? t('receipts.fetching') : t('receipts.fetchingFound', { n: activity.found }), busy: true };
  }
  if (!resultStillFresh(activity)) return null;
  const report = activity.report;
  if (report.status !== 'ok') return null;
  let text = t('receipts.fetchedDone', { n: report.added });
  if (report.partial) text += ` · ${t('conn.syncPartial')}`;
  if (report.olderPending) text += ` · ${t('conn.syncOlderLater')}`;
  return { text, busy: false };
}

/** #648: a photo is read as soon as it is taken; switching it on is also the say-so the reader asks for once */
function AutoReadRow() {
  const { t } = useLang();
  const [on, setOn] = useState(receiptAutoRead);
  const [asking, setAsking] = useState(false);
  const set = (next: boolean) => {
    setReceiptAutoRead(next);
    setOn(next);
  };
  const toggle = () => {
    if (on) set(false);
    else if (receiptAiChoice() === 'yes') set(true);
    else setAsking(true);
  };
  return (
    <>
      <Row
        testId="receipts-autoread-toggle"
        icon="text-recognition"
        title={t('receipts.autoRead')}
        sub={t('receipts.autoReadSub')}
        chevron={false}
        trailing={
          <Pill tone={on ? 'accent' : 'neutral'} testId="receipts-autoread-state">
            {on ? 'ON' : 'OFF'}
          </Pill>
        }
        onClick={toggle}
      />
      <ReceiptAiConsentSheet open={asking} onOpenChange={setAsking} onAnswer={(agreed) => set(agreed)} />
    </>
  );
}

// the person's own receipts: what their shops handed over and what they scanned, with no linking (a space's business)
export function ConnectionReceiptsScreen() {
  const { t, lang } = useLang();
  const navigate = useNavigate();
  const { store } = useData();
  const metas = useStoreConnMetas();
  const receipts = useGlobalReceipts();
  const activity = useSyncActivity((s) => s.activity);
  const aiReader = useQuery(store, async () => (await getApiCapabilities()).receiptAi === true, []) === true;

  const items = useMemo(() => receipts?.map((receipt) => ({ receipt })), [receipts]);
  const running = (metas ?? [])
    .filter((meta) => (meta.kind ?? 'store') === 'store')
    .map((meta) => ({ meta, line: activityLine(activity[meta.id], t, lang) }))
    .filter((entry): entry is { meta: typeof entry.meta; line: { text: string; busy: boolean } } => entry.line !== null);

  return (
    <div className="m-fade flex h-full flex-col" data-testid="screen-connection-receipts">
      <AppBar
        title={t('receipts.globalTitle')}
        leading={
          <IconButton label={t('action.back')} testId="receipts-global-back" onClick={() => window.history.back()}>
            <Icon name="arrow-left" size={22} />
          </IconButton>
        }
      />
      <div className="min-h-0 flex-1 overflow-y-auto px-5 pb-6">
        <p className="mb-2 px-1 text-[12px] leading-relaxed text-ink-4" data-testid="receipts-global-note">
          {t('receipts.globalNote')}
        </p>
        {aiReader && (
          <div className="mb-3 overflow-hidden rounded-card border border-line bg-surface" data-testid="receipts-settings">
            <AutoReadRow />
          </div>
        )}
        {running.map(({ meta, line }) => (
          <p
            key={meta.id}
            className={`mb-1 flex items-center gap-1 px-1 text-[11px] ${line.busy ? 'text-accent-deep' : 'text-ink-3'}`}
            data-testid={`receipts-conn-activity-${meta.id}`}
          >
            {line.busy && <Icon name="progress-clock" size={13} color="var(--m-accent-deep)" />}
            {`${meta.displayName} · ${line.text}`}
          </p>
        ))}
        <ReceiptList
          items={items}
          fallbackCurrency="EUR"
          onOpen={(receipt) => void navigate({ to: '/connections/receipts/$receiptId', params: { receiptId: receipt.id } })}
          empty={
            <div className="flex flex-col items-center gap-2 px-6 pt-16 text-center" data-testid="receipts-global-empty">
              <Icon name="receipt-text-outline" size={34} color="var(--m-ink-4)" />
              <p className="text-[14px] font-medium text-ink-2">{t('receipts.globalEmpty')}</p>
              <p className="text-[12px] text-ink-4">{t('receipts.globalEmptyBody')}</p>
              <Button variant="outline" size="sm" data-testid="receipts-global-connect" onClick={() => void navigate({ to: '/connections' })}>
                {t('conn.title')}
              </Button>
            </div>
          }
        />
      </div>
    </div>
  );
}
