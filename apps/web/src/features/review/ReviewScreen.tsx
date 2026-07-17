import { useEffect, useMemo, useState } from 'react';
import { useLiveQuery } from 'dexie-react-hooks';
import { useSpaceTransactions, useTxTransform } from '@/application/transactions';
import type { SpaceTx } from '@/application/transactions';
import { buildSpaceMerchantMemory } from '@/application/prediction';
import { useRecurringOps, useRecurrings } from '@/application/recurring';
import { directionOfTx } from '@/domain/categoryRules';
import { merchantKey } from '@/domain/merchantKey';
import { draftReady, initDraft, withCategory, withLinkedAccount, withSplits, withType } from '@/domain/reviewDraft';
import { normalizeIban } from '@/domain/feedIds';
import { hapticNotify } from '@/lib/platform';
import { TxRow } from '@/ui/TxRow';
import { fetchSettlementCandidates } from '@/features/splits/settlementCandidates';
import type { SettlementCandidate } from '@/features/splits/settlementCandidates';
import { useSession } from '@/app/session';
import type { ReviewDraft } from '@/domain/reviewDraft';
import type { AccountType } from '@/db/types';
import { resolveSplitsFor, splitsArePct } from '@/domain/splits';
import { predictTx } from '@/domain/predictCategory';
import { recurringAmountMatches } from '@/domain/recurring';
import { LOCALES, useLang } from '@/i18n';
import { useData } from '@/app/data';
import { catName, useCategories } from '@/features/categories/useCategories';
import { fmtCents } from '@/lib/money';
import { cleanBankText } from '@/lib/text';
import { HelpButton } from '@/features/help/HelpButton';
import { IntroCard } from '@/features/help/IntroCard';
import { AppBar, IconButton } from '@/ui/AppBar';
import { Button } from '@/ui/Button';
import { Icon } from '@/ui/Icon';
import { Chip } from '@/ui/primitives';
import { Sheet } from '@/ui/Sheet';
import { CategoryPicker } from '@/features/categories/CategoryPicker';
import { SplitEditorSheet } from '@/features/transactions/SplitEditorSheet';
import { TxTypeSheet } from '@/features/transactions/TxTypeSheet';

/** why the shown category was suggested, per prediction source */
const REASON_KEYS = {
  history: 'review.reasonHistory',
  'history-amount': 'review.reasonAmount',
  keyword: 'review.reasonKeyword',
} as const;

/** progress bar + "n / total" sub line — skips count as handled too */
function progressState(initial: number | null, queueLen: number | undefined, skippedCount: number) {
  const total = initial ?? 1;
  const confirmed = initial === null ? 0 : Math.max(0, initial - (queueLen ?? 0));
  const done = confirmed + skippedCount;
  return {
    progress: initial ? done / initial : 0,
    sub: (queueLen ?? 0) > 0 ? `${Math.min(done + 1, total)} / ${total}` : undefined,
  };
}

/** the draft's value, an explicit null to clear a tx that had one, or nothing */
function replacing<K extends string, T>(key: K, next: T | undefined, had: boolean): Partial<Record<K, T>> {
  if (next !== undefined) return { [key]: next } as Partial<Record<K, T>>;
  // explicit null clears the synced field (undefined would be dropped)
  return had ? ({ [key]: null } as unknown as Partial<Record<K, T>>) : {};
}

/** one confirm: the whole DRAFT lands in one write (+ the bulk selection) */
async function writeConfirmation(args: {
  tx: SpaceTx;
  draft: ReviewDraft;
  recurringId: string | undefined;
  bulk: SpaceTx[];
  transform: (tx: SpaceTx, fields: Parameters<ReturnType<typeof useTxTransform>>[1]) => Promise<void>;
}): Promise<void> {
  const { draft } = args;
  // draft-cleared fields on a tx that HAD them need an explicit null
  const splitsField = replacing('splits', draft.splits?.length ? draft.splits : undefined, !!args.tx.splits?.length);
  const linkField = replacing('linkedAccountId', draft.linkedAccountId, !!args.tx.linkedAccountId);
  await args.transform(args.tx, {
    catId: draft.catId,
    txType: draft.txType,
    needsReview: 0,
    ...splitsField,
    ...linkField,
    ...(args.recurringId ? { recurringId: args.recurringId } : {}),
  });
  for (const item of args.bulk) {
    // the draft's split shape travels with the bulk: absolute splits fit
    // exact twins by the similar-rule; pct splits rescale per item
    const splits = draft.splits?.length ? resolveSplitsFor(item.amountCents, draft.splits) : undefined;
    await args.transform(item, {
      catId: draft.catId,
      txType: draft.txType,
      needsReview: 0,
      ...(splits ? { splits } : {}),
    });
  }
}

