import { useMemo, useState } from 'react';
import type { ReactNode } from 'react';
import { LOCALES, useLang } from '@/i18n';
import { partyName } from '@/features/connectors/logos';
import type { ReceiptLinkRow, ReceiptRow } from '@/db/types';
import { fmtCents } from '@/lib/money';
import { Button } from '@/ui/Button';
import { Icon } from '@/ui/Icon';
import { Chip } from '@/ui/primitives';
import { SearchField } from '@/ui/SearchField';
import { Sheet } from '@/ui/Sheet';
import { filterReceipts, receiptParties } from './receiptPick';

/**
 * The receipt picker (user 2026-10-06 for the review card, user 2026-10-07
 * everywhere a receipt is searched): the proposal's yes / no, the None
 * option, the suggestions, the screen's own rungs, and every receipt
 * behind a search and the parties' chips. The sheet only names what is
 * selected and reports taps — the review stages a pick for its confirm,
 * the detail links or swaps at once.
 */
export interface ReceiptPickSheetProps {
  open: boolean;
  onOpenChange: (next: boolean) => void;
  title: string;
  /** every testid in the sheet hangs off this: the review keeps `review-receipt`, the detail uses `receipt-pick` */
  testIdPrefix: string;
  /** the suggestion rows' own prefix when it is not `<testIdPrefix>-pick` (the detail's rows stay `receipt-pick-<id>`) */
  pickTestIdPrefix?: string;
  proposal?: ReceiptLinkRow;
  candidates: readonly ReceiptRow[];
  all: readonly ReceiptRow[];
  /** the receipt wearing the check: the attached one on the detail, the staged one on the review card */
  selectedId: string | null;
  /** the None option wears the check instead (the review card staged "no receipt") */
  noneSelected?: boolean;
  /** the None option is on offer at all (the detail hides it until a receipt is attached) */
  showNone?: boolean;
  currency: string;
  /** user 2026-10-08: the OTHER transactions a receipt is attached to, by receipt id — the row says so and stays
   *  pickable (several payments, one receipt) */
  attachedTo?: ReadonlyMap<string, readonly string[]>;
  /** names a transaction for that note ("29 May · bol.com · €157.33"); unnamed = the count alone */
  describeTx?: (txId: string) => string | undefined;
  onAccept: (link: ReceiptLinkRow) => void;
  onReject: (link: ReceiptLinkRow) => void;
  onPick: (row: ReceiptRow | null) => void;
  onView: (receiptId: string) => void;
  /** the screen's own rungs (the detail's capture, upload and connections doors), between the suggestions and the search */
  children?: ReactNode;
}

type Lang = ReturnType<typeof useLang>['lang'];

/** a receipt's day as the picker shows it — with the year, since the whole history is listed */
const fmtReceiptDay = (iso: string, lang: Lang): string =>
  new Date(iso).toLocaleDateString(LOCALES[lang], { day: 'numeric', month: 'short', year: 'numeric' });

const sourceIcon = (receipt: Pick<ReceiptRow, 'source'>): string => (receipt.source === 'photo' ? 'camera-outline' : 'storefront-outline');

/** the proposal's ask (#367 §5.7) — the detail's own card and the sheet's head are the same block */
export function ReceiptProposalCard({
  link,
  currency,
  ids,
  onAccept,
  onReject,
  className = '',
}: Readonly<{
  link: ReceiptLinkRow;
  currency: string;
  ids: { card: string; accept: string; reject: string };
  onAccept: (link: ReceiptLinkRow) => void;
  onReject: (link: ReceiptLinkRow) => void;
  className?: string;
}>) {
  const { t, lang } = useLang();
  return (
    <div className={`rounded-card border border-line bg-surface px-4 py-3 ${className}`} data-testid={ids.card}>
      <div className="flex items-center gap-3">
        <Icon name="storefront-outline" size={18} color="var(--m-accent-deep)" />
        <span className="min-w-0 flex-1">
          <span className="block truncate text-[13px] font-medium text-ink">{link.merchant ?? partyName(link.source)}</span>
          <span className="block text-[11px] text-ink-4">
            {t('receipts.proposedBadge')} · {fmtReceiptDay(link.date, lang)}
          </span>
        </span>
        <span className="m-num text-[13px] font-semibold text-ink">{fmtCents(link.totalCents, currency, lang)}</span>
      </div>
      <div className="mt-2 flex gap-2 pl-8">
        <Button size="sm" data-testid={ids.accept} onClick={() => onAccept(link)}>
          {t('receipts.accept')}
        </Button>
        <Button size="sm" variant="outline" data-testid={ids.reject} onClick={() => onReject(link)}>
          {t('receipts.reject')}
        </Button>
      </div>
    </div>
  );
}

