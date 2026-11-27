import { useMemo, useState } from 'react';
import { useQuery } from '@/db/useQuery';
import { useData } from '@/app/data';
import { useNavigate } from '@tanstack/react-router';
import { LOCALES, useLang } from '@/i18n';
import type { Lang } from '@/i18n';
import { useSettingsArrivals } from '@/application/accountSettings';
import { useConnectionOps, useGlobalReceipts, useScansSpaces, useStoreConnMetas } from '@/application/connections';
import type { FetchedRange } from '@/application/connections';
import { myScansFeedId } from '@/application/storeFeed';
import { ReceiptAiConsentSheet } from '@/features/shopping/ReceiptAiRead';
import { ReceiptList } from '@/features/shopping/ReceiptList';
import {
  receiptAiChoice,
  receiptAutoCategoriseFrom,
  receiptAutoRead,
  receiptPhotoCleanup,
  setReceiptAutoCategorise,
  setReceiptAutoRead,
  setReceiptPhotoCleanup,
} from '@/features/shopping/receiptAi';
import { useCategoriseAll } from '@/features/shopping/useCategoriser';
import { localToday } from '@/application/recurring';
import type { PhotoCleanup } from '@/features/shopping/receiptAi';
import { getApiCapabilities } from '@/lib/api';
import { AppBar, IconButton } from '@/ui/AppBar';
import { Button } from '@/ui/Button';
import { Icon } from '@/ui/Icon';
import { Pill, Row } from '@/ui/primitives';
import { Sheet } from '@/ui/Sheet';
import { useFeedSharing } from './FeedSharing';
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

/** a standing order for the reader: switching it on is also the say-so the reader asks for once */
function StandingOrderRow({
  testId,
  icon,
  title,
  sub,
  read,
  write,
}: Readonly<{ testId: string; icon: string; title: string; sub: string; read: () => boolean; write: (on: boolean) => void }>) {
  const [on, setOn] = useState(read);
  const [asking, setAsking] = useState(false);
  const set = (next: boolean) => {
    write(next);
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
        testId={`${testId}-toggle`}
        icon={icon}
        title={title}
        sub={sub}
        chevron={false}
        trailing={
          <Pill tone={on ? 'accent' : 'neutral'} testId={`${testId}-state`}>
            {on ? 'ON' : 'OFF'}
          </Pill>
        }
        onClick={toggle}
      />
      <ReceiptAiConsentSheet open={asking} onOpenChange={setAsking} onAnswer={(agreed) => set(agreed)} />
    </>
  );
}

/** #648: a photo is read as soon as it is taken */
function AutoReadRow() {
  const { t } = useLang();
  return <StandingOrderRow testId="receipts-autoread" icon="text-recognition" title={t('receipts.autoRead')} sub={t('receipts.autoReadSub')} read={receiptAutoRead} write={setReceiptAutoRead} />;
}

/** #648: the lines of receipts a shop hands over from now on get a suggested category by themselves */
function AutoCategoriseRow() {
  const { t } = useLang();
  return (
    <StandingOrderRow
      testId="receipts-autocat"
      icon="shape-outline"
      title={t('receipts.autoCat')}
      sub={t('receipts.autoCatSub')}
      read={() => receiptAutoCategoriseFrom() !== null}
      write={(on) => setReceiptAutoCategorise(on, localToday())}
    />
  );
}

/** #648: the receipts the person already has are categorised when they say so — never a whole history by itself */
function CategoriseAllRow() {
  const { t } = useLang();
  const run = useCategoriseAll();
  const [state, setState] = useState<'idle' | 'busy' | 'done' | 'none' | 'later' | 'unavailable'>('idle');
  const [count, setCount] = useState(0);
  const [more, setMore] = useState(false);
  const [asking, setAsking] = useState(false);
  const start = async () => {
    setState('busy');
    const outcome = await run();
    setCount(outcome.receipts);
    setMore(outcome.more);
    if (outcome.receipts > 0) setState('done');
    else if (outcome.state === 'limited' || outcome.state === 'capped') setState('later');
    else setState(outcome.state === 'unavailable' ? 'unavailable' : 'none');
  };
  const done = [t(count === 1 ? 'receipts.catAllDoneOne' : 'receipts.catAllDone', { n: count }), more ? t('receipts.catAllMore') : ''].filter(Boolean).join(' ');
  const note: Record<typeof state, string> = {
    idle: t('receipts.catAllSub'),
    busy: t('receipt.cats.busy'),
    done,
    none: t('receipts.catAllNone'),
    later: t('receipt.cats.later'),
    unavailable: t('receipt.ai.unavailable'),
  };
  return (
    <>
      <Row
        testId="receipts-categorise-all"
        icon="shape-plus-outline"
        title={t('receipts.catAll')}
        sub={note[state]}
        chevron={false}
        onClick={() => {
          if (state === 'busy') return;
          if (receiptAiChoice() === 'yes') void start();
          else setAsking(true);
        }}
      />
      <ReceiptAiConsentSheet open={asking} onOpenChange={setAsking} onAnswer={(agreed) => agreed && void start()} />
    </>
  );
}