/** "also apply to n similar": a compact summary row on the card; the full
 *  list lives in a Sheet so long histories never squeeze the card
 *  (user request), with per-row read-only detail expansion */
/** transfers carry no spending category — the hidden 'uncategorized'
 * builtin keeps the confirm armed (settle-match chip) */
function stageAsTransfer(draft: ReviewDraft, cats: ReturnType<typeof useCategories>): ReviewDraft {
  const next = withType(draft, 'transfer', cats);
  return next.catId ? next : withCategory(next, 'uncategorized', cats);
}

/** own-account counterparty pre-applies the link + suggested type; the
 * hidden 'uncategorized' builtin keeps the confirm armed for transfers */
function applyOwnCounterDefault(
  baseDraft: ReviewDraft | null,
  ownCounter: { id: string; type: AccountType } | undefined,
  cats: ReturnType<typeof useCategories>,
): ReviewDraft | null {
  if (!baseDraft || !ownCounter || baseDraft.linkedAccountId) return baseDraft;
  const linked = withLinkedAccount(baseDraft, { id: ownCounter.id, type: ownCounter.type }, cats);
  return linked.catId ? linked : withCategory(linked, 'uncategorized', cats);
}

function BulkConfirmSection({
  similar,
  selected,
  onChange,
}: Readonly<{ similar: SpaceTx[]; selected: ReadonlySet<string>; onChange: (next: ReadonlySet<string>) => void }>) {
  const { t, lang } = useLang();
  const [open, setOpen] = useState(false);
  const [detailId, setDetailId] = useState<string | null>(null);
  if (similar.length === 0) return null;

  const all = similar.every((s) => selected.has(s.id));
  const detail = detailId ? similar.find((s) => s.id === detailId) : undefined;
  const toggleOne = (id: string) => {
    const next = new Set(selected);
    if (next.has(id)) next.delete(id);
    else next.add(id);
    onChange(next);
  };

  return (
    <div className="mt-3 overflow-hidden rounded-card border border-line bg-surface" data-testid="review-bulk">
      <div className="flex items-center gap-3 px-4 py-3">
        <button
          data-testid="review-bulk-toggle"
          aria-label={t('review.alsoApply', { n: similar.length })}
          onClick={() => onChange(all ? new Set() : new Set(similar.map((s) => s.id)))}
          className={`m-tap flex h-5 w-5 shrink-0 items-center justify-center rounded-md border-2 ${
            all ? 'border-accent bg-accent text-white' : 'border-line bg-surface'
          }`}
        >
          {all && <Icon name="check" size={12} />}
        </button>
        <span className="min-w-0 flex-1 truncate text-[13px] text-ink-2">{t('review.alsoApply', { n: selected.size })}</span>
        <button
          data-testid="review-bulk-expand"
          aria-label={t('review.alsoApply', { n: similar.length })}
          onClick={() => setOpen(true)}
          className="m-tap flex items-center gap-1 border-none bg-transparent text-[12px] text-ink-3"
        >
          {t('review.bulkViewAll')}
          <Icon name="chevron-right" size={15} />
        </button>
      </div>

      {/* near-max-height sheet styled like the transactions list (user
          redesign): TxRow rows with a checkbox rail, select/unselect all,
          and a row tap opens a compact READ-ONLY detail as a stacked sheet */}
      <Sheet open={open} onOpenChange={setOpen} title={t('review.alsoApply', { n: selected.size })} height={680}>
        <div className="flex items-center justify-between pb-2">
          <span className="text-[12px] text-ink-3">{t('review.bulkCount', { n: similar.length })}</span>
          <button
            data-testid="review-bulk-select-all"
            onClick={() => onChange(all ? new Set() : new Set(similar.map((s) => s.id)))}
            className="m-tap border-none bg-transparent text-[12px] font-semibold text-accent-deep"
          >
            {all ? t('review.bulkUnselectAll') : t('review.bulkSelectAll')}
          </button>
        </div>
        {/* fixed px so the list scrolls INSIDE the sheet (sheet rules) */}
        <div className="max-h-[540px] overflow-y-auto overscroll-contain" data-testid="review-bulk-list">
          {similar.map((item) => {
            const checked = selected.has(item.id);
            return (
              <div key={item.id} className="flex items-center gap-2 border-b border-line-2 last:border-0">
                <button
                  data-testid={`review-bulk-${item.id}`}
                  aria-label={cleanBankText(item.merchant)}
                  onClick={() => toggleOne(item.id)}
                  className={`m-tap flex h-5 w-5 shrink-0 items-center justify-center rounded-md border-2 ${
                    checked ? 'border-accent bg-accent text-white' : 'border-line bg-surface'
                  }`}
                >
                  {checked && <Icon name="check" size={12} />}
                </button>
                <div className="min-w-0 flex-1" data-testid={`review-bulk-open-${item.id}`}>
                  <TxRow tx={item} showDate onClick={() => setDetailId(item.id)} />
                </div>
              </div>
            );
          })}
        </div>
      </Sheet>

      {/* compact read-only peek — deliberately smaller than the list sheet */}
      <Sheet
        open={detailId !== null}
        onOpenChange={(next) => !next && setDetailId(null)}
        title={detail ? cleanBankText(detail.merchant) : ''}
        size="form"
      >
        {detail && (
          <div className="flex flex-col gap-2 pt-1" data-testid="review-bulk-detail">
            <div className="m-num text-center text-[26px] text-ink">
              {fmtCents(detail.amountCents, detail.currency, lang, { sign: true })}
            </div>
            <p className="text-center text-[12px] text-ink-4">
              {new Date(detail.date).toLocaleDateString(LOCALES[lang], { weekday: 'long', day: 'numeric', month: 'long', year: 'numeric' })}
            </p>
            {detail.description && (
              <p className="rounded-xl bg-bg-2 px-3 py-2.5 font-mono text-[11px] break-words text-ink-3">
                {cleanBankText(detail.description)}
              </p>
            )}
            {detail.counterIban && (
              <p className="text-center font-mono text-[11px] text-ink-4">{detail.counterIban}</p>
            )}
          </div>
        )}
      </Sheet>
    </div>
  );
}