/** one receipt in a list: the tap picks it, the eye opens it; a note says where it is attached already */
function ReceiptPickRow({
  receipt,
  selected,
  currency,
  note,
  pickTestId,
  viewTestId,
  onPick,
  onView,
}: Readonly<{
  receipt: ReceiptRow;
  selected: boolean;
  currency: string;
  /** "Attached to …" (user 2026-10-08) — the receipt proves another transaction already */
  note?: string;
  pickTestId: string;
  viewTestId: string;
  onPick: () => void;
  onView: () => void;
}>) {
  const { t, lang } = useLang();
  const items = receipt.items?.length ? ` · ${receipt.items.length} ${t('receipt.items')}` : '';
  return (
    <div className="flex items-center border-b border-line-2 last:border-0">
      <button
        data-testid={pickTestId}
        aria-pressed={selected}
        onClick={onPick}
        className="m-tap flex min-w-0 flex-1 items-center gap-3 border-none bg-transparent px-4 py-3 text-left"
      >
        <Icon name={selected ? 'check-circle' : sourceIcon(receipt)} size={16} color={selected ? 'var(--m-accent)' : 'var(--m-ink-3)'} />
        <span className="min-w-0 flex-1">
          <span className="block truncate text-[13px] font-medium text-ink">{receipt.merchant ?? partyName(receipt.source)}</span>
          <span className="block text-[11px] text-ink-4">{`${fmtReceiptDay(receipt.date, lang)}${items}`}</span>
          {note && (
            <span className="mt-0.5 flex items-center gap-1 text-[11px] text-warning" data-testid={`${pickTestId}-attached`}>
              <Icon name="link-variant" size={11} />
              <span className="min-w-0 truncate">{note}</span>
            </span>
          )}
        </span>
        <span className="m-num text-[13px] font-semibold text-ink">{fmtCents(receipt.totalCents, currency, lang)}</span>
      </button>
      <button
        data-testid={viewTestId}
        aria-label={t('review.receiptView')}
        onClick={onView}
        className="m-tap flex h-10 w-10 shrink-0 items-center justify-center border-none bg-transparent"
      >
        <Icon name="eye-outline" size={16} color="var(--m-ink-4)" />
      </button>
    </div>
  );
}

/** the None option: no receipt for this transaction (the detail: let the attached one go) */
function ReceiptNoneOption({ testId, selected, onPick }: Readonly<{ testId: string; selected: boolean; onPick: () => void }>) {
  const { t } = useLang();
  return (
    <button
      data-testid={testId}
      aria-pressed={selected}
      onClick={onPick}
      className="m-tap flex w-full items-center gap-3 rounded-card border border-dashed border-line bg-transparent px-4 py-2.5 text-left text-[13px] text-ink-2"
    >
      <Icon name={selected ? 'check-circle' : 'close-circle-outline'} size={16} color={selected ? 'var(--m-accent)' : 'var(--m-ink-4)'} />
      {t('review.receiptNoneOption')}
    </button>
  );
}

