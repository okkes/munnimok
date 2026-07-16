import { useEffect, useMemo, useState } from 'react';
import { useLiveQuery } from 'dexie-react-hooks';
import { useSpaceTransactions, useTxTransform } from '@/application/transactions';
import type { SpaceTx } from '@/application/transactions';
import { buildSpaceMerchantMemory } from '@/application/prediction';
import { useRecurringOps, useRecurrings } from '@/application/recurring';
import { directionOfTx } from '@/domain/categoryRules';
import { merchantKey } from '@/domain/merchantKey';
import { draftReady, initDraft, withCategory, withLinkedAccount, withSplits, withType } from '@/domain/reviewDraft';
import { fetchSettlementCandidates } from '@/features/splits/settlementCandidates';
import type { SettlementCandidate } from '@/features/splits/settlementCandidates';
import { useSession } from '@/app/session';
import type { ReviewDraft } from '@/domain/reviewDraft';
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

      <Sheet open={open} onOpenChange={setOpen} title={t('review.alsoApply', { n: selected.size })} size="tall">
        {/* fixed px so the list scrolls INSIDE the sheet (sheet rules) */}
        <div className="max-h-[420px] overflow-y-auto overscroll-contain" data-testid="review-bulk-list">
          {similar.map((item) => {
            const checked = selected.has(item.id);
            const expanded = detailId === item.id;
            return (
              <div key={item.id} className="border-b border-line-2 last:border-0">
                <div className="flex items-center gap-3 py-2.5">
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
                  {/* tapping the row body opens the read-only detail */}
                  <button
                    data-testid={`review-bulk-open-${item.id}`}
                    onClick={() => setDetailId(expanded ? null : item.id)}
                    className="m-tap flex min-w-0 flex-1 items-center gap-3 border-none bg-transparent text-left"
                  >
                    <span className="min-w-0 flex-1">
                      {/* the merchant leads: normalization groups charges whose
                          raw titles differ (dates, branch cities), so the list
                          must say which is which (user request) */}
                      <span className="block truncate text-[13px] text-ink-2">{cleanBankText(item.merchant)}</span>
                      <span className="block truncate text-[11px] text-ink-4">
                        {new Date(item.date).toLocaleDateString(LOCALES[lang], { day: 'numeric', month: 'short', year: 'numeric' })}
                      </span>
                    </span>
                    <span className="m-num shrink-0 text-[13px] text-ink-2">{fmtCents(item.amountCents, item.currency, lang)}</span>
                    <Icon name={expanded ? 'chevron-up' : 'chevron-down'} size={15} color="var(--m-ink-4)" />
                  </button>
                </div>
                {expanded && (
                  <div className="mb-2.5 rounded-xl bg-bg-2 px-3 py-2.5" data-testid={`review-bulk-detail-${item.id}`}>
                    {item.description && (
                      <p className="font-mono text-[11px] break-words text-ink-3">{cleanBankText(item.description)}</p>
                    )}
                    <p className="mt-1 text-[11px] text-ink-4">
                      {item.date} · {fmtCents(item.amountCents, item.currency, lang, { sign: true })}
                    </p>
                  </div>
                )}
              </div>
            );
          })}
        </div>
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

  // untouched cards follow the tx + the (async) prediction live
  const draft = stagedDraft ?? (tx ? initDraft(tx, prediction?.catId, cats) : null);
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

              <button
                data-testid="review-category-chip"
                onClick={() => setPickerOpen(true)}
                className="m-tap mt-5 inline-flex items-center gap-2 rounded-full border border-line bg-bg px-4 py-2 text-[14px] font-medium text-ink"
              >
                <Icon name={cat.icon} size={18} color={parentColor ?? 'var(--m-ink-3)'} />
                {draft?.catId ? catName(cat, t) : t('review.pickPrompt')}
                <Icon name="pencil-outline" size={14} color="var(--m-ink-4)" />
              </button>
              {reasonLine && (
                <div className="mt-2 flex items-center justify-center gap-1 text-[11px] text-ink-4" data-testid="review-reason">
                  <Icon name={prediction?.source === 'keyword' ? 'lightbulb-outline' : 'history'} size={12} />
                  {reasonLine}
                </div>
              )}

              {!!draft?.splits?.length && (
                <div className="mx-auto mt-3 max-w-[280px] text-left" data-testid="review-splits">
                  {draft.splits.map((s) => {
                    const sc = cats.byId(s.catId);
                    return (
                      <div key={s.catId} className="flex items-center gap-2 py-0.5 text-[12px] text-ink-2">
                        <Icon name={sc.icon} size={13} color={sc.color ?? cats.byId(sc.parentId ?? '').color} />
                        <span className="flex-1 truncate">{catName(sc, t)}</span>
                        <span className="m-num">{fmtCents(s.amountCents, tx.currency, lang)}</span>
                      </div>
                    );
                  })}
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

              {/* SP5: incoming money matching an open split settlement to me */}
              {settleMatch && draft && (
                <Chip
                  className="mt-3"
                  testId="review-settle-match"
                  selected={draft.txType === 'transfer'}
                  onClick={() => {
                    // transfers carry no spending category; the hidden
                    // 'uncategorized' builtin keeps the confirm armed
                    const next = withType(draft, 'transfer', cats);
                    setStagedDraft(next.catId ? next : withCategory(next, 'uncategorized', cats));
                  }}
                >
                  <Icon name="handshake-outline" size={13} />
                  {t('review.settleMatch', {
                    name: settleMatch.fromName ?? t('review.settleSomeone'),
                    split: settleMatch.splitName,
                  })}
                </Chip>
              )}

              {/* quiet secondary actions */}
              <div className="mt-5 flex items-center justify-center gap-5 text-[12px] font-medium text-ink-3">
                <button data-testid="review-act-split" onClick={() => setSplitOpen(true)} className="m-tap border-none bg-transparent">
                  {t('split.action')}
                </button>
                <span className="text-line">·</span>
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
                  {draft?.catId ? t('review.confirmAs', { name: catName(cat, t) }) : t('review.confirm')}
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
          value={draft.splits}
          txType={draft.txType}
          onApply={(splits) => setStagedDraft(withSplits(draft, splits ?? undefined))}
        />
      )}
    </div>
  );
}