const CLEANUP_MODES: readonly PhotoCleanup[] = ['off', 'verified', 'certain'];

/** #648: what becomes of a photo once it was read — the person's standing choice, per device like the reader's yes */
function PhotoCleanupRow() {
  const { t } = useLang();
  const [mode, setMode] = useState(receiptPhotoCleanup);
  const [open, setOpen] = useState(false);
  const pick = (next: PhotoCleanup) => {
    setReceiptPhotoCleanup(next);
    setMode(next);
    setOpen(false);
  };
  return (
    <>
      <Row
        testId="receipts-cleanup-row"
        icon="image-remove-outline"
        title={t('receipts.photoCleanup')}
        sub={t(`receipts.photoCleanup.${mode}`)}
        onClick={() => setOpen(true)}
      />
      <Sheet open={open} onOpenChange={setOpen} title={t('receipts.photoCleanup')} size="form">
        <div className="flex flex-col gap-2 pt-1" data-testid="receipts-cleanup-sheet">
          {CLEANUP_MODES.map((option) => (
            <button
              key={option}
              type="button"
              aria-pressed={option === mode}
              data-testid={`receipts-cleanup-${option}`}
              onClick={() => pick(option)}
              className={`m-tap flex w-full items-start gap-3 rounded-card border bg-surface px-4 py-3 text-left ${option === mode ? 'border-accent' : 'border-line'}`}
            >
              <Icon name={option === mode ? 'radiobox-marked' : 'radiobox-blank'} size={20} color={option === mode ? 'var(--m-accent-deep)' : 'var(--m-ink-4)'} />
              <span className="flex min-w-0 flex-1 flex-col">
                <span className="text-[13px] font-medium text-ink">{t(`receipts.photoCleanup.${option}`)}</span>
                <span className="text-[11px] leading-snug text-ink-4">{t(`receipts.photoCleanup.${option}Sub`)}</span>
              </span>
            </button>
          ))}
        </div>
      </Sheet>
    </>
  );
}

/** #648: a person's scans are one more source of receipts, shared with the spaces they pick like a connection's */
function ScansSharing() {
  const { t } = useLang();
  const { store } = useData();
  const ops = useConnectionOps();
  const shared = useScansSpaces();
  const spaces = useQuery(store, async () => (await store.allRows('space')).filter((s) => s.deleted === 0), []);
  const feedId = myScansFeedId();
  const sharing = useFeedSharing({ spaces: spaces ?? [], selected: shared ?? [], feedId, apply: (next) => ops.setScansSpaces(next), testId: 'receipts-scans-spaces' });
  if (!feedId || !spaces?.length) return null;
  return (
    <div className="mb-3 flex flex-col gap-1" data-testid="receipts-scans-sharing">
      <div className="m-cap px-1">{t('receipts.scansSpaces')}</div>
      <p className="px-1 text-[11px] leading-snug text-ink-4">{t('receipts.scansSpacesSub')}</p>
      {sharing.picker}
      {sharing.confirm}
    </div>
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
  // #700: the rows read their setting when they mount; one changed on another device makes them read again
  const arrivals = useSettingsArrivals();

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
          <div key={arrivals} className="mb-3 overflow-hidden rounded-card border border-line bg-surface" data-testid="receipts-settings">
            <AutoReadRow />
            <PhotoCleanupRow />
            <AutoCategoriseRow />
            <CategoriseAllRow />
          </div>
        )}
        <ScansSharing />
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