/**
 * Review queue, rebuilt around the legacy mechanics with a calmer face:
 * one card at a time, the prediction pre-applied WITH its reason, bulk
 * confirm for similar transactions (same merchant; same amount too once
 * split), type/counter-account and splits via the shared sheets, a
 * recurring-cost link offer, and a skip pile at the end.
 */
export function ReviewScreen() {
  const { t, lang } = useLang();
  const { db, spaceId } = useData();
  const cats = useCategories();
  const allTxs = useSpaceTransactions();
  const transform = useTxTransform();
  const recurrings = useRecurrings();
  const recurringOps = useRecurringOps();

  const [pickerOpen, setPickerOpen] = useState(false);
  const [typeOpen, setTypeOpen] = useState(false);
  const [splitOpen, setSplitOpen] = useState(false);
  const [skipped, setSkipped] = useState<ReadonlySet<string>>(new Set());
  // the card's STAGED decision (review redesign): user edits live here,
  // only Confirm writes; null = untouched, follow tx + prediction live
  const [stagedDraft, setStagedDraft] = useState<ReviewDraft | null>(null);
  const [descExpanded, setDescExpanded] = useState(false);
  const [bulkSelected, setBulkSelected] = useState<ReadonlySet<string>>(new Set());
  const [linkRecurring, setLinkRecurring] = useState(true);
  const [initialCount, setInitialCount] = useState<number | null>(null);

  // teaching data: what this space (or the user's personal spaces) confirmed before
  const memory = useLiveQuery(() => buildSpaceMerchantMemory(db, spaceId), [db, spaceId]);

  const queue = useMemo(
    () => allTxs?.filter((item) => item.needsReview === 1).sort((a, b) => b.date.localeCompare(a.date)),
    [allTxs],
  );
  useEffect(() => {
    if (queue && initialCount === null) setInitialCount(queue.length || 1);
  }, [queue, initialCount]);

  const remaining = useMemo(() => queue?.filter((item) => !skipped.has(item.id)), [queue, skipped]);
  const tx = remaining?.[0];

  const prediction = useMemo(
    () => (tx && memory ? predictTx({ memory, merchant: tx.merchant, description: tx.description, amountCents: tx.amountCents }) : null),
    [tx, memory],
  );

  // counterparty IBAN belonging to one of MY OWN accounts = money moving
  // between my accounts — a transfer by definition, pre-applied (user
  // report: credit-card top-ups showed up as expense + income pairs)
  const ownCounter = useLiveQuery(() => {
    const iban = tx?.counterIban ? normalizeIban(tx.counterIban) : undefined;
    return iban
      ? db.accounts.filter((a) => a.deleted === 0 && !!a.iban && normalizeIban(a.iban) === iban).first()
      : undefined;
  }, [tx?.counterIban, db]);

  // untouched cards follow the tx + the (async) prediction live
  const baseDraft = tx ? initDraft(tx, prediction?.catId, cats) : null;
  const ownTransferDraft = useMemo(
    () => applyOwnCounterDefault(baseDraft, ownCounter, cats),
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [tx?.id, ownCounter, prediction?.catId, cats],
  );
  const draft = stagedDraft ?? ownTransferDraft;
  const cat = cats.byId(draft?.catId);
  const parentColor = cat.parentId ? cats.byId(cat.parentId).color : cat.color;

  const recMatch = useMemo(
    () =>
      tx
        ? recurrings?.find(
            (r) =>
              r.active === 1 &&
              !!r.merchantKey &&
              r.merchantKey === merchantKey(tx.merchant) &&
              recurringAmountMatches(r, tx.amountCents),
          )
        : undefined,
    [tx, recurrings],
  );

  // SP5: an incoming amount that exactly matches an open split settlement
  // to me is very likely that person paying me back — suggest transfer
  const identity = useSession((s) => s.identity);
  const [settlements, setSettlements] = useState<SettlementCandidate[]>([]);
  useEffect(() => {
    if (identity?.kind !== 'user') return;
    void fetchSettlementCandidates().then(setSettlements);
  }, [identity]);
  const settleMatch = useMemo(
    () => (tx && tx.amountCents > 0 ? settlements.find((c) => c.cents === tx.amountCents) : undefined),
    [tx, settlements],
  );

  // bulk rule: plain confirm reaches every same-merchant item; absolute
  // splits only fit exact twins (same amount), percentage splits scale
  // to any amount so the whole merchant group stays eligible
  const draftSplits = draft?.splits;
  const similar = useMemo(() => {
    if (!tx || !queue) return [] as SpaceTx[];
    const key = merchantKey(tx.merchant);
    const mustMatchAmount = !!draftSplits?.length && !splitsArePct(draftSplits);
    return queue.filter(
      (item) =>
        item.id !== tx.id &&
        merchantKey(item.merchant) === key &&
        (!mustMatchAmount || item.amountCents === tx.amountCents),
    );
  }, [tx, queue, draftSplits]);

  // fresh card: reset the staged draft and offer the link
  useEffect(() => {
    setStagedDraft(null);
    setLinkRecurring(true);
    setDescExpanded(false);
  }, [tx?.id]);
  // select every similar item by default — re-selecting when the list
  // itself changes (a sync can add one mid-card) keeps the visible count
  // honest about what confirm will actually touch
  useEffect(() => {
    setBulkSelected(new Set(similar.map((s) => s.id)));
  }, [similar]);

  const draftTypeLabel = draft ? t(`tx.type.${draft.txType}`) : null;
  const showReason = !!tx && !stagedDraft && prediction?.catId === draft?.catId;
  const reasonLine =
    showReason && prediction ? t(REASON_KEYS[prediction.source], { n: prediction.evidence ?? 1 }) : null;

  const confirm = async () => {
    if (!tx || !draft || !draftReady(draft)) return;
    await writeConfirmation({
      tx,
      draft,
      recurringId: recMatch && linkRecurring ? recMatch.id : undefined,
      bulk: similar.filter((s) => bulkSelected.has(s.id)),
      transform,
    });
    // other billing cycles of a linked recurring pick up their link here
    void recurringOps.reconcile().catch(() => undefined);
    hapticNotify('SUCCESS'); // §5: a physical tick on the native shells
  };

  const { progress, sub } = progressState(initialCount, queue?.length, skipped.size);

  const emptyBecauseSkipped = queue && queue.length > 0 && remaining?.length === 0;

  // desktop affordances (D5): Enter confirms, ←/→ skips to the next card —
  // never while a sheet is open or the focus sits in an input
  useEffect(() => {
    if (!tx) return;
    const onKey = (e: KeyboardEvent) => {
      if (document.querySelector('[role="dialog"]')) return;
      const el = e.target as HTMLElement | null;
      if (el && (el.tagName === 'INPUT' || el.tagName === 'TEXTAREA' || el.tagName === 'SELECT')) return;
      if (e.key === 'Enter') {
        e.preventDefault();
        void confirm();
      } else if (e.key === 'ArrowRight' || e.key === 'ArrowLeft') {
        e.preventDefault();
        setSkipped((prev) => new Set([...prev, tx.id]));
      }
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  });

  return (
    <div className="m-fade flex h-full flex-col" data-testid="screen-review">
      <AppBar
        title={t('review.title')}
        sub={sub}
        leading={
          <IconButton label={t('action.back')} testId="review-back" onClick={() => window.history.back()}>
            <Icon name="chevron-left" size={24} />
          </IconButton>
        }
        trailing={<HelpButton tourId="review" />}
      />
      {/* quiet progress line under the bar */}
      <div className="h-0.5 shrink-0 bg-bg-2">
        <div className="h-full bg-accent transition-[width]" style={{ width: `${progress * 100}%` }} />
      </div>

      <div className="flex min-h-0 flex-1 flex-col overflow-y-auto px-5 pb-6">
        {/* the first-time nudge must come BEFORE the user works the deck,
            not after it (user bug report) — it's one dismissible line and
            never returns once seen */}
        <IntroCard tourId="review" />
        {!tx && queue && !emptyBecauseSkipped && (
          <div className="flex flex-1 flex-col items-center justify-center gap-2 text-center" data-testid="review-empty">
            <Icon name="check-circle-outline" size={48} color="var(--m-accent)" />
            <div className="m-h3 text-ink">{t('review.noTxs')}</div>
            <p className="max-w-[260px] text-sm text-ink-3">{t('review.noTxsSub')}</p>
          </div>
        )}
        {emptyBecauseSkipped && (
          <div className="flex flex-1 flex-col items-center justify-center gap-3 text-center" data-testid="review-skipped-note">
            <Icon name="debug-step-over" size={40} color="var(--m-warning)" />
            <p className="max-w-[260px] text-sm text-ink-2">{t('review.skippedRemain', { n: skipped.size })}</p>
            <Button variant="outline" data-testid="review-reset-skipped" onClick={() => setSkipped(new Set())}>
              {t('review.reviewSkipped')}
            </Button>
          </div>
        )}
        {tx && (
          /* D3 focus layout: at lg the deck becomes a fixed 520px column,
             centered both ways (user: left-anchored read as broken); the
             pickers slide in as dimmed right-hand panels, so the card
             stays visible while editing. Skip/Confirm attach under the
             card instead of the far bottom. */
          <div className="flex min-h-0 flex-1 flex-col lg:mx-auto lg:my-auto lg:w-[520px] lg:flex-none lg:pb-10">
            <div className="mt-4 rounded-card border border-line bg-surface px-6 py-7 text-center" data-testid="review-card">
              <div className="text-[12px] text-ink-4">
                {new Intl.DateTimeFormat(LOCALES[lang], { weekday: 'long', day: 'numeric', month: 'long' }).format(new Date(tx.date))}
              </div>
              <div className="m-h2 mt-1.5 text-ink">{cleanBankText(tx.merchant)}</div>
              <div className="m-num mt-1 text-[32px] text-ink">{fmtCents(tx.amountCents, tx.currency, lang, { sign: true })}</div>
              {tx.description && (
                // tap to read everything — bank descriptions often carry the
                // detail that identifies a charge (user request). The clamp
                // sits on an INNER span: line-clamp needs display:-webkit-box
                // and any display on the same element (block/flex) kills it.
                <button
                  data-testid="review-description"
                  aria-expanded={descExpanded}
                  onClick={() => setDescExpanded((v) => !v)}
                  className="m-tap mx-auto mt-2 block max-w-[280px] border-none bg-transparent text-center font-mono text-[11px] text-ink-4"
                >
                  <span data-testid="review-description-text" className={descExpanded ? '' : 'line-clamp-2'}>
                    {cleanBankText(tx.description)}
                  </span>
                </button>
              )}

              {/* ONE category editor (user redesign): the list starts with a
                  single category and grows via "+ add" — the old separate
                  Split button and the triple display (chip + split rows +
                  confirm label) are gone. A single row edits through the
                  quick picker; any row of a multi-split opens the editor. */}
              <div className="mx-auto mt-5 w-full max-w-[300px]" data-testid="review-cats">
                {(draft?.splits?.length ? draft.splits : [null]).map((slice) => {
                  const sliceCat = slice ? cats.byId(slice.catId) : cat;
                  const sliceColor = slice
                    ? (sliceCat.color ?? cats.byId(sliceCat.parentId ?? '').color)
                    : parentColor;
                  return (
                    <button
                      key={slice?.catId ?? 'single'}
                      data-testid={slice ? `review-cat-${slice.catId}` : 'review-category-chip'}
                      onClick={() => (slice ? setSplitOpen(true) : setPickerOpen(true))}
                      className="m-tap flex w-full items-center gap-2 border-none bg-transparent px-2 py-1.5 text-left text-[14px] font-medium text-ink"
                    >
                      <Icon name={sliceCat.icon} size={18} color={sliceColor ?? 'var(--m-ink-3)'} />
                      <span className="min-w-0 flex-1 truncate">
                        {slice || draft?.catId ? catName(sliceCat, t) : t('review.pickPrompt')}
                      </span>
                      {slice && <span className="m-num text-[13px] text-ink-2">{fmtCents(slice.amountCents, tx.currency, lang)}</span>}
                      <Icon name="pencil-outline" size={14} color="var(--m-ink-4)" />
                    </button>
                  );
                })}
                <button
                  data-testid="review-cat-add"
                  onClick={() => setSplitOpen(true)}
                  className="m-tap flex w-full items-center gap-2 border-none bg-transparent px-2 py-1.5 text-left text-[12px] font-medium text-accent-deep"
                >
                  <Icon name="plus-circle-outline" size={16} />
                  {t('review.addCategory')}
                </button>
              </div>
              {reasonLine && (
                <div className="mt-1 flex items-center justify-center gap-1 text-[11px] text-ink-4" data-testid="review-reason">
                  <Icon name={prediction?.source === 'keyword' ? 'lightbulb-outline' : 'history'} size={12} />
                  {reasonLine}
                </div>
              )}

              {recMatch && (
                <>
                  <Chip
                    className="mt-3"
                    testId="review-link-recurring"
                    selected={linkRecurring}
                    onClick={() => setLinkRecurring((v) => !v)}
                  >
                    <Icon name={linkRecurring ? 'check' : 'autorenew'} size={13} />
                    {t('review.linkRecurring', { name: recMatch.name })}
                  </Chip>
                  {/* subscription intelligence S3: this charge differs from
                      what the subscription usually costs — say so quietly */}
                  {Math.abs(Math.abs(tx.amountCents) - recMatch.amountCents) >= 50 && (
                    <div className="mt-1.5 flex items-center justify-center gap-1 text-[11px] text-warning" data-testid="review-rec-delta">
                      <Icon name={Math.abs(tx.amountCents) > recMatch.amountCents ? 'trending-up' : 'trending-down'} size={12} />
                      {t(Math.abs(tx.amountCents) > recMatch.amountCents ? 'review.recDeltaMore' : 'review.recDeltaLess', {
                        amount: fmtCents(Math.abs(Math.abs(tx.amountCents) - recMatch.amountCents), tx.currency, lang),
                      })}
                    </div>
                  )}
                </>
              )}

              {/* money between my own accounts: pre-marked as a transfer,
                  one tap opts back out */}
              {ownCounter && draft && draft.linkedAccountId === ownCounter.id && (
                <Chip
                  className="mt-3"
                  testId="review-own-transfer"
                  selected
                  onClick={() => setStagedDraft(withLinkedAccount(draft, null, cats))}
                >
                  <Icon name="swap-horizontal" size={13} />
                  {t('review.ownTransfer', { name: ownCounter.name })}
                </Chip>
              )}

              {/* SP5: incoming money matching an open split settlement to me */}
              {settleMatch && draft && (
                <Chip
                  className="mt-3"
                  testId="review-settle-match"
                  selected={draft.txType === 'transfer'}
                  onClick={() => setStagedDraft(stageAsTransfer(draft, cats))}
                >
                  <Icon name="handshake-outline" size={13} />
                  {t('review.settleMatch', {
                    name: settleMatch.fromName ?? t('review.settleSomeone'),
                    split: settleMatch.splitName,
                  })}
                </Chip>
              )}

              {/* quiet secondary action (split moved into the list above) */}
              <div className="mt-5 flex items-center justify-center text-[12px] font-medium text-ink-3">
                <button data-testid="review-act-type" onClick={() => setTypeOpen(true)} className="m-tap border-none bg-transparent">
                  {/* the staged type is part of the decision — show it */}
                  {t('tx.type')}
                  {draftTypeLabel ? ` · ${draftTypeLabel}` : ''}
                </button>
              </div>
            </div>

            <BulkConfirmSection key={tx.id} similar={similar} selected={bulkSelected} onChange={setBulkSelected} />

            {/* mobile: pinned to the thumb at the bottom; lg: attached to the card */}
            <div className="mt-auto flex gap-3 pt-4 lg:mt-0">
              <Button
                variant="outline"
                className="w-28"
                data-testid="review-skip-btn"
                onClick={() => setSkipped((prev) => new Set([...prev, tx.id]))}
              >
                {t('review.skip')}
              </Button>
              <Button
                variant="primary"
                className="min-w-0 flex-1"
                data-testid="review-confirm-btn"
                disabled={!draft || !draftReady(draft)}
                onClick={() => void confirm()}
              >
                <span className="truncate">
                  {/* multi-category: the list above already says it all */}
                  {draft?.catId && !draft.splits?.length ? t('review.confirmAs', { name: catName(cat, t) }) : t('review.confirm')}
                </span>
              </Button>
            </div>
          </div>
        )}
      </div>

      <CategoryPicker
        open={pickerOpen}
        onOpenChange={setPickerOpen}
        selectedId={draft?.catId}
        onPick={(catId) => {
          if (draft) setStagedDraft(withCategory(draft, catId, cats));
          setPickerOpen(false);
        }}
        direction={tx && directionOfTx(tx)}
        txType={draft?.txType}
      />
      {tx && draft && (
        <TxTypeSheet
          open={typeOpen}
          onOpenChange={setTypeOpen}
          tx={tx}
          value={{ txType: draft.txType, linkedAccountId: draft.linkedAccountId }}
          onPickType={(nextType) => setStagedDraft(withType(draft, nextType, cats))}
          onPickLinked={(account) => setStagedDraft(withLinkedAccount(draft, account, cats))}
        />
      )}
      {tx && draft && (
        <SplitEditorSheet
          open={splitOpen}
          onOpenChange={setSplitOpen}
          tx={tx}
          // empty value: the editor itself seeds "current category owns the
          // full amount + one fresh row" — exactly the add-category start
          value={draft.splits}
          txType={draft.txType}
          onApply={(splits) => setStagedDraft(withSplits(draft, splits ?? undefined))}
        />
      )}
    </div>
  );
}