export function ReceiptPickSheet({
  open,
  onOpenChange,
  title,
  testIdPrefix,
  pickTestIdPrefix,
  proposal,
  candidates,
  all,
  selectedId,
  noneSelected = false,
  showNone = true,
  currency,
  attachedTo,
  describeTx,
  onAccept,
  onReject,
  onPick,
  onView,
  children,
}: Readonly<ReceiptPickSheetProps>) {
  const { t } = useLang();
  const [query, setQuery] = useState('');
  const [party, setParty] = useState<string | null>(null);
  const parties = useMemo(() => receiptParties(all), [all]);
  const listed = useMemo(() => filterReceipts(all, query, party).slice(0, 100), [all, query, party]);
  const id = (suffix: string): string => `${testIdPrefix}-${suffix}`;
  const pickPrefix = pickTestIdPrefix ?? id('pick');
  /** "Attached to 29 May · bol.com · €157.33" for one named transaction, the count otherwise (user 2026-10-08) */
  const attachedNote = (receiptId: string): string | undefined => {
    const others = attachedTo?.get(receiptId);
    if (!others?.length) return undefined;
    const face = others.length === 1 ? describeTx?.(others[0]) : undefined;
    return face ? t('receipt.attachedTo', { tx: face }) : t('receipt.attachedToN', { n: others.length });
  };
  // a receipt sits in the suggestions AND the full list: each list's rows and eyes carry their own prefix
  const rows = (list: readonly ReceiptRow[], rowPrefix: string, viewPrefix: string) =>
    list.map((r) => (
      <ReceiptPickRow
        key={r.id}
        receipt={r}
        selected={selectedId === r.id}
        currency={currency}
        note={attachedNote(r.id)}
        pickTestId={`${rowPrefix}-${r.id}`}
        viewTestId={`${viewPrefix}-${r.id}`}
        onPick={() => onPick(r)}
        onView={() => onView(r.id)}
      />
    ));
  return (
    <Sheet open={open} onOpenChange={onOpenChange} title={title} size="full">
      <div className="flex flex-col gap-3 pt-1" data-testid={id('sheet')}>
        {proposal && (
          <ReceiptProposalCard
            link={proposal}
            currency={currency}
            ids={{ card: id('proposal'), accept: id('accept'), reject: id('reject') }}
            onAccept={onAccept}
            onReject={onReject}
          />
        )}
        {showNone && <ReceiptNoneOption testId={id('none')} selected={noneSelected} onPick={() => onPick(null)} />}
        {candidates.length > 0 && (
          <>
            <div className="m-cap px-1">{proposal ? t('review.receiptPick') : t('receipt.suggested')}</div>
            <div className="overflow-hidden rounded-card border border-line bg-surface" data-testid={`${pickPrefix}-list`}>
              {rows(candidates, pickPrefix, id('view'))}
            </div>
          </>
        )}
        {children}
        {/* nothing fetched yet (a photo-only person): no search over an empty list */}
        {all.length > 0 && (
          <>
            <div className="m-cap px-1">
              {t('review.receiptAll')} · {listed.length}
            </div>
            <SearchField testId={id('search')} value={query} onChange={setQuery} placeholder={t('review.receiptSearch')} />
            {parties.length > 1 && (
              <div className="flex flex-wrap gap-2" data-testid={id('parties')}>
                <Chip testId={id('party-all')} selected={party === null} onClick={() => setParty(null)}>
                  {t('review.receiptEvery')}
                </Chip>
                {parties.map((p) => (
                  <Chip key={p.source} testId={id(`party-${p.source}`)} selected={party === p.source} onClick={() => setParty((v) => (v === p.source ? null : p.source))}>
                    {p.label}
                  </Chip>
                ))}
              </div>
            )}
            {listed.length > 0 ? (
              <div className="overflow-hidden rounded-card border border-line bg-surface" data-testid={id('all-list')}>
                {rows(listed, id('all'), id('all-view'))}
              </div>
            ) : (
              <p className="px-1 py-4 text-center text-[12px] text-ink-4" data-testid={id('all-empty')}>
                {t('review.receiptNoneFound')}
              </p>
            )}
          </>
        )}
      </div>
    </Sheet>
  );
}
